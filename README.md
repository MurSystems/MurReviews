# Reviews by Mur Systems

Multi-tenant app that lets local businesses collect more Google reviews by
texting customers a review link after a job. Operated by Mur Systems.

**Status: Stage 2 complete** — auth (magic link), owner app shell, and the
add-customer flow (log-only sender). Stage 1 (schema, RLS, queue, tests) is in
`supabase/`. See [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Stack (target)

- Frontend: React + TypeScript + Vite, installable PWA
- API + cron: Cloudflare Workers
- Hosting: Cloudflare Pages/Workers (free tier)
- Database + auth: Supabase (Postgres, magic-link email, RLS on every table)

## Layout

```
frontend/       # owner app (React + Vite, mobile-first PWA)
supabase/
  migrations/   # schema + RLS (ordered SQL)
  tests/        # pgTAP RLS tests
  seed.sql      # demo business + fake customers
scripts/        # Node test runner (Docker-free)
docs/           # data model + runbooks
```

## Run the owner app

The frontend reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from
`frontend/.env` (already filled for this project; copy `.env.example` for a
fresh checkout).

```bash
cd frontend
npm install
npm run dev
```

Then open the printed URL (usually **http://localhost:5173**).

- **On your PC:** open that URL in a browser.
- **On your phone:** make sure the phone is on the same Wi-Fi, then run
  `npm run dev -- --host`, and open `http://<your-PC-IP>:5173` in the phone's
  browser (find your PC's IP with `ipconfig` → "IPv4 Address").

Log in with a magic link using `mursystems123@gmail.com` — the demo business
is owned by that address, so you'll see the demo customers right away.

## Auth email (dev vs production)

Supabase's built-in email sender is limited to **2 auth emails/hour**,
project-wide, and only to addresses that are **members of your Supabase
organisation** — fine for you logging in during development, but not for real
clients.

Before onboarding real clients you'll need **custom SMTP** (a free provider is
fine), which raises the limit to 30/hour (adjustable in Auth → Rate Limits)
and lets you send to any address. Not set up yet. See Supabase's
[Auth SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp).

## Run the DB tests

The pgTAP tests run against the linked Supabase project via a small Node
runner — no Docker required. Each test file runs in its own transaction that
is **always rolled back**, so test data never persists.

```bash
npm install                     # once; installs the `pg` driver

supabase link --project-ref <ref> -p <pw>   # once; writes supabase/.temp/*

npm run test:db                 # prints the target and refuses to run
npm run test:db -- --confirm    # actually runs the tests
```

`npm run test:db` prints the project ref and pooler host it would hit, then
exits without running. Pass `-- --confirm` to run. The runner reads the
project ref + pooler URL from `supabase/.temp/` (written by `supabase link`)
and the database password from `.env` (never printed).

To push migrations + seed to the linked project (no reset):

```bash
supabase db push --linked --include-seed
```
