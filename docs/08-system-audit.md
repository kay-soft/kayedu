# KayEdu — System audit (SYS)

> The whole-system investigation that follows SEC-2c: every role's journey traced through the code and proven in a headless browser (`npm run e2e`), the architecture and code-health audit, and Vercel deployment readiness. Written against branch `dev`, October 2026. Decisions applied: the class price rule and SEC-62 option (a) (`00-master-product-spec.md` §5.1); dependency majors deliberately not upgraded.

> **Verification policy (DEPLOY-1).** The gate and e2e runs this audit records were one-off, whole-system passes. They are not routine: after a change run only the gates for the touched area plus `tsc` and `eslint`; run `check:all` and `npm run e2e` only on request or before a deployment, and only against a staging database — never against the shared dev project (CLAUDE.md working rule 8).

---

## 0. Verdict

<!-- verdict:start -->
**Ready for new features: yes** — because every role's journey works end to end in both languages at desktop and phone width (`npm run e2e`: **161 passed, 0 failed, 4 skipped by design** — the account-creating journeys run in `en-1280` only), every gate is green (all `check:*` incl. `check:security` and `check:rls`, `tsc`, `eslint`, `prisma validate`, `check:rtl`, `check:design`, `npm run build`), the 17 bugs the audit found are fixed, and nothing left open is a money, isolation or data-loss defect.

**Not ready for a real centre** — that is M20 (§5.2), and three product questions block specific customers rather than new work (§3): a brand-new parent cannot be onboarded (OD-6), a second branch cannot join an organization (OD-12 — decided and delivered at F1), and page/action permission alignment (SEC-73). New features should not start in those three areas until they are answered.
<!-- verdict:end -->

---

## 1. Journeys

Each journey was traced in code (screens → Server Actions → the permission each asserts → what an unhappy path does) and then driven headless by its spec in `e2e/`. "Status" is the e2e result across the four projects (`en-1280`, `ar-1280`, `en-375`, `ar-375`; writes in `en-1280` + `ar-375`, account-creating journeys in `en-1280` only).

<!-- journeys:start -->
| # | Journey | Spec | Status |
|---|---|---|---|
| — | Every role's landing, exact sidebar, every nav item opens (no bounce) | `navigation.spec.ts` | **Pass** in all four projects |
| 1 | Platform admin | `admin.spec.ts` | **Pass** (writes: en-1280, ar-375) |
| 2 | Owner | `owner.spec.ts` (+ navigation) | **Pass** |
| 3 | Manager | `manager.spec.ts` | **Pass** |
| 4 | Receptionist | `reception.spec.ts` | **Pass** (the daily loop needs a live-session window - any hour except the last ten minutes before Cairo midnight) |
| 5 | Accountant | `accountant.spec.ts` | **Pass** |
| 6 | Teacher — one / two / zero centres | `teacher.spec.ts` | **Pass** |
| 7 | Student | `student.spec.ts` | **Pass** (sign-up: en-1280 only) |
| 8 | Parent | `parent.spec.ts` | **Pass** — and the known gap proven (below) |
| — | Account claim, approve and decline (SEC-2a) | `claim.spec.ts` | **Pass** (en-1280 only) |

### 1.1 Platform admin
**Screens:** `/admin/centers` (list + create), `/admin/centers/[id]` (support view: stats, lifecycle, visibility window, recent activity), `/admin/platform` (KPIs), `/admin/catalog`. **Gate:** `requirePlatformAdmin()` on the layout and every action; `lib/db/catalog-admin.ts` re-checks `isPlatformAdmin` per write. **Actions:** `createCenterAction` (centre + one-branch organisation + settings + baseline + founding-owner invitation, one transaction), `transitionCenterLifecycleAction` (the transition table re-validated server-side), `updateCenterVisibilityWindowAction`, the four catalog actions. **Proven:** provision → invite link shown → detail visit writes `platform.support.access` (Recent activity non-empty) → ONBOARDING → ACTIVE → window 45 (persists on reload) → ARCHIVED (terminal); catalog add (both names) → search → delete; KPIs render. **Unhappy paths:** a taken slug → `slugTaken`; an invalid transition is never offered and is refused by the server; deleting a referenced catalog entry → refused with counts, "Deactivate instead". **Findings:** the admin's third nav item rendered the raw key `Nav.catalog` (fixed); archiving — final and irreversible — had no confirmation (fixed: an explicit "archiving is final" tick); dialogs were off-centre in Arabic (fixed). *An organisation cannot be given its own name or a second branch from the admin panel: provisioning always creates a one-branch organisation named after the branch — see NEEDS-DECISION 3 (OD-12).* **F1:** both now exist — the create form names the organization and sets its branch limit, or adds the branch to an existing organization; `/admin/organizations` edits the limit.

