# KayEdu — Deploying to Vercel (DEPLOY-1)

> A checklist for connecting the repo to Vercel. Nothing here has been run for you: no deploy, no migration, no wipe. Sources: `02-architecture.md` §16 (env inventory), `08-system-audit.md` §5, `03-build-order.md` M20.

## ⚠ Read this first

- **The dev database holds seeded demo data** (~23 `@example.com` accounts sharing one password — `docs/dev-accounts.md`). Pointing a deployment at it puts those logins on the public internet.
- **Sign-up is open** (`/register`). Anyone who finds the URL can create an account. Rate limits exist (Postgres-backed, SEC-67) but there is **no CAPTCHA yet** (M20).
- Supabase *Confirm email* is **off** on dev. A **production** Vercel deployment refuses to start in that state unless you set the demo override (below). A **preview** deployment does not run the guard at all.
- So a demo deploy is: a throw-away/staging Supabase project, seeded, shared only with people you trust. **Never** point a deployment at the shared dev project for real users, and never at a database holding real data without finishing M20.

## 1. Environment variables

Set them in Vercel → Project → Settings → Environment Variables, per environment (Production / Preview). `NEXT_PUBLIC_*` values are inlined into the browser bundle **at build time** — change one and you must redeploy.

| Variable | Required | Exposure | Where to find it |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | server | Supabase → Connect → ORMs → Prisma → **Transaction pooler** (port 6543). Append `?pgbouncer=true&connection_limit=10&pool_timeout=20`. Username is `postgres.[ref]`; use the `pooler.supabase.com` host, not `db.[ref].supabase.co` (IPv6-only). |
| `DIRECT_URL` | Yes for migrations (set it anyway — `prisma validate`/`generate` read the schema's `directUrl`) | server | Same screen → **Session pooler** (port 5432). |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | public | Supabase → Project Settings → API → Project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | public | Same page → `anon` / publishable key. (The Data API is closed to it — SEC-10.) |
| `MEDIA_UPLOADS_ENABLED` | No (default off) | server only | `true` lets the Branding logo change store a file. While off, logo and profile-photo uploads validate and then answer "not connected" — nothing is stored. Turn on only once media storage is connected (M20). |
| `MEDIA_AVATARS_DISPLAY` | No (default off) | server only | `true` shows profile photos in the user menu, teacher cards and rosters. Off: the photo shows only on the Account page. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes for photos, ID cards, logos, session uploads | **server only** | Same page → `service_role` key. Never prefix with `NEXT_PUBLIC_`. Without it, Storage features degrade. |
| `NEXT_PUBLIC_APP_URL` | **Yes** in production | public | The deployment's real origin, e.g. `https://kayedu.example` — no trailing slash. Used for the email-confirmation redirect. |
| `REQUIRE_EMAIL_CONFIRMATION` | **`true` in production** | server | A literal `true`. Needs Supabase *Confirm email* on **and** working SMTP. |
| `ALLOW_AUTO_CONFIRM_DEMO` | No — **demo only** | server | `yes` only for a demo deployment with *Confirm email* off. See §4. Ignored if `REQUIRE_EMAIL_CONFIRMATION=true`. |
| `ALLOW_UNVERIFIED_EMAIL_CHANGE` | No — **demo only** | server | `yes` lets Account settings change a person's email without a confirmation link, until SMTP exists. Off → the email field is read-only. See §4. Ignored if `REQUIRE_EMAIL_CONFIRMATION=true` — and production **refuses to start** with both set. |
| `KAYEDU_ENV` | Only off-Vercel | server | `production` marks a non-Vercel production host. Vercel sets `VERCEL_ENV` itself — don't set either by hand on Vercel. |

`NODE_ENV` and `NEXT_RUNTIME` are set by Next/Vercel.

### MUST NOT be set on Vercel

| Variable | Why |
|---|---|
| `ALLOW_DEV_WIPE` | Arms `db:wipe-dev`, which deletes data. Per-command, local only. |
| `SEED_PASSWORD`, `SEED_ADMIN_PASSWORD`, `SEED_EMAIL_DOMAIN` | Seed credentials. The seed is run from a developer machine, never by the deployment. |
| `DEV_PROJECT_REF` | The seed/wipe fence for the dev project. Meaningless — and a smell — on a deployment. |
| `KAYEDU_QUERY_LOG`, `KAYEDU_DB_STATS` | Dev diagnostics; log every SQL statement. |
| `E2E_*`, `GATE_*`, `QUERY_COUNT_PORT` | Local test tooling. |
| Any secret under a `NEXT_PUBLIC_` name | It would ship to every browser. |

## 2. Build, database, region

- **Framework preset:** Next.js. Install: default (`npm install`) — `postinstall` runs `prisma generate`, so the client is regenerated even when Vercel restores a cached `node_modules`. Build: `next build` (the `build` script). No custom output directory.
- **Region:** `vercel.json` pins functions to **`fra1`** (Frankfurt), next to the Supabase project. Keep the Supabase project in the same region (`eu-central-1` in the pooler hostname), or each query pays a cross-region round trip (~112 ms from Cairo, a few ms same-region — `02` §14).
- **Pooled vs direct.** The app at runtime uses `DATABASE_URL` (transaction pooler, `pgbouncer=true`). `DIRECT_URL` (session pooler, 5432) is only for migrations. Each function instance holds up to `connection_limit` (10) connections: keep `connection_limit × concurrent instances` under the pooler's limit (Supabase → Database → Connection Pooling).
- **Migrations are never run by the Vercel build.** Apply them as a deliberate release step from your machine, against the target project, **before** the first deploy and after any schema change:
  ```
  npx prisma migrate deploy
  ```
  (`DIRECT_URL` in your local env pointing at the target.) Never `migrate reset`, `db push --force-reset` or a shadow-database diff against a real URL (CLAUDE.md rule 7). After the first `migrate deploy` on a new project, run `npm run check:rls` against it before any data goes in.
- **First-time data:** a new project is empty. Loading the demo seed is a separate, deliberate local step (`npm run db:seed` with the project's own `DEV_PROJECT_REF`); it is not part of the deployment.

## 3. Supabase Auth settings

Supabase → Authentication → URL Configuration:

- **Site URL:** the deployment's origin (same as `NEXT_PUBLIC_APP_URL`).
- **Redirect URLs (allow-list):** `https://<origin>/**` — at minimum `https://<origin>/en/auth/confirm` and `https://<origin>/ar/auth/confirm` (the confirmation link lands on `/{locale}/auth/confirm`). Add `http://localhost:3000/**` only on a dev project. For Vercel previews add the specific preview origin; a wildcard preview pattern widens the allow-list, so prefer not to.
- **Confirm email** (Authentication → Sign In / Providers → Email): **on** for any real use. It needs a real SMTP sender — Supabase's built-in mailer is rate-limited and not for production (M20). With it off, use the demo override (§4) and treat every sign-up as unverified.
- Also at M20: CAPTCHA on sign-up/sign-in, leaked-password protection, delete the legacy dev auth users.

## 4. The confirm-email guard and the demo override

What the guard does (`instrumentation.ts` → `lib/auth/production-guard.ts`, `lib/auth/auth-config.ts`):

- "Production" means **`VERCEL_ENV === "production"` or `KAYEDU_ENV === "production"`** — *not* `NODE_ENV` (a preview build also has `NODE_ENV=production`). Preview and Development deployments are unguarded.
- On a production **server start** (Node runtime) it requires `REQUIRE_EMAIL_CONFIRMATION="true"` **and** a reachable Supabase `/auth/v1/settings` reporting `mailer_autoconfirm: false`. Otherwise it throws `AuthMisconfiguredError` and the instance does not serve. Separately, sign-in resolution (`resolveAppIdentity`) throws in production when `REQUIRE_EMAIL_CONFIRMATION` is not `true`.
- So: **a production deploy with Confirm email OFF refuses to serve** unless the override is set.

The override: `ALLOW_AUTO_CONFIRM_DEMO=yes` (exact value) on a production deployment lifts both checks, and logs a loud `!!! KayEdu: ALLOW_AUTO_CONFIRM_DEMO=yes … !!!` warning at start. It is off by default, ignored when `REQUIRE_EMAIL_CONFIRMATION=true`, and `check:security` asserts the guard still refuses without it. The account-claim flow still prevents a sign-up from taking over a staff-created person, but emails are unverified. **Remove it before a real centre** (M20).

### The email-change override (F2)

`ALLOW_UNVERIFIED_EMAIL_CHANGE=yes` (exact value) lets a signed-in person change their own email on **Account settings** (`/{locale}/account`) without a confirmation link: after their current password is checked (rate-limited per account and per IP), the Supabase admin API sets the new address **already confirmed** (so it needs `SUPABASE_SERVICE_ROLE_KEY`). Without it the email field is read-only ("coming soon"). It logs a loud `!!! KayEdu: ALLOW_UNVERIFIED_EMAIL_CHANGE=yes … !!!` warning at every server start, does nothing when `REQUIRE_EMAIL_CONFIRMATION=true` (then Supabase's own email-change flow mails a link to the new address, which lands on `/{locale}/auth/confirm`), and a **production deployment refuses to start** when both are set. It adds no hole the demo posture does not already have: with *Confirm email* off, anyone can already sign up with an address they do not control. **Remove it before a real centre** (M20).

## 5. Storage

Buckets: `avatars`, `id-cards`, `logos`, `session-uploads`. The `20261017090100_sec2a_data_api_lockdown` migration creates them **private** with size and MIME caps (it only warns if the migration role lacks privilege on `storage.buckets` — then create them by hand).

After `migrate deploy`, in Supabase → Storage check:
- All four buckets exist and show **Private** (no "Public" badge).
- No policy exists on `storage.objects` (zero policies = deny for everyone but the service role).
- `npm run check:rls` prints the bucket check clean.
- In the app, a photo/logo URL is a short-lived **signed** URL (`…/object/sign/<bucket>/…?token=…`), never `/object/public/…`.

## 6. Post-deploy smoke checklist

Do this by hand on the deployed URL, in a private window. Passwords are the seed's (`SEED_PASSWORD`; the admin has `SEED_ADMIN_PASSWORD`). Logins are in `docs/dev-accounts.md`.

1. **Log in as each role** and confirm it lands on its home with its own sidebar and no error page: `admin@…` (platform admin), `owner.center60@…`, `manager.downtown@…`, `receptionist.downtown@…`, `accountant.downtown@…`, `teacher.downtown@…`, `student.downtown@…`, `parent.family@…`. Try Arabic (RTL) and a phone-width window for at least one.
2. **Sign-up:** register a new account from `/register`. With Confirm email on, a confirmation email arrives and its link opens `/<locale>/auth/confirm`, then signs in. With the demo override, it signs in directly. Delete/ignore the test account afterwards.
3. **Student photo upload:** as an owner/manager/receptionist open a student → upload a small JPEG/PNG (< 1 MB). It must display (signed URL) and survive a reload.
4. **Print a receipt:** as a receptionist/owner open a closed session with a payment → print/receipt view → browser print preview renders cleanly (no app chrome).
5. **Response headers** (browser DevTools → Network → any page → Headers, or `curl -I https://<origin>/en/login`): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Content-Security-Policy-Report-Only`; **no** `X-Powered-By`.
6. **Start-up log:** Vercel → Logs shows no `AuthMisconfiguredError`; with either override (`ALLOW_AUTO_CONFIRM_DEMO`, `ALLOW_UNVERIFIED_EMAIL_CHANGE`) you see its loud warning (and know to remove it).
7. **Tenant sanity:** `manager.downtown` cannot see Nokhba's data; `teacher.shared` sees both branches' sessions only.
8. **Account settings:** as any role, open the user menu → Account settings; change the name and save; change the password with the wrong current password (refused), then the right one. With `ALLOW_UNVERIFIED_EMAIL_CHANGE=yes`, change the email to a fresh address and sign in with it; without it, the email field is read-only.
