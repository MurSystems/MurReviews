# Handoff

## Deployed & where
- **Supabase** (DB + auth + storage): project ref `pxnrcwnqoooemashbjgt`, name "MurSystems", region ap-southeast-2.
- **Frontend** (owner + admin PWA): `https://mur-reviews.mursystems123.workers.dev` (Cloudflare Pages, project `mur-reviews`).
- **Worker** (links /r,/o + cron sender + webhook + admin routes + review snapshots): `https://m.mursystems123.workers.dev` (name `m`).
- **GitHub**: `https://github.com/MurSystems/MurReviews.git` (branch `main`).
- **Repo**: `C:\Claude.projects\mur-reviews` (standalone git repo; NOT the Python `free-claude-code` repo).

## Pending (in this order)
1. **Google review tracking (optional)** — dashboard is finished and works without a key. Add `GOOGLE_PLACES_API_KEY` to root `.env` and `wrangler secret put GOOGLE_PLACES_API_KEY` (piped, never printed) to turn snapshots on; until then `/status` returns `places_connected:false`, the dashboard shows texts/clicks/click-rate and "Google review tracking not connected yet.", and the `0 1 * * *` cron exits cleanly without failing.
2. **Live send test** — Mobile Message creds into `.env` → set Worker secrets → `GET /v1/senders` (list) → `SENDER_LIVE=true` → `cancel_dev_messages()` (show count) → one text → click → STOP.
3. **UI pass** — styling/polish (everything is functional but plain).
4. **README** — finalise (setup steps largely present).

## Decisions made
- **Stack**: React+Vite PWA · Cloudflare Workers (free) · Supabase Postgres+auth+storage (free).
- **Places pricing**: `rating` + `userRatingCount` are **Enterprise** fields (Place Details Enterprise), **1,000 free/month**; internal cap **900**. If daily snapshots would exceed it, snapshot less often (frequency = ceil(active×30/900)).
- **Review tracking is optional**: a missing or blank `GOOGLE_PLACES_API_KEY` disables Places entirely — `GET /status` reports `places_connected:false`, the snapshot cron logs a skip and returns (no failed job), and the dashboard still shows texts/clicks/click-rate plus "Google review tracking not connected yet."
- **Send modes**: `sms_provider` (default, Mobile Message) · `android_gateway` (SMSGate, optional) · `demo` · `log_only`. Live switch = `SENDER_LIVE` (off). `PRODUCTION` unset. `SEND_ALLOWLIST` = operator's number only.
- **SMSGate**: cloud relay recommended; E2E (RSA+AES-GCM) **not** implemented (deferred). **Mobile Message**: sender = "own mobile number", verified in dashboard (4-digit code), no documented limit; ACMA Register is for business-name senders only.
- **Defaults**: delay 60 min · quiet hours 9am–8pm (Melbourne) · reminder at 3 days · `daily_send_cap` (import drip) **15** · `daily_text_cap` **100** · `monthly_text_cap` **500** · `trial_text_cap` **30** · demo send 1/30d per number + 20/day · tokens 8-char base62.
- **Brand**: "Mur Systems" / "Reviews by Mur Systems" · white bg, near-black text, blue accent (in `frontend/src/config.ts`).
- **Templates**: shortened; end with `Opt out: {opt_out}`; one segment (two only for long names). Mock sends carry `messages.mock=true` and are excluded from all stats.
- **Auth**: email+password (primary) + magic link (secondary); owners onboarded via `invite` (set-password) link, reset via `recovery`.

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
- Deploy frontend: `cd frontend && wrangler pages deploy ./dist --project-name mur-reviews`.
- Cloudflare auth: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (`b228d54762c8a6aab17f5d26c8f84d5a`).

## Next step
Optional: add the Google key (`GOOGLE_PLACES_API_KEY` in root `.env` → `wrangler secret put GOOGLE_PLACES_API_KEY`, piped from `.env` and never printed → redeploy) and confirm the snapshot cron records a `review_snapshots` row. Otherwise proceed to the live send test.