### 1.2 Owner
**Screens:** `/select-center` (Whole Management + both branches), every centre page, `/settings` (general: default cut, timeout, late threshold, timezone, edit deadline, **conflict policy**, **visibility window**), `/settings/rooms` (+ combinations), `/settings/payment-methods`, `/settings/terms`, `/settings/catalog` (picks + per-language renames + system price), `/settings/card` (editor), `/settings/permissions` (OWNER-only matrix), `/settings/staff` (invite, role change, branch access). **Gates:** `center.settings.edit` for settings screens; `permission.manage` (ceiling-forced OWNER) for the matrix; `membership.role.assign` / `membership.branch.grant` (OWNER-only) for invites, role changes and branch grants. **Proven:** the hub's three choices; Whole Management → Analytics roll-up; all eight settings screens render with their sub-nav; general settings save; payment method add → deactivate → activate → delete; term add (dates via the calendar) → delete; room add → delete; invite a receptionist (link shown; TEACHER never offered) → revoke; a manager sees no Permissions link and is bounced from its URL. **Unhappy paths:** last active payment method refused; a method in use deactivates instead of deleting; a room in a combined set or used by any session (the whole history — SEC-62 "integrity") refuses deletion. **Findings:** revoking an invitation is one tap (reversible by re-inviting — listed, not changed).

### 1.3 Manager
**Classes:** New class dialog — weekly rows, period (term or custom dates), primary room + combinable extras (R3), select or **create a teacher inline** (one transaction), live conflict preview, WARN needs "I understand, create anyway". **Proven:** a class with a brand-new teacher on Hall A + Hall B, conflicts confirmed, created; then deleted (never ran) and its teacher deleted. **Sessions:** New session (one-time) → detail → Reschedule (a new, linked session) → View the new session → **Cancel (now confirmed)** → a second pristine one-time session → Delete (confirmed) → back to the list. **Also proven:** classes/students/teachers/sessions detail pages open from their lists and their back links return; approvals, settlements, analytics, expenses, refunds, audit render; expense add → void with a reason. **Gates:** `class.manage`, `session.manage`, `session.cancel`, `teacher.manage`, `student.manage`, `approvals.manage`, `settlement.manage`, `analytics.center.view`, `expense.manage`, `payment.refund`, `audit.view` — each page asserts exactly its nav item's permission (proven for every role by `navigation.spec.ts`; also `check:permissions`). **Unhappy paths:** DENY refuses a conflict outright; a class that ran or has enrolments cannot be deleted (deactivate instead); cancel/reschedule refused while active payments exist (D-07). **Findings:** Cancel session was a one-tap irreversible action (fixed); deactivating a class was one tap — it cancels future sessions that carry records, which reactivation does not restore (the settled R4 rule) — it now asks first and says so (fixed).

