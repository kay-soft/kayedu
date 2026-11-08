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

**Known `check:rls` finding on a stock project.** The first run on a fresh Supabase project reported `anon`/`authenticated` with USAGE on schema `public` (it came from the schema's PUBLIC entry, which the SEC-2a migration did not revoke — fixed by `20261028090000_s1_public_schema_usage_lockdown`) and Supabase's `supabase_admin` default privileges still listing them. The latter cannot be changed by the `postgres` role the migrations run as, and it only applies to objects `supabase_admin` itself creates, never to Prisma's tables — so `check:rls` now audits only the default privileges owned by the connecting role (the one that creates our tables), which must list no `anon`/`authenticated`.

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

**Running part of the suite (E1).** Everything after `--` goes to Playwright, so a spec, a line, a project and a title filter all work, through the same loader and the same write-guard (it still refuses without `KAYEDU_ENV=staging`):

```powershell
$env:KAYEDU_ENV = "staging"
npm run e2e -- e2e/parent.spec.ts:38 --project=en-1280                     # one test, one project
npm run e2e -- e2e/navigation.spec.ts -g "owner: lands home" --project=en-1280
```

**The expected teacher nav (one list).** `scripts/lib/expected-nav.ts` (`EXPECTED_TEACHER_NAV`) is the single hand-written oracle for the teacher sidebar. `seed:verify`, `check:permissions` and `e2e/navigation.spec.ts` (both teacher accounts) all import it, so they cannot drift apart. It is deliberately not derived from `TEACHER_NAV`: **a change to the teacher nav must update that file**, and all three then pass or fail together. The other roles' lists are still written out in `seed-verify.ts`, `permissions-check.ts` and `navigation.spec.ts`.

Projects are `en-1280`, `ar-1280`, `en-375`, `ar-375` (`setup` runs first on its own — its sessions are reused when still valid). Start with one project; widen only to confirm a fix. The account-creating journeys (`signUpProjectOnly`) run in `en-1280` only — sign-up is limited to 10 an hour per IP — so they skip in the other three. Each `npm run e2e` starts a fresh dev server (compile cold), so the first test to reach a route can be slow; a one-off timeout on a cold route is worth one re-run alone before it is treated as a bug.

**What `check:all` prints (G2).**

- **At the top**, the `connection_limit` each client uses: a gate's main client (`DATABASE_URL`'s, 10 in `.env.staging.example`), a race's "other desk" (3 — it never runs more than three operations at once), and the runner's own readiness probe (1). A gate with two desks asks the pooler for at most 10 + 3 + 3 connections instead of 30; Supabase's default pooler pool is 15. This is a precaution, not a diagnosed cause of G1's fast failures.
- **Before each database-backed gate** (one whose script opens a `gatePrisma()`/`PrismaClient`; `check:rtl`, `check:filters` and `check:timezone` do not) the runner waits for the database: `SELECT 1` on a fresh one-connection client, retried every 2 s for up to 60 s. If it answers late the run says so (`the database answered after N attempts`) and the gate starts.
- **If it never answers**, the gate is **not started** and its summary row reads **`DB UNREACHABLE`** (not `FAIL`), with the last error under it; the run's last line counts these separately — `N gate(s) FAILED, M not run: DB UNREACHABLE` — and the exit code is still non-zero. A `DB UNREACHABLE` row means "the database did not answer", never "the gate's assertions failed".
- **A gate that fails in under 5 seconds** (it died on startup) has the first error line of its output printed under its summary row, with any connection-string password masked: `↳ failed in 0.7s: PrismaClientInitializationError: Can't reach database server …`.
- The user-leak check is unchanged, and the runner still deletes nothing: leaks come from gates that exit before their own cleanup and disappear when the gates pass.

A single gate is `npm run check:payments`, etc. `$env:GATE_TX_TRACE = "1"` makes a gate print each transaction that failed or took over a second, with its statement count and time (G1). The e2e notes of `e2e-run-conditions` still apply (alone, heap-raised dev server, a lone `/login` bounce is session expiry). Close the window, or `Remove-Item Env:KAYEDU_ENV`, when you are done — an unset `KAYEDU_ENV` means the dev `.env` again, and the guard will refuse a gate there.

