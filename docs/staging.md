# KayEdu — Staging for the database gates and e2e (S1)

> One staging Supabase project is where `check:*` gates, `check:all` and `npm run e2e` are allowed to write. The shared **dev** project is not: gates create and delete rows, the e2e suite signs in and writes. This file is the runbook. Nothing in it has been run for you. Rules: `CLAUDE.md` 7 and 8; the Vercel side is `deploy-vercel.md`.

## What S1 changed

- **`.env.staging`** (git-ignored; `.env.staging.example` is committed) holds the staging project's values. **`KAYEDU_ENV=staging`** makes the one shared loader (`scripts/lib/env.ts`, entered through `scripts/with-env.ts`) read it instead of `.env` — for the seed, the wipe, `seed:verify`, every `check:*` gate, `check:all`, `gates:users`, `perf:*` and `npm run e2e` (`playwright.config.ts` calls the same loader).
- **Staging never inherits dev.** The file must carry the nine required keys or the run stops before it connects; a key `.env` defines that `.env.staging` does not is blanked (so Prisma's and Next's own `.env` loading cannot fill it in from dev); and if any of its URLs names the same project as `.env`, it stops. With `KAYEDU_ENV=staging` and **no** `.env.staging` it stops — it never falls back to `.env`.
- **The write-guard** (`assertSafeToWrite`). Every database-writing gate (inside `gatePrisma`), `npm run check:all`, `npm run gates:users` and `npm run e2e` **refuse** unless `KAYEDU_ENV=staging` *or* `DATABASE_URL` is on `localhost`; and refuse whenever the target is the same database as the dev project in `.env`; and refuse a production target. **There is no override flag.** `check:rls` is read-only and is not guarded.
  *Same database* is decided by the Supabase **project ref** (the pooler user `postgres.<ref>`, or the `db.<ref>.supabase.co` host) — not by the hostname alone, because every project in a region shares one pooler hostname, so a host comparison would call staging "dev". Without a ref (a plain Postgres) it compares host, user and database name, and the port for localhost.
- **Not guarded, on purpose:** `db:seed`, `db:wipe-dev`, `seed:verify` run against dev by hand, behind their own fences (`DEV_PROJECT_REF`, `ALLOW_DEV_WIPE`, the typed project ref).
- **`npm run db:deploy:staging`** = `prisma migrate deploy` against `.env.staging` (forces staging itself). Prisma keeps its rules: `migrate deploy` only, never `migrate dev`, `reset` or `db push` (`SEC-39`).
- **CI** sets `KAYEDU_ENV: staging` at the workflow level; its `DATABASE_URL`/`DIRECT_URL` secrets are a dedicated staging project, and there is no `.env.staging` on the runner (the loader allows that only under `GITHUB_ACTIONS`).

## 1. Dashboard settings the staging project needs

Create a **new** Supabase project, in the same region as dev/Vercel (`eu-central-1`). Then:

| Setting | Where | Value | Why |
|---|---|---|---|
| **Confirm email** | Authentication → Sign In / Providers → Email | **Off** | The e2e account-claim journey registers a user and signs straight in; the seed's accounts are created pre-confirmed through the admin API either way. With it **on**, set up SMTP and `REQUIRE_EMAIL_CONFIRMATION=true`, and expect `claim.spec.ts` to need a real inbox. |
| `ALLOW_AUTO_CONFIRM_DEMO=yes` | `.env.staging`, **only** if the app is started with a production marker (`VERCEL_ENV`/`KAYEDU_ENV=production`) | `yes` | The confirm-email guard runs only on a production start; a local `npm run dev` (what e2e starts) is unguarded, so it is **not** needed there. A staging *deployment* on Vercel Production needs it while Confirm email is off (`deploy-vercel.md` §4). |
| **Storage buckets** | Storage | **Nothing to do by hand** | `avatars`, `id-cards`, `logos`, `session-uploads` are created — **private**, with size and MIME caps — by the migration `20261017090100_sec2a_data_api_lockdown`, i.e. by step 3 below. Only if `check:rls` warns that the migration role lacked privilege on `storage.buckets` do you create the four private buckets in the dashboard. The seed creates no buckets. |
| Site URL / Redirect URLs | Authentication → URL Configuration | `http://localhost:3000/**` for the local e2e run | The confirmation link and sign-in redirect. |

Grab from Connect / Project Settings → API: the transaction-pooler and session-pooler strings, the project URL, the anon key and the `service_role` key.

## 2. One-time setup (PowerShell, from the repo root)

```powershell
Copy-Item .env.staging.example .env.staging
notepad .env.staging        # fill DATABASE_URL, DIRECT_URL, the three Supabase keys, NEXT_PUBLIC_APP_URL,
                            # DEV_PROJECT_REF = the STAGING project ref, SEED_PASSWORD, SEED_ADMIN_PASSWORD
```

`DEV_PROJECT_REF` keeps its historical name; in `.env.staging` it is the **staging** project's ref, and it is what lets the seed and the wipe run there. `SEED_ADMIN_PASSWORD` must differ from `SEED_PASSWORD`. Do not put `ALLOW_DEV_WIPE` in the file.

## 3. Apply migrations

```powershell
npm run db:deploy:staging
$env:KAYEDU_ENV = "staging"
npm run check:rls            # read-only: Data API closed, four private buckets, no storage policies
```

Re-run `db:deploy:staging` after every schema change. The Vercel build never runs migrations.

## 4. Seed

```powershell
$env:KAYEDU_ENV = "staging"          # stays set for the rest of this PowerShell window
npm run seed:preflight               # optional: can Supabase Auth create the @example.com accounts?
npm run db:seed
```

## 5. Verify the seed

```powershell
npm run seed:verify
```

## 6. Gates and e2e

```powershell
$env:KAYEDU_ENV = "staging"
npm run check:all                    # every gate, in CI's order; also checks the run left no stray User rows
npm run e2e                          # run it ALONE: no gates, no edits at the same time
```

A single gate is `npm run check:payments`, etc. The e2e notes of `e2e-run-conditions` still apply (alone, heap-raised dev server, a lone `/login` bounce is session expiry). Close the window, or `Remove-Item Env:KAYEDU_ENV`, when you are done — an unset `KAYEDU_ENV` means the dev `.env` again, and the guard will refuse a gate there.

**What a refusal looks like** (a gate with dev's `.env`, `KAYEDU_ENV` unset):

```
REFUSED: npm run check:payments writes to its database, and this run would write to aws-0-eu-central-1.pooler.supabase.com, which is neither a staging run (KAYEDU_ENV is not 'staging') nor a database on this machine. Gates and e2e write rows; against a shared project that means the dev project.

  Run it against staging:  $env:KAYEDU_ENV = "staging"   (then the same command; see docs/staging.md)
  or against a throwaway local Postgres (DATABASE_URL on localhost).
  There is no override flag.
```

## 7. Reset staging

Staging's own wipe ritual — the same fences as dev's, aimed at the staging project. It empties the `public` tables; `_prisma_migrations`, `auth.*` and `storage.*` stay.

```powershell
$env:KAYEDU_ENV = "staging"
$env:ALLOW_DEV_WIPE = "yes"          # this one command only
npm run db:wipe-dev                  # prints the target; type the staging project ref to confirm
Remove-Item Env:ALLOW_DEV_WIPE
npm run db:seed
npm run seed:verify
```

The wipe refuses unless `DATABASE_URL`, `DIRECT_URL` and `NEXT_PUBLIC_SUPABASE_URL` all carry the ref in `.env.staging`'s `DEV_PROJECT_REF`, and never touches a production ref.
