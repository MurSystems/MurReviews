# Mur Reviews

Multi-tenant app that helps local businesses collect more Google reviews by
texting customers a review link after a job. Product: **Mur Reviews**. Provider:
**Mur Systems**.

Owner app: <https://mur-reviews.mursystems123.workers.dev> ·
Links/sender Worker: <https://m.mursystems123.workers.dev>

The app has four owner screens (Add, Activity, Dashboard, Settings) plus an
Admin panel for Mur Systems staff. Customers never log in — they receive a
text, tap a review link, and can opt out with a tap or by replying `STOP`.

## Deployed services

| Service | Where |
| --- | --- |
| Database, auth, storage | Supabase project `MurSystems` (`pxnrcwnqoooemashbjgt`), region **Sydney** (`ap-southeast-2`) |
| Owner + admin PWA | Cloudflare Worker `mur-reviews` (static assets, SPA fallback) |
| Links, cron sender, webhook, admin routes | Cloudflare Worker `m` |
| Source | <https://github.com/MurSystems/MurReviews> (branch `main`) |

## Layout

```
frontend/     React + TypeScript + Vite PWA (owner app and admin)
worker/       Cloudflare Worker: /r, /o, /webhook, /admin, /gateway, cron senders
supabase/     migrations/ (ordered SQL), tests/ (pgTAP), seed.sql, config.toml
scripts/      DB test runner, DB helper, SMSGate setup helper
docs/         data model and architecture notes
```

## Local setup