**What a refusal looks like** (a gate with dev's `.env`, `KAYEDU_ENV` unset):

```
REFUSED: npm run check:payments writes to its database, and this run would write to aws-0-eu-central-1.pooler.supabase.com, which is neither a staging run (KAYEDU_ENV is not 'staging') nor a database on this machine. Gates and e2e write rows; against a shared project that means the dev project.

  Run it against staging:  $env:KAYEDU_ENV = "staging"   (then the same command; see docs/staging.md)
  or against a throwaway local Postgres (DATABASE_URL on localhost).
  There is no override flag.
```

### Line endings and the static gates

Source is **LF** in the index and in every checkout: `.gitattributes` pins `* text=auto eol=lf` (images, fonts and PDFs are binary), which overrides `core.autocrlf=true` on Windows. Several static gates match source text with `\n`, `^`/`$` anchors or `[\s\S]` (for example `check:branches`' "`requirePlatformAdmin()` is its first statement"); on a CRLF checkout those stop matching silently. Two defences:

1. `.gitattributes` — a fresh checkout is LF. An existing CRLF working tree is converted once (`sed -i 's/\r$//'` over the files `git ls-files --eol` reports as `w/crlf`); `git status` stays clean because the index was already LF.
2. **`scripts/lib/source.ts`** — `readSource(path)` reads a file and normalises `\r\n` to `\n`. Every `*-check.ts` gate and `scripts/lib/nav-gates.ts` / `gate-runner.ts` read source through it; a gate never calls `readFileSync(path, "utf8")` on source directly. New gates must do the same.

Gate queries that pick a row by position order totally: `createdAt`/`recordedAt`, then `id` as the tiebreaker, because rows written in the same millisecond tie (`check:session-lifecycle` asserts this order).

## 6b. Gate fixtures: the prefix list, cleanup, and `seed:verify`

Every `check:*` gate creates its own centres (slug), users (email) and a few global catalog rows (`nameEn`) under a stem of the form `<gate>-check` (`branches-check-a`, `student-portal-check-pub-listed`, `people-check-f4-s1@kayedu.test`, `Branches-Check Math`). The **one registry** is `scripts/lib/gate-fixtures.ts` (`GATE_FIXTURE_STEMS`, plus `isolation-family-` for emails). The e2e suite creates no fixtures (it signs in as seeded accounts); the old "e2e fixture prefix" was in fact the `check:student-portal` gate's.

**e2e accounts.** The three `@write` journeys that sign an account up (`parent.spec.ts`, `claim.spec.ts`, `student.spec.ts`) take a fresh tag from the `e2eTag` fixture (`e2e…`, defined once as `E2E_USER_PREFIX` in `scripts/lib/e2e-users.ts`) and build the email as `<tag>-<kind>@example.com` and the surname as `<Kind> <tag>`. The fixture deletes everything that tag names when the test ends, pass or fail: the User (cascading its profile, enrolments, family links and claims), its Supabase login, and a desk-registered record under the same surname. Audit rows keep their ids (`actorUserId` is `ON DELETE SET NULL`). A killed run can still leave accounts; `KAYEDU_ENV=staging npm run e2e:clean-users` sweeps every `e2e…@example.com` / ` e2e…` surname (seed `@…` and gate `<gate>-check…` accounts cannot match). `seed:verify` section 4 stays strict for the seed world: a relationship-less user there is a failure, e2e leftovers are cleaned at the source rather than excused.

**e2e assessments (W3a).** `e2e/assessments.spec.ts` creates an exam through the UI and a student attempt. Its title starts with one prefix, `E2E_ASSESSMENT_PREFIX` (`E2E-assessment-`, registered in `scripts/lib/gate-fixtures.ts`), followed by the test's own tag, so a run in one project cannot remove another's. The test removes what its tag made when it ends, pass or fail, through `removeE2eAssessments` (`scripts/lib/e2e-assessments.ts`): attempts first, then their audit rows and the assessment's, then its **notices** (W3b: a notice has no foreign key to its assessment, so they are matched by the key prefix `assessment:<id>:`), then the assessment. A second run leaves the same row counts. A killed run can leave one behind; `KAYEDU_ENV=staging npm run e2e:clean-assessments` sweeps every row under the prefix. Both refuse unless the run may write (`assertSafeToWrite`). **Closed-exam fixtures.** The reveal, extend and access tests insert their exams and final attempts straight into the database (`e2e/support/assessment-fixtures.ts`, `assertSafeToWrite`-guarded), because a browser flow cannot make a window that has already closed. They sit in the seeded student's active class, under the same prefix and the test's tag, and the same teardown removes them (attempts and answers first, then the exam, its questions and options). The one-sitting test needs the app to accept the page's close beacon: when `NEXT_PUBLIC_APP_URL` is set it must equal the origin the browser uses (`E2E_BASE_URL`, default `http://localhost:3000`); otherwise the beacon is refused and the attempt is only finalised on the next read (D-W10). **The same holds in every Vercel environment** (Production, Preview, any staging deployment): `NEXT_PUBLIC_APP_URL` must equal the real host users open — scheme, host and port, no path — or the one-sitting close signal (`/api/assessment-attempts/[id]/close`) answers 403 there. A preview deployment on its own `*.vercel.app` host needs that variable set to it (or left unset, which falls back to the request's own forwarded scheme and host). Nothing breaks if it is wrong — the late-read finalisation still submits the attempt — but a one-sitting exam is then closed later than the student left. **Another app on port 3000?** Set `E2E_PORT` (default 3000) for the run; `playwright.config.ts` reads it.

**The role switcher's fixtures (W5).** `check:people`'s W5 block creates its accounts with email `people-check-exp-…@kayedu.test`, its branches with slug `people-check-exp-…` and its organizations with the same name prefix, under the registered `people-check` stem. It deletes them at the start of a run and in its `finally`. The seed gains nothing. **No seeded account holds several kinds of experience,** so `e2e/experience-switcher.spec.ts`'s multi-kind journey (`@write`, `en-1280` only, since it signs up) signs up an e2e account under the test's own tag and inserts a TEACHER membership and a student profile at Downtown and an ACTIVE family link to `student.new`, straight into the database through the staging guard. Deleting that account (the `e2eTag` fixture, pass or fail) cascades all three; a killed run is swept by `npm run e2e:clean-users`.

**Premium (W6).** `check:admin` §9 creates its accounts as `admin-check-premium-…@kayedu.test` (the target, a bare account, one per centre role at its own throwaway branch, a student and a parent), under the registered `admin-check` stem. Its cleanup, at the start and in the `finally`, removes their `platform.premium.*` audit rows (which name a User, not a centre, so nothing cascades them) before the accounts. `e2e/admin.spec.ts`'s premium journey (`@write`, `en-1280` and `ar-375`) makes its login through the Supabase admin API instead of the register form, so it runs in both projects without spending the 10-an-hour sign-up limit: email `<tag>-premium@example.com`, surname `Premium <tag>`, the `e2eTag` shape, so the fixture (and `npm run e2e:clean-users` after a killed run) removes the User and its login. The test's own teardown removes that User's `platform.premium.*` rows, and deletes the login itself if the account never reached the app. A second run leaves the same row counts. Seeded accounts are never granted premium, and the seed gains nothing.

**Assistants (W7a).** `check:assistants` creates its accounts as `assistants-check-<kind>-<n>-<run>@kayedu.test` (an admin that grants premium through W6's own helpers, premium teachers, assistants, one premium account per centre role, a premium student), one branch `assistants-check-a` and an organization named `Assistants Check <run>`, under the registered `assistants-check` stem. Its cleanup, at the start and in the `finally`, removes their audit rows (`assistant.*` by actor, `platform.premium.*` by the account they name), the branch, the accounts (cascading every invite, link and grant) and their rate-limit buckets (per account, and the run's own fake client addresses). `e2e/assistants.spec.ts` (`@write`, `en-1280` and `ar-375`) makes two logins through the Supabase admin API — `<tag>-teacher@example.com` / `Teacher <tag>` and `<tag>-assistant@example.com` / `Assistant <tag>`, the `e2eTag` shape — gives both a TEACHER membership at Downtown straight in the database (guarded by `assertSafeToWrite`), and the admin grants the teacher premium through the UI. Its teardown removes both accounts' audit rows and the accounts (cascading the memberships, invites, links and grants), and clears the **assistant-join rate buckets**: the local dev server sees every e2e request from one address (`::1`), so three runs in an hour would otherwise use up the 10-an-hour per-IP limit and refuse the fourth. The test asserts nothing of its run is left (the two projects run in parallel, so it checks its own ids, not table totals); two back-to-back runs left the same row counts. A killed run is swept by `npm run e2e:clean-users`. The seed gains nothing.

**Assistants on behalf (W7b).** `check:assistants` §13–20 adds three provisioned branches `assistants-check-b1-<run>`, `-b2-<run>` (one organization `Assistants Check W7b <run>`) and `-x-<run>` (`Assistants Check X <run>`), their classes, sessions, two enrolled students (with phones on file, to prove rosters never show them), exams, an attempt and two change requests. Cleanup now deletes the audit rows of **every** `assistants-check*` branch first (AuditLog has no cascade), then the branches by the slug stem, so a killed run is swept by the next run. **Run it alone**: two copies at once delete each other's fixtures at start (they share the stem). `e2e/assistants.spec.ts` gains a second `@write` journey on the seeded **teacher.downtown**: the admin grants premium through the UI (skipped if a run left it on), a tagged login `<tag>-helper@example.com` / `Helper <tag>` redeems the teacher's invite, builds and publishes an exam titled with the shared assessment prefix + tag + `-w7b` in the teacher's first active Downtown class, files a new-session request, and the **manager** turns Downtown's "Allow teacher assistants" off through Settings → General. Because it changes **shared seed state** (the teacher's `premiumUntil`, Downtown's setting), the two `@write` projects take turns on a lock row `e2e:assistants-w7b:lock` in `RateLimitBucket` (taken over after 15 minutes). The teardown restores `premiumUntil` and the setting to the values read at the start, deletes the exam (`removeE2eAssessments`), the request, the run's invites, its audit rows (the assistant's, the teacher's `assistant.*`, the `platform.premium.*` for the teacher and the manager's `center.settings.update` since the start), the login and the lock, and the test asserts all of it.

**Workspaces (W8a).** `check:workspaces` creates its accounts as `workspaces-check-<kind>-<n>-<run>@kayedu.test` (three premium teachers, a never-premium account, a premium platform admin, an assistant, a student and one account per branch role), one provisioned branch `workspaces-check-branch-<run>` under an organization `Workspaces Check <run>`, two catalogue rows each named `workspaces-check …`, and — under the registered `workspaces-check` stem — the teachers' **personal organizations** and their **PERSONAL workspaces**. A workspace's slug is generated (`ws-<uuid>`), never a fixture stem, so the cleanup finds every workspace through the fixture users' personal organizations (`ownerUserId`), plus the 99 cap-test centres it inserts directly as `workspaces-check-cap-<run>-<n>`. It deletes, at the start and in the `finally`: the audit rows of those centres and users (maintenance mode), the centres (cascading settings, memberships, rooms, classes and sessions), the personal organizations (their owner is `ON DELETE RESTRICT`, so they go before the users), the catalogue rows, then the users. `seed:verify` leaves every PERSONAL centre out of its seed world whatever its owner, so a leftover workspace never fails sections 1, 3, 4 or 7; a leftover fixture **user** is reported in section 8 as usual.

**e2e workspaces (W8a).** `e2e/workspaces.spec.ts` (`@write`, `en-1280` and `ar-375`, one tagged account per project, created through the Supabase admin API) has the admin grant premium in the UI, creates a workspace, a class and its sessions, reschedules and cancels, archives and unarchives, and has the admin revoke premium. Its teardown is `removeE2eUsers(db, tag)`, which since W8a removes the account's PERSONAL workspaces and personal organization first (`removePersonalWorkspaces`, `scripts/lib/e2e-users.ts`: their audit rows, then the centres — cascading membership, room, class and sessions — then the organization), and the test asserts that nothing of its run is left (users, organizations, centres, memberships, classes, sessions, audit rows by its own ids). A second run therefore leaves the same row counts.

**Workspace students (W8b).** `check:workspaces` §13 adds, under the same stem, accounts `workspaces-check-contact-only-…`, `-no-login-…`, `-tenant-local-…`, `-student-two-…` and `-limits-…` (`@kayedu.test`; logins are fake `authId` strings `workspaces-check-auth-…`, never a Supabase user), a limits teacher's workspace, run-unique phones `+2010XXXXXXXX`, and — because a workspace student sits on a **placeholder `User` with no email** — placeholders whose surname starts `workspaces-check-` (about 75 a run: the rate-limit test adds 61). The cleanup deletes them after the centres (their profiles go with the centres): `email` null, `authId` null, surname `workspaces-check…`, no profile and no membership left. Invitations, enrolments and notices cascade with their centres and users. The rate-limit buckets (`workspaceStudentAddPerUser:<id>`, `workspaceInvitePerUser:<id>`) are keyed by the fixture ids and pruned by the limiter.

**e2e workspace students (W8b).** `e2e/workspaces.spec.ts`'s second `@write` test (`en-1280`, `ar-375`) creates two tagged logins through the Supabase admin API (`<tag>-ws-teacher@example.com`, `<tag>-ws-student@example.com`), signs both in, then — staging-guarded (`assertSafeToWrite`) — gives the teacher premium, gives the student a run-unique `User.phone` (sign-up never writes one) and creates the workspace and one class through `createWorkspace` / `createWorkspaceClass`. The teacher types the student as `Typed Pupil <tag>`, so an unlinked placeholder carries the tag in its surname. Teardown is `removeE2eUsers(db, tag)` (the workspace and its profiles, invitations and enrolments go with the teacher's personal organization; the placeholder by its surname; both logins), and the test asserts nothing of its run is left — users, organizations, centres, profiles, invitations, enrolments, notices, audit rows — so a second run leaves the same row counts.

**e2e results (W4).** `e2e/assessment-results.spec.ts` (`@write`, `en-1280` and `ar-375`) inserts its exams and attempts straight into the database through the same guarded helpers (`insertExam`, `insertAttempt`, `findRosterClass` in `e2e/support/assessment-fixtures.ts`), under the shared prefix and the test's tag, on a seeded teacher's class that already has enough active students; it adds no student. A closed exam gets a correct, a wrong and an overdue open attempt, which the results read finalises, and the rest of the class reads as Missed. An open exam gets one attempt in progress, because a closed exam can hold none. The test asserts the teardown left nothing under its tag, and a second run leaves the same row counts: `removeE2eAssessments` removes the attempts, answers and the `attempt.submit` audit rows the read wrote.

**e2e one-time sessions (V9).** The seed gives teacher.downtown no one-time session, so `e2e/teacher.spec.ts`'s `@write` test "a one-time session renders for its teacher…" (`en-1280` and `ar-375`) inserts one straight into the database through `insertOneOffSession` (`e2e/support/session-fixtures.ts`, `assertSafeToWrite`-guarded). It sits at Downtown, a week ahead, 07:00–08:00, with no class and price and cut 0. It is titled `<tag>-one-off`, the tag from `uniqueTag(E2E_USER_PREFIX)` (the shared `e2e` prefix). The teacher opens `/teacher/sessions/<id>`: no error page, the title as the heading, no "Add homework", and the one-time reason shown. The teardown, pass or fail, is `removeE2eOneOffSessions(db, tag)` (`scripts/lib/e2e-sessions.ts`). It deletes only class-less sessions titled with that tag, plus their audit rows, and the test asserts none is left. Two back-to-back runs left identical session counts. A killed run is swept by `npm run e2e:clean-users`, which now removes every class-less session titled `e2e…` first. The seed gains nothing.

- **Cleanup.** A gate deletes its fixtures at the start of a run and again in a `finally`. A gate that is **killed or crashes before the `finally`** leaves them behind; re-running that gate cleans up (it deletes first). Global catalog rows do not cascade with a centre, so a leftover one is visible to every centre.
- **`npm run check:gate-fixtures`** (no database; in CI beside `check:public`) scans `scripts/*-check.ts` and **fails on a fixture stem that is not registered**. Adding a gate means adding its stem to the registry, or `seed:verify` would count its rows as seed data. (The gates still spell their own slug literals; this check, not a shared constant, is what keeps them in step.)
- **`seed:verify` and fixtures.** Sections 1 (baseline), 3 (money), 4 (orphans) and 7 (counts) **leave gate fixtures out**; nothing is weakened for the seed world. Section 8 **"Gate fixtures left behind"** lists them: younger than 30 minutes is a **WARN** (a gate may still be running), 30 minutes or older is a **FAIL** (an interrupted gate left it). `npm run seed:verify -- --strict-clean` fails on *any* fixture, and `check:all` ends with exactly that. Sections 2, 5 and 6 and the SEC-2b invariants stay global: a leftover global catalog row can still fail section 6's name-uniqueness checks until its gate is re-run.
- **Do not run two gates (or a gate and `check:all`) at the same time against one database.** Each gate sweeps, on exit, the relation-less users created since it started (`scripts/lib/gate-db.ts`, `orphanedUsersSince`). A gate that was already running and finishes mid-way through another used to delete that gate's actor user (e.g. `class-periods-check-staff`, which has no membership), so its next audit row failed on the `AuditLog.actorUserId` foreign key. Since the fix the time-window sweep skips users under another registered gate's stem (`otherGateEmailPrefixes`), but overlapping runs still contend for locks and cleanup — run one at a time.
- **Do not run `seed:verify` while a gate (or `check:all`) is running** — a gate's fixtures are legitimately present, and its catalog rows will trip section 6. Run it alone, after the run.

- **The expected teacher nav is one hand-written list.** `EXPECTED_TEACHER_NAV` lives in `scripts/lib/expected-nav.ts` and is imported by `seed-verify.ts` and `permissions-check.ts`. It is deliberately **not** derived from `TEACHER_NAV` (an independent oracle). **A change to the teacher nav (`components/shell/nav.ts`) must update that file in the same change**, or both fail.

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