### 1.4 Receptionist
**Screens:** `/reception` (Find a student; today's session cards with Start attending / End session / View receipt), `/sessions` + detail, `/students` (Register student + phone lookup), `/dashboard`. **Gates:** `reception.use`, `attendance.record`, `payment.record`, `session.close`, `student.manage`, `session.view`. **Proven:** the desk renders and a search finds a seeded student; a new student registered; **session mode** on a live one-time session (created by the manager) → search → confirm panel → Check in (attendance + payment in one action, Present/Late from the clock) → the roster's correction buttons are **disabled for the receptionist** (no `attendance.correct` / `payment.void` by default) → the **manager** switches the paid student to Absent with a reason → the payment is voided ("Payment voided" on the receipt) → the receptionist **ends the session** (confirmed, irreversible) → the closed banner and the voids section show → the print view renders. Profit pages (`/analytics`, `/settlements`, `/refunds`, `/expenses`, `/approvals`, `/settings`) all refuse the receptionist by URL (criterion 9). **Unhappy paths (gated by `check:reception`):** a card from another branch, a blocked or inactive student, an already-checked-in student, a closed/cancelled session in session mode. **Findings:** none in the code; the "absent-switch with void" belongs to whoever holds `attendance.correct` + `payment.void` — the receptionist only if the owner grants both (configuration, `00` §8 "configurable behaviour").

### 1.5 Accountant
**Proven:** dashboard, analytics and expenses open; settlements, refunds, sessions, reception, students, settings and audit all refuse by URL. The baseline is analytics + expenses only (spec §3); settlements "as granted" is the matrix (`settlement.manage`), not a code change.

### 1.6 Teacher
**One centre** (`teacher.downtown`): dashboard (average-only rating), sessions (forward-looking), a session's detail with its note — the hint now states the branch's real edit deadline (it claimed none existed) — students, classes (request form), approvals (own queue), settlements — all render, no bounce. **Two centres** (`teacher.shared`): the hub lists both; switching sets the active branch (named in the shell; in the drawer on a phone). **Zero centres** (`teacher.new`): the root shows the hub (whose "Find a branch to teach at" leads to the directory) and any `/teacher/*` URL goes straight to `/teacher/centers`, never Discover; the "Request to teach here" form expands, cancels. **Gates:** `actionContext("teacher")` on every teacher action; `changeRequest.create`, `reservation.manage.own`, `student.block`, `analytics.own.view`. **Unhappy paths:** one pending teach-here request per branch (`alreadyRequested`), refused to anyone already teaching (`alreadyTeaching`), rate-limited (D-18).

### 1.7 Student
**Proven:** a seeded student lands on the schedule with the **rating pop-up** (closing persists nothing; Skip exists); Discover and reservations render; a student with no centre sees their pending request. **Self-registration:** sign up → the hub's empty state → Browse classes → Discover → **Enroll** (instant) → the layout substitutes the **one-time profile completion** → grade + phone → the schedule. **Gates:** `requireStudentUser()`; `reserveOrEnroll` re-checks blocks, capacity, the 7-day cooldown (`coolingOff` with the retry date), D-18 caps and rate limits. **Findings:** none.

### 1.8 Parent
**Proven:** `parent.family` lands on `/parent` (**fixed** — it landed on a dead-end hub), switches between its two verified children through the child selector (URL `?child=`), and the mirror offers no write control; `parent.nokhba` sees one child. **Known gap — not a bug (D-03 (d), OD-6):** a brand-new parent cannot be onboarded. Proven end to end: signing up with a seeded student's parent phone originates a **PENDING** link only (no phone is stored on the account — D-02), the new parent's portal says "No verified children yet", and on the student's page the staff **Verify** is disabled ("Verification is turned off until a safe method is decided"). Nothing moves a link to VERIFIED today; that is OD-6, still blocked on OD-2.

### 1.9 Account claim (SEC-2a, D-01)
**Proven, both outcomes:** a receptionist registers a student **with an email**; a person signs up with that email → `/account-pending` ("Your account is waiting for a branch"); the manager's `/approvals` shows the claim → **Approve**: signing in again lands in the student portal as that student; **Decline**: signing in again lands on the hub's empty state as a new, separate person. The claim leaves the queue at once (revalidation).

### 1.10 Cross-cutting checks run on every visited page
One `h1`; no error boundary; no raw `Namespace.key`; `<html dir>` matches the locale; no console `MISSING_MESSAGE`, hydration error or page error. The language toggle keeps the route and query string. A suspended centre's owner resolves no branch and gets the hub's empty state.
<!-- journeys:end -->

---

## 2. Bugs fixed

| # | Where | What was wrong | Fix |
|---|---|---|---|
| 1 | Admin sidebar | `Nav.catalog` did not exist: the platform admin's third nav item rendered the raw key "Nav.catalog" in both locales (console `MISSING_MESSAGE` on every admin page). | Key added (en "Catalog", ar "الكتالوج"); `check:rtl` now resolves every literal `t()` key and nav `labelKey`. |
| 2 | New session dialog (one-time mode) | Ten labels (subject, grade, price, cut type, both cut values, both shares, percentage/fixed) called `Classes.<key>` where the keys live under `Classes.fields.<key>` — raw keys on screen. | Keys corrected. Caught by the new `check:rtl` resolution. |
| 3 | Parent landing | A parent with verified children (no centre relation) was sent by sign-in and by `/` to the branch hub, which said "not connected to a branch" with no route to `/parent` — a dead end. | `homeWithoutBranch` (`lib/auth/tenant.ts`): root, sign-in and the hub send them to `/parent`. e2e asserts it. |
| 4 | Every dialog, Arabic, ≥ 640 px | `sm:start-1/2` + `sm:-translate-x-1/2`: `start` resolves to `right` in RTL while the translate is physical, so every dialog sat half its width left of centre. | Symmetric insets + auto margins. `check:design` guards the pattern; e2e measures the dialog's centre. |
| 5 | Dialog close button | `aria-label="Close"` hard-coded English. | `Shared.close` in both locales. |
| 6 | Session detail — Cancel session | One irreversible tap (End and Delete both confirm). | Confirmation dialog ("Cancel this session?"). |
| 7 | Teacher session note | Card said "No edit deadline is enforced yet" — M10 enforces `teacherEditDeadlineHours`. | The hint states the branch's actual setting. |
| 8 | Branch hub empty state | Its title appeared twice (card description + empty-state title). | Description dropped in the empty state. |
| 9 | Student page, parent accounts | Hint said a parent appears "once a staff member verifies them" — verification is off (D-03 (d)). | Hint states pending + verification off. |
| 10 | Class form copy | "only new sessions use the new numbers" — wrong after the price decision. | Both locales updated. |
| 11 | `check:people` | The rate-limiter fixture could straddle a fixed one-minute window (~1 run in 8 fails). | Fixture waits for ≥ 15 s of window; assertion unchanged. |
| 12 | Admin — archive a branch | ARCHIVED is terminal (00 §5.1) yet the lifecycle form archived on one tap. | An explicit "I understand archiving is final" tick before the button enables. |
| 13 | Classes list — Deactivate | One tap cancels every future session that has records, and reactivation does not bring them back (R4). | Inline confirmation that says exactly that. |
| 14 | Invite page | Its expiry date had its own inline `Intl.DateTimeFormat` — a second date formatter (CLAUDE.md rule 10). | `formatDate` (`lib/format.ts`). |
| 15 | Vercel build | No `prisma generate` on install; Vercel's cached `node_modules` would build against a stale client after a schema change. | `"postinstall": "prisma generate"`. |
| 16 | Eight write transactions | Expense create/void, reschedule, NEW_SESSION approval and four enrolment seat claims ran on Prisma's 2 s / 5 s defaults — a check-in rush could fail them. | `WRITE_TRANSACTION_OPTIONS`; `check:security` `SYS-TX`. |
| 17 | Four hot queries | Sequential scans: payments by session, attendees by student, the audit trail newest-first, reservations by student. | Four additive indexes (§4.6). |

The money-rule change (the price decision) and SEC-62 are decisions, not bugs — see §4.

---

## 3. NEEDS-DECISION

<!-- decisions:start -->
None of these was changed by SYS: each changes a product rule, a permission or who-may-do-what, which CLAUDE.md says to decide rather than assume. Each is already in a register (`00` §2.2 or `07` §1.1) so it cannot be lost.

| # | Question | Why it matters | Options | Register |
|---|---|---|---|---|
| 1 | **How does a brand-new parent get a verified child?** (OD-6, D-03 (d)) — **DECIDED at F3** | ~~Today no new parent can ever reach the portal~~. **F3:** a parent links with a **one-time code** — from the child (Account → Family → Invite a parent) or printed by the branch on the student's page — at `/family/join`; a phone grants nothing. `e2e/parent.spec.ts`'s known-gap journey became the code journey (generate at the branch, link, unlink). | Chosen: (a) the centre-issued code **and** (c) the student's own code, both one-time, hashed, no expiry; (b) OTP stays a possible extra factor later (`05` entry 12). | `00` §5.1 "Parent role & portal" (OD-6 left the register) |
| 2 | **Should a page and its actions assert the same permission?** (SEC-73) | `/settings/staff`, the student block actions and the Add-teacher dialog check different permissions from their page. Not an escalation, but the screen can show a control the action refuses (or hide one it would allow). | (a) The page asserts the union of its actions' permissions and every control hides itself without its own; (b) split the page by permission; (c) record the difference as intended. The Add-teacher dialog giving an existing staff member a TEACHER role belongs to the same answer. | `07` §1.1 SEC-73 (OPEN) |
| 3 | ~~**How does a second branch join an organization?** (OD-12)~~ **Decided at F1: (a) + (b), with an admin-set branch limit** (`Organization.maxBranches`). The admin's create form gained "Add to an existing organization"; an Owner adds branches up to the limit from Settings → Branches; OD-3 still prices a branch. Recorded in `00` §5.1 "Branch architecture". As asked at SYS: | Provisioning always creates a new one-branch organization named after the branch. Nothing adds a branch to an existing one, so Whole Management, branch grants and every organization-level feature exist only for the seed. Blocks onboarding any multi-branch centre. | (a) The admin's Create-a-branch form gains "new / existing organization" and an organization name of its own; (b) an Owner self-serve "Add a branch" (needs a price per branch — OD-3); (c) leave it seed-only until the first multi-branch customer. | `00` §5.1 (was §2.2 OD-12 — decided F1) |
| 4 | **When does the e2e suite run in CI?** | `npm run e2e` signs in as seed accounts; CI has no seeded database. Until it runs in CI a regression in a journey is caught only by running it by hand. | (a) At M20: the staging Supabase project, seeded with `npm run db:seed`, with `SEED_PASSWORD`/`SEED_ADMIN_PASSWORD` as CI secrets — run on every pull request to `main`; (b) a nightly job against staging only (cheaper, slower feedback); (c) keep it a manual pre-release step. Recommended: (a). | `00` §2.1-C; `03` M20 |
| 5 | **Should revoking an invitation ask first?** (minor) | One tap, but reversible — the owner re-invites and a new link is shown. Listed rather than changed because every other one-tap action in Settings is reversible the same way. | (a) Keep; (b) add the same confirmation the destructive actions use. | — (UX only; no rule) |

**Not decisions, recorded so they are not mistaken for gaps:** the receptionist cannot switch a paid student to Absent — that needs `attendance.correct` + `payment.void`, which an OWNER may grant in the matrix (`00` §8 "configurable behaviour"); reactivating a class does not restore sessions its deactivation cancelled (the R4 rule — the confirmation now says so); dependency majors (Prisma 7, ESLint 10, TypeScript 7, `@types/node` 26) were deliberately not upgraded in SYS.
<!-- decisions:end -->

---

## 4. Architecture findings

<!-- architecture:start -->
### 4.1 Layering

- **Pages and components never call `prisma.<model>` (fixed).** Nine reads in pages and a route handler — the invite page, the platform admin's centre view (centre, audit trail, settings), the analytics roll-up's per-branch settings, the Approvals name fallbacks (users, catalog subjects/grades), the student layout's rating pop-up labels, the Discover and teacher-directory centre lists, the logo route — moved behind `lib/db/platform.ts`, `lib/db/catalog.ts` and `lib/db/identity.ts`. Pages still import the shared `prisma` client *to pass it in* — that is the dependency-injection seam (`02` §5), not a violation.
- **`lib/db/scoped.ts` now takes its client by parameter** (`scopedWith(client, ctx)`), with relative imports, like every other `lib/db` module — the gates call the real helpers.
- **Server Actions** follow `getTenantContext → permission → zod → scoped write → audit → revalidate` (the SEC-1/SEC-2c sweeps; `check:security` asserts the permission half for every action). Remaining direct, explicitly `centerId`-filtered reads inside actions — listed, not moved (they are the action's own pre-checks and already scoped): `admin/centers/actions.ts` (platform-admin, deliberately global), `(auth)/actions.ts` (invitation by token), `reception/actions.ts` (a student profile by code), `settings/staff/member-actions.ts` (invitation revoke on demotion), `student/profile/actions.ts` (the student's own profile), `teacher/approvals/actions.ts` (the reservation, pinned to the teacher's class), `teacher/centers/actions.ts` (centre and catalog lookups, plus the advisory lock).
- **Result shape.** Form actions return `{ status } | { error: key } | { fieldErrors }` consistently (125 actions); data functions return `{ ok }` unions. Documented in `02` §7 as built — a rename to a literal `{ ok }` shape across 125 actions and their forms would be churn with no behaviour.

### 4.2 Single owners

Grepped for second implementations of: money (piastre math, the cut), phone normalisation, formatting (`Intl` outside `lib/format.ts`), "today" (`check:timezone` already sweeps), session labels, catalog labels, room-set rules, the class-sessions engine, the session lifecycle, initials and ID-card parsing.

- **Fixed:** the invite page's inline `Intl.DateTimeFormat` → `formatDate`; the ID card's own initials (photo placeholder, logo fallback) → `lib/initials.ts` (card output byte-for-byte unchanged — `check:card-layout`'s golden SVG).
- **Clean:** money, phone, today, session labels, catalog labels, rooms, the engine, the lifecycle, card parsing — one owner each.

### 4.3 Raw SQL

Every site is a tagged template or a `Prisma.sql` fragment with bound values; interpolated SQL text is only ever a constant fragment from the same file; no `$queryRawUnsafe` in `app/` or `lib/`. The refreshed inventory is `07` §2.5 (the SEC-1 table had drifted). Search tokens strip `% _ \` (SEC-61). **No identifier is built from input anywhere.**

### 4.4 Transactions

Every money, attendance, seat and session-lifecycle transaction now runs with `WRITE_TRANSACTION_OPTIONS` (`maxWait` 10 s / `timeout` 20 s). **Fixed:** the expense create and void (which `02` §7 already claimed), reschedule, NEW_SESSION approval and the four enrolment seat-claim paths ran on Prisma's 2 s / 5 s defaults. No transaction makes a Storage, e-mail or other network call (the photo/card storage writes run after their DB write, outside it). `check:security` `SYS-TX` pins the fixed sites.

### 4.5 Errors

- **Fixed:** ten best-effort `.catch(() => undefined)` / `.catch(() => null)` sites (deleted-student photo and card clean-up, replaced and removed photo clean-up, confirmation resend, parent-link origination at sign-up, the logo route, the ID card's logo inline, the rate limiter's two catches) now log one line through `lib/log.ts` — still never failing the request, never silent, never quoting arguments.
- Remaining `catch {}` blocks are deliberate parse fallbacks (unknown timezone → Cairo, `safeNextPath`, time parsing in zod) or browser-only UI conveniences (clipboard copy, `getBBox`).
- Throws: only `PermissionError`, `SessionClosedError` (caught by the four attendance actions), `ClassSessionsRefusedError` (caught inside the engine), Next's `redirect`/`notFound`, and re-thrown unexpected errors after a known Prisma code is mapped.

### 4.6 Performance

- **Indexes (fixed):** read-only `EXPLAIN` on the dev database showed four hot queries scanning: `Payment` by `sessionId` (every receipt filtered all the centre's payments; the foreign key had no index), `SessionAttendee` by `studentProfileId` (absence streak, history), `AuditLog` newest-first per centre (sorted the whole trail), `Reservation` by `studentId`. Migration `20261019090000_sys_hot_query_indexes`, additive, applied with `migrate deploy`; `migrate diff` is empty.
- **N+1:** `npm run perf:queries` counts SQL statements per page request (second load, `KAYEDU_QUERY_LOG=1`). Results in §4.6.1 — **no N+1 found**: no statement shape repeats more than 7 times on any page, and none of the repeats grows with the rows shown (they are the per-request auth/tenant resolution and independent loaders).

#### 4.6.1 SQL statements per request (seeded dev data, second load)

The counts include Prisma's pgbouncer wrapper — every query over the pooled URL is `BEGIN` / `DEALLOCATE ALL` / *query* / `COMMIT` (`02` §14) — so roughly 55–60 % of each figure is wrapper, not work.

| Page (account) | Statements |
|---|---|
| `/dashboard` (manager) | 70 |
| `/reception` (receptionist) | 60 |
| `/sessions?range=week` (manager) | 103 |
| `/students` (manager) | 43 |
| `/teachers` (manager) | 39 |
| `/classes` (manager) | 84 |
| `/analytics?range=month` (manager) | 71 |
| `/approvals` (manager) | 92 |
| `/settlements` (manager) | 36 |
| `/audit` (manager) | 61 |
| `/teacher/dashboard` (shared teacher) | 32 |
| `/student/schedule` (student) | 79 |
| `/parent` (two-child parent) | 44 |

Flat in the data. The cheapest future win is not a loader but the wrapper itself (a direct, non-pgbouncer connection for read-heavy routes, or Prisma 7's driver adapters) — a dependency-major question deferred with the others.

#### 4.6.2 DB round trips per request - Cairo -> Frankfurt (PERF)

**Why dev is slow.** Every logical Prisma query is one pooler round trip of ~112 ms from Cairo (`DATABASE_URL` is the Supavisor **transaction pooler**, `aws-0-eu-central-1.pooler.supabase.com:6543`, `?pgbouncer=true&connection_limit=10&pool_timeout=20` - confirmed, unchanged), plus a ~56 ms `SELECT 1` each time the client opens a pooled connection. So page time is roughly *serial depth x 112 ms*; the number of queries matters far less than how many of them wait on each other. Two more Supabase Auth calls (~100 ms each) sit on top and are deliberately kept (`02` section 14).

**Instrumentation (dev only).** `KAYEDU_DB_STATS=1` (`lib/db/client.ts`) prints `[kayedu:db] <ms>ms <sql>` per statement and a `request:` summary (queries, statements, summed ms, wall ms) once the database goes quiet. Never active in production. `npm run perf:db` starts its own dev server, loads each route twice as the **owner** over plain HTTP (the saved `e2e/.auth/owner.json` session plus the Downtown branch cookie - no browser), and prints the warm load's queries, statements, summed statement time, wall time and the statement shapes ranked by total ms (`DB_TIMING_DUMP=1` lists every query in order, `DB_TIMING_ONLY=<label>` narrows, `DB_TIMING_JSON=<file>` saves). There is no standalone Payments route: payments are recorded and shown on session detail and student detail, which is what is measured.

**Where the time went (before).** The per-request auth/tenant resolution was a chain of six dependent hops (`User` -> `Membership` -> `Center` -> `StudentProfile` -> `CenterSettings` -> `PermissionGrant`) before any page query started, and several pages then ran their own second and third stages. The ranked shapes per route were dominated by that resolution (`User`, `Membership`, `Center` x2-4 each, every page) and by Prisma's per-level `include` loads (`CenterCatalogSelection` x7, `CatalogGrade` x4 on the schedule; `Room`/`ClassGroupRoom` on class detail). No N+1: a shape repeats only where independent loaders each resolve the same lookup, and none grows with the rows shown.

**Fixes (no behaviour change; no schema, migration, money or permission-semantics change; per-request `cache()` only - nothing tenant- or permission-shaped is cached across requests).**

| Change | Saves |
|---|---|
| `buildContext` (`lib/auth/tenant.ts`): `CenterSettings` and `PermissionGrant` loaded together | 1 serial hop on **every** page |
| `resolveCenterRelations` (`lib/auth/relations.ts`): the student-profile read starts with the membership read instead of after it | 1-2 serial hops on every page |
| Class detail: the class lookup, its teacher and the 11 lists in one stage | ~3 hops |
| Sessions list: the "New session" picker data in the list's own stage | 1 hop (for who may create) |
| Student detail: card SVG and photo URL with the lists; absence streaks with the block lookups | 3 hops |
| Session detail: absence streaks and the add-student search in one stage | 1 hop |

Already correct, left alone: `getTenantContext`/`getUserCenterRelations`/`getCurrentUser`/`getAuthUser` were already `cache()`d, so a layout and its page share one load; the lazy end-of-day close (`closeEndedSessions`, `closeSessionIfDayOver`) must finish before the reads it affects, so it stays first.

**Before / after** (owner, warm second load, seeded dev data, one run each - expect +-5 % noise; counts move by +-3 with the lazy-close sweep, the gain is serial depth, not volume):

| Route | Queries | Wall ms |
|---|---|---|
| `/dashboard` | 33 -> 33 | 3708 -> 3401 (-8 %) |
| `/reception` | 26 -> 25 | 3685 -> 3707 (noise) |
| `/students` | 17 -> 17 | 2866 -> 2622 (-9 %) |
| `/classes/[id]` | 46 -> 47 | 4803 -> 3141 (-35 %) |
| `/sessions?range=week` | 52 -> 55 | 4707 -> 3328 (-29 %) |
| `/sessions/[id]` (payments) | 50 -> 53 | 6318 -> 6026 (-5 %) |
| `/students/[id]` (payments) | 32 -> 31 | 3823 -> 3577 (-6 %) |
| `/settlements` | 14 -> 13 | 2522 -> 2089 (-17 %) |

**What is left, and why it was not done here.** (1) Prisma loads each nested `include`/`select` level as its own query; `relationLoadStrategy: "join"` (the `relationJoins` preview feature, a `generator` flag in `schema.prisma`) would turn those chains into one query each - the biggest remaining win (session detail, schedule, class detail), but it is a schema-file change and a Prisma-behaviour change, so it needs an explicit go-ahead. (2) The ~56 ms `SELECT 1` per newly opened pooled connection is a property of the pooled URL; a warm production instance reuses connections. (3) In production the app runs in Frankfurt next to the database, where every hop is a few ms - this work matters mainly for Cairo-side development.

#### 4.6.3 E2E is independent of the wall clock (PERF)

Three time dependencies were removed from the suite - none was a product bug (the centre's calendar day is Cairo's, and the app correctly refused a session "in the past"):

1. **"Today" in the date picker was the UTC date** (`dayFromToday`, `e2e/support/ui.ts`). Between 00:00 and 03:00 Cairo the UTC date is still yesterday, so the reception daily loop picked yesterday and the form refused it. It now computes the Cairo date.
2. **The manager "detail pages" test opened `/sessions`, which defaults to today.** On a day with no classes (a Friday, a holiday) or once the seeded history ages out of the default view the list was empty. It now opens the list through `?range=range&from=<today-30>&to=<today+30>` (relative, so no seed change) and clicks the first session.
3. **The reception test skipped itself outside 00:30-22:30 Cairo.** Its live session now runs from `now-15 min` (clamped to 00:00) to `now+45 min` (clamped to 23:59) on the Cairo date, so any hour works; it skips only after 23:49, when a live session cannot outlast the run - a physical limit, not a date one.

No assertion was weakened.

### 4.7 Dead code

Removed 20 exports referenced nowhere (not even their own file): `assertCan`, `findAttendeeById`, `classDisplayName`, `listBranchGrantsForMembership`, `matchedFields`, `toPiastres`, `looksLikePhone`, `combinationPairs`, `resolveDateRangeUtc` (+ its private `yearRangeUtc`, `DateRangeKind`), `centerIdSchema`, `parsePageSizeParam` (+ `MAX_PAGE_SIZE`), `requiredPhone`, and seven unused types. Removed 16 message keys nothing reads, static or dynamic (e.g. `Auth.errors.emailInUse`/`phoneInUse` left by SEC-40, `Analytics.emptyState`, `Students.moreResults`). ~170 other exports are only used inside their own module — harmless, kept.

### 4.8 Docs-vs-code drift (fixed in the docs)

`02` §1 promised RLS policies on tenant tables (deny-all since SEC-2a); `02` §2 listed a `settings/visibility/` route that does not exist and omitted eight `lib/db` modules; `02` §3 claimed "merge is a manual, audited admin action" — **no merge exists** (now backlog entry 24); `02` §4's `TenantContext` lacked `experienceDenied`/`rollupOrganizationId`; `02` §8 still described native `<input type="time">` (gone since R6); `02` §14 said analytics uses Prisma `aggregate`/`groupBy` (raw 64-bit sums since SEC-2b) and named `parsePageSizeParam` (never called); `01` §3 promised "the manager can still edit a specific session's price" (no such editor; the price rule is now the SYS decision); `01` named `classDisplayName`/`toExistingScheduleSlots`; `07` §2.5's raw-SQL table had drifted; `dev-accounts.md`'s nav table lacked Audit trail. Each is corrected.

### 4.9 Gate coverage map

Behaviours with no gate before SYS, and what now covers them:

| Behaviour | Now gated by |
|---|---|
| A class price edit reprices open, payment-free sessions only; payments untouched; audited | `check:class-periods` §10 |
| The visibility window in the scoped helpers, per centre-side role, by id and in lists | `check:visibility` (SEC-62 block) |
| One storage seam; signed URLs only | `check:security` `SYS-STORAGE` |
| Every literal message key / nav label exists | `check:rtl` |
| No RTL off-centre dialogs (logical inset + physical translate) | `check:design` |
| Money/seat/lifecycle transactions carry the write budget | `check:security` `SYS-TX` |
| Each role lands on its home, sees exactly its nav, every nav item opens (no bounce), no missing translation or console error — en/ar × 1280/375 | `npm run e2e` (`navigation.spec.ts`) |
| The parent lands on the parent portal | `npm run e2e` |
| The account-claim journey, approve and decline | `npm run e2e` (`claim.spec.ts`) |

Still ungated (none is a money or isolation rule): the confirmation dialogs themselves (Cancel/End/Delete — exercised by e2e but not statically pinned), `center.branding.edit`/`platform.manage` having no call site (SEC-15 note), and the visual layout at 375 px beyond "renders, no horizontal page error" (a real-device pass is still manual).
<!-- architecture:end -->

---

## 5. Deployment readiness (Vercel + an image host later)

<!-- readiness:start -->
### 5.1 Checklist

| Item | State |
|---|---|
| `npm run build` | **Passes** — 83 routes, no server/client boundary error, no type error. |
| Serverless constraints | **Met** — no in-memory state across requests (the rate limiter is Postgres), no filesystem writes, the longest transaction (the class-sessions engine) has a 20 s budget, no heavy import on a cold path, region `fra1` next to the database (`02` §16). |
| Prisma connections | **Ready** — `DATABASE_URL` is the pooled transaction-mode URL (`6543`, `pgbouncer=true&connection_limit=10&pool_timeout=20`), `DIRECT_URL` the session-mode URL that `migrate deploy` uses (`02` §16). **Fixed:** the client is now generated on install (`postinstall: prisma generate`) — Vercel restores a cached `node_modules`, so a schema change would otherwise build against a stale client. Migrations stay a separate, deliberate step, never part of the build. |
| Environment inventory | **Done** — every variable the code reads, where, whether required and whether it may reach the browser: `02` §16 and `.env.example`. Only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `NEXT_PUBLIC_APP_URL` are public. |
| Storage seam | **Done** — `lib/storage` (`StorageProvider`: `configured`, `upload`, `signedUrl`, `download`, `remove`, `lastModified`) with one Supabase adapter; every caller goes through `storage()`. Buckets stay private; files are served only through short-lived signed URLs. `check:security` `SYS-STORAGE` refuses a second Storage client or a public URL. |
| An image host later | **One new adapter**, no caller change: implement `StorageProvider` (e.g. for a CDN-backed image host), select it in `lib/storage/index.ts`, keep URLs signed or otherwise access-controlled (students' photos are minors' data — OD-2). Nothing was added for one in SYS. |
| Indexes | Four hot-query indexes added (§4.6), migration applied with `migrate deploy`; `migrate diff` against the schema is empty. |
| Dependency majors | **Not upgraded** (decision): Prisma 7, ESLint 10, TypeScript 7, `@types/node` 26. |

### 5.2 What M20 still has to do before the first real centre

1. **Domain** (OD-1) and `NEXT_PUBLIC_APP_URL` per environment.
2. **Email:** a real sender, password reset, Supabase *Confirm email* on, and `REQUIRE_EMAIL_CONFIRMATION=true` (start-up refuses production without it). Remove the `ALLOW_AUTO_CONFIRM_DEMO` demo override if it was used (DEPLOY-1).
3. **Abuse:** CAPTCHA on sign-up and sign-in (D-18), Supabase leaked-password protection.
4. **Observability:** Sentry (server + client) and an `app/global-error.tsx`.
5. **CSP:** move from report-only to enforced.
6. **Staging:** a dedicated Supabase project, seeded; CI secrets (`DATABASE_URL`, `DIRECT_URL`, seed passwords); the database gates **and `npm run e2e`** in CI (NEEDS-DECISION 4).
7. **Production database:** `migrate deploy`, then `check:rls` against it; `PRODUCTION_PROJECT_REFS` so the seed and the wipe refuse it; delete the legacy auth users.
8. **Backups:** confirm the plan's point-in-time recovery and run one restore test.
9. **Vercel:** the variables of `02` §16 per environment (server-only ones never `NEXT_PUBLIC_*`), region `fra1`, and the pooler sized for `connection_limit × concurrent instances`.
10. **Data export** (OD-4) and the **legal review of minors' data** (OD-2) — OD-6 itself was decided at F3 on the founder's call, subject to that review.
11. An image host, if wanted, as a new `lib/storage` adapter (above).

### 5.3 Observed, not changed

During e2e runs the dev server logs `Error: The destination stream errored while writing data` when the browser navigates away mid-stream (a test moving on before a streamed RSC response finishes). It is Next's dev-server noise about an aborted response, never surfaced to a page, and no test fails on it.
<!-- readiness:end -->