Prerequisites: Node 20+, npm, the [Supabase CLI](https://supabase.com/docs/guides/cli),
a Cloudflare account with Wrangler, and access to the Supabase project.

```bash
git clone https://github.com/MurSystems/MurReviews.git
cd MurReviews

npm install                 # root: pg driver for the DB test runner
(cd frontend && npm install)
(cd worker && npm install)

supabase link --project-ref pxnrcwnqoooemashbjgt   # once; writes supabase/.temp/
```

Create the local environment files (never commit them):

- Root `.env` — `SUPABASE_DB_PASSWORD` (for migrations/DB tests). Add the SMS
  provider and Google Places keys only when working on those features.
- `frontend/.env` — `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- `worker/.dev.vars` — `SUPABASE_SERVICE_ROLE_KEY` and any other worker secrets
  you need locally. Copy `worker/.dev.vars.example` if present.

Run the owner app:

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>. For a phone on the same Wi-Fi, run
`npm run dev -- --host` and open `http://<PC-IP>:5173`.

Run the Worker locally (links, webhook and sender):

```bash
cd worker
npx wrangler dev
```

## Secrets and configuration (names only)

Never put a secret in a `VITE_` variable — the frontend bundle is public.

| Name | Lives in | Used by |
| --- | --- | --- |
| `SUPABASE_DB_PASSWORD` | root `.env` (local only) | migrations, DB tests, `scripts/db.cjs` |
| `SMSGATE_DEMO_BASE_URL`, `SMSGATE_DEMO_USERNAME`, `SMSGATE_DEMO_PASSWORD`, `SMSGATE_DEMO_DEVICE_ID` | root `.env` (local only) | `scripts/gateway_setup.cjs` |
| `MOBILE_MESSAGE_USERNAME`, `MOBILE_MESSAGE_PASSWORD` | root `.env` and Worker secrets | `sms_provider` sends |
| `GOOGLE_PLACES_API_KEY` | root `.env` and Worker secret | daily review snapshots (optional) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SEND_ALLOWLIST`, `LINK_DOMAIN`, `SEND_THROTTLE_MS`, `CORS_ORIGINS` | `worker/wrangler.jsonc` vars | Worker (public/non-secret config) |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret | admin routes, webhook RPCs, auth links |
| `SMSGATE_WEBHOOK_SECRET` | Worker secret (optional) | HMAC verification of inbound webhooks |
| `SENDER_LIVE` | Worker secret/var | live-send switch; only exact `true` sends |
| `PRODUCTION` | Worker secret/var | `true` disables the test allowlist |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `frontend/.env` and build env | frontend (public by design) |

Set a Worker secret without printing it:

```bash
cd worker
npx wrangler secret put NAME        # paste the value at the prompt
```

Optional names are documented in `.env.example` and `worker/.dev.vars.example`.

## Tests

```bash
npm run test:db                 # prints the target and refuses to run
npm run test:db -- --confirm    # pgTAP suite against the linked Supabase project
(cd worker && npm test)         # Vitest unit tests
(cd frontend && npm run lint)   # oxlint
(cd frontend && npm run build)  # TypeScript + production build
```

DB tests run in transactions that are always rolled back, so they never leave
data behind. They do hit the linked project — push any new migration first.

## Deploy

```bash
# 1. Database changes
supabase db push --linked

# 2. Worker (links, cron, webhook, admin, gateway)
cd worker && npx wrangler deploy

# 3. Owner app (pass --name; the Vite config's own name is "frontend")
cd frontend && npm run build && npx wrangler deploy --name mur-reviews
```

If Cloudflare auth has expired, run `cd worker && npx wrangler login --device`
(device flow avoids the localhost callback). Account ID:
`b228d54762c8a6aab17f5d26c8f84d5a`.

## Onboarding a new client

You need: the business name, its Google **Place ID**, and the owner's email.

1. **Create the business.** Sign in as an admin → **Admin → Businesses → Create
   business**. Enter the name, Place ID (use the **Find a Place ID** link),
   timezone, send mode (`android_gateway` is the default), delay and owner
   email. Creating it also creates the owner account if it does not exist and
   shows an **Owner login link**. Copy that link now — it is single-use.
   If the form was closed or the link expired, use **Admin → Audit → Generate
   owner login link** with the same email.
2. **Let the owner set a password.** Send the login link to the owner by your
   usual channel. It opens `/set-password`; they choose a password and land in
   the app.
3. **Connect their phone.** The owner installs **SMS Gateway for Android** from
   Google Play, enables **Settings → Cloud server**, signs up for the anonymous
   cloud account, and copies the username, password and device ID. They enter
   those under **Settings → Connect your phone** and press **Save connection**.
   The status turns **Connected** after the phone checks in, with a "last seen"
   time. The optional Device ID enables STOP-reply handling.
4. **Send a test text.** Still in Settings, the owner enters their own mobile
   and presses **Send test text**. While `PRODUCTION` is not `true`, only
   numbers on `SEND_ALLOWLIST` are allowed. Confirm the text arrives, tap the
   review link, and confirm the click appears in Activity.

The SMSGate credentials are stored in `gateway_credentials` (service-role only)
and are never returned to the browser.

## Live-send checklist

Do this once, with your own phone, before real customer traffic:

- [ ] `supabase db push --linked` is clean (all migrations applied).
- [ ] Worker secrets are set: `SUPABASE_SERVICE_ROLE_KEY`, SMS provider or
      gateway credentials as needed.
- [ ] Your own mobile is on `SEND_ALLOWLIST`; `SENDER_LIVE` is unset.
- [ ] Run `cancel_dev_messages()` (service role) and note the count returned.
- [ ] Set `SENDER_LIVE=true` (`wrangler secret put SENDER_LIVE`).
- [ ] Send one text to your own number; confirm it arrives.
- [ ] Tap the review link; confirm the click is recorded and Google opens.
- [ ] Reply `STOP`; confirm the number appears as opted out and receives no
      further texts.
- [ ] Only then set `PRODUCTION=true` for real traffic. This disables the
      allowlist, so verify quiet hours (9am–8pm Melbourne), caps and templates
      first. Watch `cd worker && npx wrangler tail` during the first sends.

## Pausing a client

**Admin → Businesses → Pause** sets the business to `paused`. The sender skips
paused businesses, so nothing new goes out. Messages already queued stay queued
and resume when the business is set back to `active` or `trial` (subject to
caps and quiet hours). Use **Trial** to keep the trial text cap in force.

## Resetting an owner's password

Two ways:

1. **Owner-initiated:** owner app → **Set or change password** in Settings
   (requires being logged in).
2. **Operator-initiated:** Admin → Businesses → **Reset pw** beside the
   business, or **Admin → Audit → Generate owner login link** for that email.
   Both return a link; copy it and send it to the owner. The link opens
   `/set-password`; expired or reused links show a friendly message. Email
   delivery is not configured for clients yet, so links are copied by hand.

## Admin access

Admin status is a `role = 'admin'` row in `public.profiles`; the Worker checks
it server-side on every `/admin/*` request. The frontend contains no admin
email list. To promote a user (service role):

```sql
update public.profiles
   set role = 'admin'
 where id = (select id from auth.users where email = 'person@example.com');
```

## Review tracking (optional)

Snapshots need a `GOOGLE_PLACES_API_KEY` (Worker secret). Without it,
`/status` returns `places_connected:false`, the daily `0 1 * * *` cron exits
cleanly, and the dashboard shows "Google review tracking not connected yet."
Places `rating`/`userRatingCount` are Enterprise fields with 1,000 free calls
per month; the app caps itself at 900 and snapshots less often as the client
count grows.

## Customer data and opt-outs

- A customer is suppressed permanently after tapping the opt-out link or
  replying `STOP`; `opt_outs` rows survive customer/business cleanup.
- Owners can only add real customers they served. See `/terms` and `/privacy`
  in the app for the client-facing terms and privacy notice.
- Legal pages are **drafts for legal review** and are served without login from
  the login footer and Settings.

## Legal pages

`/terms` and `/privacy` are public pages in the frontend. They name Mur Systems
(ABN 22 545 735 809) as provider and cover data held, storage in Supabase
Sydney, retention, client responsibilities, opt-outs and deletion requests.
Both are marked as drafts until reviewed by a lawyer.

## Hosting notes

- The frontend is a Cloudflare Worker with static assets, not a Pages project.
- `LINK_DOMAIN` currently points at the Worker dev address; swap it for a custom
  short domain when one exists.
- Supabase's built-in auth email is limited to 2 messages/hour and only to
  project organisation members. Before clients use emailed links, configure
  custom SMTP in Supabase Auth.
