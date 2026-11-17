# Handoff

## Deployed & where
- **Supabase** (DB + auth + storage): project ref `pxnrcwnqoooemashbjgt`, name "MurSystems", region ap-southeast-2.
- **Frontend** (owner + admin PWA): `https://mur-reviews.mursystems123.workers.dev` (Cloudflare Worker `mur-reviews` with static assets — not a Pages project).
- **Worker** (links /r,/o + cron sender + webhook + admin routes + review snapshots): `https://m.mursystems123.workers.dev` (name `m`).
- **GitHub**: `https://github.com/MurSystems/MurReviews.git` (branch `main`).
- **Repo**: `C:\Claude.projects\mur-reviews` (standalone git repo; NOT the Python `free-claude-code` repo).

## Pending (in this order)
1. **Google review tracking (optional)** — dashboard is finished and works without a key. Add `GOOGLE_PLACES_API_KEY` to root `.env` and `wrangler secret put GOOGLE_PLACES_API_KEY` (piped, never printed) to turn snapshots on; until then `/status` returns `places_connected:false`, the dashboard shows texts/clicks/click-rate and "Google review tracking not connected yet.", and the `0 1 * * *` cron exits cleanly without failing.
2. **Live send test** — Mobile Message creds into `.env` → set Worker secrets → `GET /v1/senders` (list) → `SENDER_LIVE=true` → `cancel_dev_messages()` (show count) → one text → click → STOP.
3. **README** — finalise (setup steps largely present; title/brand still says "Reviews by Mur Systems").
4. Optional earlier items remain available: add `GOOGLE_PLACES_API_KEY` (root `.env` → `wrangler secret put`, piped and never printed → redeploy) and confirm the snapshot cron writes `review_snapshots`; then run the live send test.

**Done 2026-11-17 (UI pass, Session 2)**: Activity, Dashboard, Settings/Import and Admin restyled on the shared layout/type system and phone width. Activity now lists the latest 20 texts and replies instead of the placeholder. Settings has a "Coming soon" AI-replies card whose once-per-business "I want this" button writes to `public.ai_reply_interest`. Admin runs on the dark shell (black/gold), every field is labelled, generated links have Copy buttons, and the business listing shows who wants AI replies.

**Done 2026-11-17 (UI fixes, Session 3)**: Login shows the name once (compact ring mark + "Mur Reviews" heading). Light is now the default everywhere, including login and admin; Settings → Appearance toggles light/dark, saved per device (`mur-theme`), and the choice drives `html.dark`, the PWA `theme-color` and the manifest colours. Primary buttons are ink/ivory in light; dark keeps black/gold. The "Email me a sign-in link instead" option is hidden for clients (`config.auth.signInLinkForEveryone: false`) and shown only for admin emails (`config.auth.adminEmails`), and it validates the email first ("Enter your email first."). Settings has "Set or change password" for any logged-in user. Login has "Forgot password?" explaining to contact Mur Systems until reset email is set up. All auth/storage/DB/Worker messages pass through `frontend/src/errors.ts`, so no raw technical text reaches the screen; `adminFetch` no longer includes the response body in errors.


