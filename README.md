# Reviews by Mur Systems

Multi-tenant app that lets local businesses collect more Google reviews by
texting customers a review link after a job. Operated by Mur Systems.

**Status: Stage 1 complete** — data model, row-level security, and RLS tests.
See [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Stack (target)

- Frontend: React + TypeScript + Vite, installable PWA
- API + cron: Cloudflare Workers
- Hosting: Cloudflare Pages/Workers (free tier)
- Database + auth: Supabase (Postgres, magic-link email, RLS on every table)

## Layout

```
supabase/
  migrations/   # schema + RLS (ordered SQL)
  tests/        # pgTAP RLS tests
  seed.sql      # demo business + fake customers
scripts/        # Node test runner (Docker-free)
docs/           # data model + runbooks
```

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
