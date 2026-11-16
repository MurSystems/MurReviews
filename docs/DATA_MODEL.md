# Data model, RLS, and queue functions

Stage 1 output. Schema lives in `supabase/migrations/20261116000000_init.sql`.

## Tenancy model

One Postgres database, one deployment, many clients. Every tenant table carries
a `business_id` and is locked down by row-level security. The current user is
`auth.uid()`; an owner is any user whose `businesses.owner_id` matches, and an
admin is any user with `profiles.role = 'admin'`.

Two security-definer helpers centralise the checks (they run as the function
owner, so they can read `profiles`/`businesses` without tripping the RLS
policies that call them — no recursion):

- `public.is_admin()` → is `auth.uid()` an admin?
- `public.can_access_business(bid)` → admin, or `bid` is owned by `auth.uid()`.

## Tables

| table | purpose | RLS for owner (`authenticated`) |
|---|---|---|
| `profiles` | auth user → role (`owner`/`admin`) | select own; no writes (no self-promote) |
| `businesses` | one row per client | select own; **update only** `delay_minutes` + `message_template` (column grants) |
| `gateway_credentials` | per-business sender secrets | **none** (service-role only) |
| `customers` | one per `(business_id, mobile)` | select + insert own; no update/delete |
| `opt_outs` | opt-out source of truth, PK `(business_id, mobile)`, never expires | select + insert own; **no update/delete** |
| `opt_out_links` | stable opt-out token → `(business_id, mobile)`, never expires | **none** (service-role only) |
| `messages` | outbound queue, one row per text (initial or reminder) | select own only; writes via RPC + Worker |
| `click_events` | every `/r/{token}` hit | select own only |
| `replies` | inbound SMS | select own only |
| `review_snapshots` | daily Places rating/count | select own only |
| `places_api_usage` | monthly Places request counter | **none** (service-role only) |
| `demo_sends` | admin demo-send log | **none** (service-role only) |

Key constraints that carry hard rules:

- `customers` unique `(business_id, mobile)` → one customer per number.
- `opt_outs` PK `(business_id, mobile)` → opt-out keyed by number, survives
  customer-row churn, never expires.
- `messages.token` unique → one short link token per outbound text.
- `messages.retryable` → `false` means never auto-resent (stale claims).
- `messages.message_text` is nullable at queue time: when a message is **sent**,
  the Worker writes the final rendered text onto the row, so there is a record
  of exactly what went out. (`LINK_DOMAIN` is a Worker env var, so full link
  rendering happens at send time, not in the DB.)

## Functions

### `add_customer(business_id, first_name, mobile)` — security definer
The single entry point the owner app calls (via RPC). In one transaction:
authorises (`can_access_business`, else `42501`), normalises the mobile with
`normalise_au_mobile`, honours opt-outs, skips numbers asked in the last 90
days, enforces the trial cap, upserts the customer and queues the message
(`scheduled_at = now() + delay_minutes`). Returns `(outcome, customer_id,
message_id)` where outcome is `queued | invalid_mobile | invalid_name |
opted_out | recent | capped`.

- `normalise_au_mobile(text)` → `+614XXXXXXXX` or `NULL` (rejects landlines —
  only `04`-prefixed mobiles survive).
- `new_token()` → 16-char hex token for `/r/{token}`.

### `claim_due_messages(batch_limit)` — service-role only
The only path out of `queued`. Single `UPDATE … WHERE id IN (SELECT … FOR
UPDATE SKIP LOCKED) … RETURNING *`, so overlapping cron runs can never claim
the same row. Skips `paused` businesses. `EXECUTE` revoked from `public`,
granted to `service_role`.

### `fail_stale_sends(stale_after)` — service-role only
Marks any `sending` message whose `updated_at` is older than `stale_after`
(default 10 minutes) as `failed` with `retryable = false` (never auto-resent).
`EXECUTE` revoked from `public`, granted to `service_role`.

### `send_allowed(mode, mobile, is_production, allowlist)` — send allowlist
Pure rule the Worker (stage 5) calls before sending: allow if `is_production`,
or the mode is `log_only`, or the mobile is in the allowlist. In non-production
every real sender refuses numbers not on the `SEND_ALLOWLIST` env var.

### `cancel_dev_messages()` — service-role only
One-time pre-go-live cleanup: marks every `queued`/`sending` message `failed`
with `retryable = false` and `last_error = 'cancelled before go-live'`, and
returns the count.

### `reset_number(business_id, mobile)` — admin only
Deletes a number's entire request history (all messages) so it can be re-added
(the 90-day rule no longer blocks it). Raises `42501` for non-admins. Never
touches `opt_outs`.

### Stage 3 (queue / quiet hours / reminder)
- `next_send_time(candidate, timezone)` — rolls a send time forward to the next
  9am if it falls outside 9am-8pm in the business's timezone (DST-aware via
  `AT TIME ZONE`).
- `queue_reminders()` — service-role only. Queues one reminder per initial text
  3 days after it was sent, if still not clicked/opted-out and the business is
  not paused or over its trial cap. Quiet hours apply to the reminder.
- `gsm7_length(text)` / `render_message_text(template, …)` — GSM-7 septet count
  (extended chars = 2) and placeholder rendering for the 160-character rule.
- `businesses.reminder_template` — the reminder's own template.
- `add_customer` now applies `next_send_time` to the queued message, and
  `send_allowed` takes the raw `PRODUCTION` env string (only exact `"true"` is
  production).

Trial cap is enforced in `add_customer` (a trial business at `trial_text_cap`
returns `capped` and queues nothing). The claim function only respects paused
status; cap enforcement lives at queue time so it cannot race a multi-row
claim batch.

## Seed safety

`supabase/seed.sql` uses only ACMA-reserved fictitious mobiles from the
`0491 570 xxx` block (006, 110, 156, 157, 158, 159, 313, 737) — numbers that
belong to no one, so an accidental send can never reach a real person. It also
contains **no `queued` messages**, so the cron has nothing to send.
`supabase/tests/seed_safety_test.sql` locks both properties in.

## Running the tests (CLI v2.109.1)

```bash
cd mur-reviews
supabase init                              # once; generates supabase/config.toml
supabase link --project-ref <ref> -p <pw>  # once; stores project ref + creds
supabase db push --linked --include-seed   # migrations + seed (no reset)
supabase test db --linked --yes            # run pgTAP against the linked DB
```

`--include-seed` applies `supabase/seed.sql` after migrations without a
destructive `db reset`. (On CLI v3 these flags become `--remote`; verify with
`supabase db push --help` for your installed version.)

Tests live in `supabase/tests/*.sql`:

- `rls_test.sql` — cross-tenant read/write isolation, service-role-only tables
  invisible, owners can't tamper with the queue or update/delete opt-outs,
  owners can edit only `delay_minutes`/`message_template`, admin sees all.
- `add_customer_test.sql` — normalisation (landline rejection), opt-out skip,
  90-day skip, trial cap, upsert+queue, cross-business authorisation.
- `queue_test.sql` — atomic claim (future + paused skipped), stale-claim sweep.
- `seed_safety_test.sql` — ACMA fictitious numbers normalise; the cron has
  nothing to send from seed-shaped data.

> If your Supabase version rejects the minimal `insert into auth.users (id,
> email)` fixture (a newer NOT NULL column), add the missing columns to the
> fixture inserts in the tests and seed.