## Decisions made
- **Stack**: React+Vite PWA · Cloudflare Workers (free) · Supabase Postgres+auth+storage (free).
- **Places pricing**: `rating` + `userRatingCount` are **Enterprise** fields (Place Details Enterprise), **1,000 free/month**; internal cap **900**. If daily snapshots would exceed it, snapshot less often (frequency = ceil(active×30/900)).
- **Review tracking is optional**: a missing or blank `GOOGLE_PLACES_API_KEY` disables Places entirely — `GET /status` reports `places_connected:false`, the snapshot cron logs a skip and returns (no failed job), and the dashboard still shows texts/clicks/click-rate plus "Google review tracking not connected yet."
- **Send modes**: `sms_provider` (default, Mobile Message) · `android_gateway` (SMSGate, optional) · `demo` · `log_only`. Live switch = `SENDER_LIVE` (off). `PRODUCTION` unset. `SEND_ALLOWLIST` = operator's number only.
- **SMSGate**: cloud relay recommended; E2E (RSA+AES-GCM) **not** implemented (deferred). **Mobile Message**: sender = "own mobile number", verified in dashboard (4-digit code), no documented limit; ACMA Register is for business-name senders only.
- **Defaults**: delay 60 min · quiet hours 9am–8pm (Melbourne) · reminder at 3 days · `daily_send_cap` (import drip) **15** · `daily_text_cap` **100** · `monthly_text_cap` **500** · `trial_text_cap` **30** · demo send 1/30d per number + 20/day · tokens 8-char base62.
- **Brand**: product **"Mur Reviews"**, company **"Mur Systems"** ("by Mur Systems" on the login page only). Colours: black `#0c0c0c`, gold `#c8a45c`, ivory `#f4efe6`, ink `#14110d`. Cinzel (Google Fonts) for the logo, product/business names and headings only; everything else sans-serif. Light is the default theme; dark (black/gold) is opt-in per device from Settings → Appearance. On ivory, text and buttons are ink and gold is only thin lines/small accents. All in `frontend/src/config.ts`.
- **Logo**: code-only component `frontend/src/components/Logo.tsx` — Cinzel "M" in a thin outer ring + slightly heavier inner ring, with a "MUR REVIEWS" wordmark; `compact` prop gives the ring-only mark used in the owner header.
- **What's new**: `config.whatsNew.version` + `message`; shown once per user, dismissed in localStorage under `mur-whats-new:<userId>`.
- **App icon/PWA**: gold M ring on black, PNGs 32/180/192/512 in `frontend/public/`; manifest name "Mur Reviews". The old purple `favicon.svg` was removed.
- **Templates**: shortened; end with `Opt out: {opt_out}`; one segment (two only for long names). Mock sends carry `messages.mock=true` and are excluded from all stats.
- **Activity**: owner screen reads the latest 20 `messages` and 20 `replies` directly (RLS-scoped) — no placeholder left.
- **AI reply interest**: `public.ai_reply_interest` (PK `business_id`, `requested_by`, `created_at`); owners may select/insert their own row, update/delete revoked, so one request per business. `admin_list_businesses()` now returns `ai_replies_requested_at`, which the admin table renders as a gold pill.
- **Admin theme**: admin uses the same theme as the owner app (light by default, dark when selected); it no longer forces the dark token set.
- **Auth**: email+password (primary) + magic link (secondary); owners onboarded via `invite` (set-password) link, reset via `recovery`. The login magic-link option is limited to admin emails until client email delivery is set up (`config.auth.signInLinkForEveryone`). Any logged-in user can set/change their password in Settings. "Forgot password?" tells users to contact Mur Systems until reset email exists. Error copy is mapped in `frontend/src/errors.ts` — never show a raw Supabase/Postgres/Worker message.

## Env vars & secrets (names only)
- **Root `.env`**: `SUPABASE_DB_PASSWORD`, `MOBILE_MESSAGE_USERNAME`, `MOBILE_MESSAGE_PASSWORD`, `GOOGLE_PLACES_API_KEY`.
- **Worker vars** (`worker/wrangler.jsonc`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SEND_ALLOWLIST`, `LINK_DOMAIN`, `SEND_THROTTLE_MS`, `CORS_ORIGINS`.
- **Worker secrets** (`wrangler secret put`): `SUPABASE_SERVICE_ROLE_KEY`, `SMSGate_WEBHOOK_SECRET` (optional), `MOBILE_MESSAGE_USERNAME`, `MOBILE_MESSAGE_PASSWORD`, `GOOGLE_PLACES_API_KEY`.
- **Frontend** (`frontend/.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- `.env.example` (root) and `worker/.dev.vars.example` document the names.

## Run tests / deploy
- DB tests: `npm run test:db -- --confirm` (Node pgTAP runner, Docker-free; refuses without `--confirm`).
- Worker tests: `cd worker && npm test` (Vitest).
- Push migrations: `supabase db push --linked`.
- Deploy Worker: `cd worker && wrangler deploy`.
- Deploy frontend: `cd frontend && npm run build && npx wrangler deploy --name mur-reviews`. The live Worker is `mur-reviews`; the Vite config's own name is `frontend`, so pass `--name` or it deploys a second Worker.
- Cloudflare auth: `cd worker && npx wrangler login --device` (OAuth token expires; device flow avoids the localhost callback). `CLOUDFLARE_ACCOUNT_ID` is `b228d54762c8a6aab17f5d26c8f84d5a`.

## Next step (Session 4 — README)
Finalise `README.md`: correct the title/brand to "Mur Reviews" (currently "Reviews by Mur Systems"), keep the existing setup steps, and document the AI-replies interest feature and the `GOOGLE_PLACES_API_KEY` optional switch. Then update this file, commit, push.
