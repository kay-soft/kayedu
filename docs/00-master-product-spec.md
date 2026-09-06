# KayEdu — Master Product Spec (Phase 1)

> **Status:** Working draft, Phase 1 scope. This document is the single source of truth. When the note, the blueprint PDF, and this document disagree, **this document wins**. Update this file first, then code.
>
> **Owner:** KAY-SOFT (Founder/Dev + Business partner)
> **Product:** KayEdu — multi-center education management platform
> **Last updated:** Phase 1 kickoff

---

## 1. What KayEdu is (in one paragraph)

KayEdu is a **multi-tenant, web-based ERP for private education centers** in Egypt, with connected portals for teachers, students and (as of M16) parents. An **organization** — the paying customer — runs one or more **branches**, and each branch runs its daily operations through it: students, classes, sessions, attendance, per-session payments, teacher settlements, expenses, and analytics. Teachers and students each have **one KayEdu identity** that can connect to multiple centers. Phase 1 is the operational foundation; Phase 2 (mobile apps, homework, exams, grades, AI assistance, and everything else in [`05-phase-2-backlog.md`](./05-phase-2-backlog.md)) builds on top of it later and is **out of scope for now**.

---

## 2. Locked decisions (do not re-litigate without updating this file)

These are settled. They shape the schema and the whole build.

| Area | Decision |
|---|---|
| **Tech stack** | Next.js (App Router) + TypeScript, PostgreSQL via **Supabase** (Auth + Storage + Postgres), Prisma ORM, Vercel hosting (Frankfurt region), shadcn/ui, Tailwind, `next-intl` for i18n. |
| **Tenancy** | **Single shared database**, isolated by `center_id` on every tenant-scoped table. **Not** database-per-center. Adding a center = insert a row + upload a logo, no code changes. |
| **Organization & branches** | An **`Organization`** is the paying customer; a **`Center`** is one branch under it and stays the tenant. `center_id` remains the **sole isolation key** — the org layer adds roll-up and cross-branch role grants, and changes nothing about how isolation is enforced. See §5 "Branch architecture". No limit on branches per organization. |
| **Naming (UI vs. DB)** | The UI says **"Branch"** where the DB says `Center`, and **"Center"** where the DB says `Organization`. Resolved **entirely in the i18n layer** — a full DB rename is Phase 2 (`05-phase-2-backlog.md` entry 18). |
| **Branding** | Per-center logo, name, and theme color — a **theming layer** separate from data isolation. |
| **Identity** | One global `User` per person. Their relationship to a center is a separate **Membership** (role-scoped). Attendance, payments, enrollments hang off the membership/enrollment, never the raw user. |
| **Permissions** | A **configurable action-level permission matrix** covering every role × every action (§3). Deny-by-default and server-side enforcement are non-negotiable. **Only OWNER** may grant roles or permissions. |
| **Academic catalog** | Subjects, grades and education systems are **platform-owned global catalog** entries, each with an Arabic and an English name. Centres pick from the catalog and may *suggest* additions into a review queue; a centre edits only its own display name and prices for a picked entry. Person names stay single-valued and never vary by locale. |
| **Financial model** | **Pay-per-session only.** Recorded at the desk (offline). No online payment gateway in Phase 1. |
| **Center's cut** | Configured on the class as **`PERCENTAGE`** (a percent of the collected amount) or **`FIXED`** (the exact piastre amount of the session price the **centre** takes). Each education system carries a **configurable default fixed centre share** used when a class is set to FIXED, overridable per class and per session. Framed centre-side on purpose — see §5 "Center cut". |
| **Refunds** | **Cash-back only, no student balance.** A recorded payment can be marked `REFUNDED`: the original row is preserved and a refund record is written, permissioned and audited. Void and refund are **different things** (§5). |
| **Teacher settlements** | A settlement/payout record with **DRAFT → APPROVED → PAID** and no partially-paid state, totalled **from frozen snapshots only**. Supports both a single session's teacher share and a period roll-up. |
| **Data visibility window** | By default **no centre-side role may read data older than 1 calendar month**. Platform admin bypasses; per-centre configurable. A **read restriction, never a deletion**, enforced in the data layer. Settlements and audit logs are carved out. See §5. |
| **Center lifecycle** | `ONBOARDING / ACTIVE / GRACE / SUSPENDED / ARCHIVED`, replacing the `active` boolean. **`Center.plan` is removed entirely** — no plans, no module entitlements. |
| **Student debt** | **Does not exist** in Phase 1. No "owes money" balances. Attend = pay, or not counted. |
| **Prepaid / packages / discounts / monthly subscriptions** | Not in Phase 1. Schema stays flexible so they *can* be added later, but nothing is built for them now. |
| **Drop-in attendance** | Supported. A student can attend a session **once without being enrolled**, or be a regular enrolled student. |
| **Payment methods (recorded, not processed)** | Cash (default), InstaPay, Wallet, Visa. |
| **Notifications** | **Deferred.** In-app only later; no SMS/WhatsApp cost in Phase 1. The notification layer is designed so WhatsApp/SMS plug in later without rework. |
| **Languages** | Arabic + English, full **RTL** support, from day one. |
| **Check-in methods** | ID card with QR **and** manual search by student code / name / phone. All available. |
| **Session generation** | Recurring schedules generate individual session instances on a **rolling window** (~4–6 weeks ahead), with per-session cancel/reschedule and a holiday calendar. |
| **Offline resilience** | No full offline mode in v1. Resilient optimistic UI + retries so a brief internet drop doesn't lose data. A scoped **offline reception loop** is planned **post-pilot** (M21) and only if Center 60's real connectivity justifies it — see the open decision in §2.2. |
| **Deployment gate** | Nothing goes to production until there's a signed contract with the first center. |

---

## 2.1 Pre-deployment checklist

> The **Deployment gate** above says *when* we may deploy. This section says *what must be closed out first*. Everything listed here is a **deliberate development shortcut** standing in for a production requirement — each one is fine right now and unacceptable in front of a paying center. Nothing ships to production until every box is ticked. Add to this list the moment a new shortcut is taken; a shortcut that isn't written down here is a shortcut that gets forgotten.
>
> Referenced from `02-architecture.md` §13 (Deployment).
>
> **Ownership (added with M11–M21).** Every unticked box below is now owned by **M20 — Pre-deployment** (`03-build-order.md`), which exists so this checklist stops being a list nobody is assigned to. Two boxes also depend on §2.2 open decisions: the transactional email sender is blocked on **OD-1** (domain), and data export's scope on **OD-4**. Two entries below are also going to change shape: the `Center.plan` editor that `check:admin` currently asserts on is **removed entirely at M19** (§5.1 "Centre lifecycle"), and `Center.active` becomes a five-state lifecycle in the same milestone — the gate is updated with them, not left asserting on a dropped column. **Data import** is no longer a pre-deployment item at all: it moves to `05-phase-2-backlog.md` entry 10, while **export stays here** and ships in M20.

### A. Auth & email

- [ ] **Re-enable Supabase email confirmation.** Currently **disabled** so dev accounts can sign in instantly (Supabase dashboard → Authentication → Providers → Email → *Confirm email*). The code path already exists — `signUpAction` returns `status: "emailConfirmationRequired"` and `Auth.register.confirmEmail` is translated in both locales — so this is a dashboard toggle, not a code change. Until it is on, **anyone can register with an email address they do not control.**
- [ ] **Wire a real transactional email sender** (e.g. Resend) once we own a domain, with SPF/DKIM configured. Today staff invite links are **copy/paste-shared manually** by the inviter (`02-architecture.md` §3, `createInvitationAction` → `InviteForm`), which is correct for Phase 1 and unworkable for a real center inviting a dozen staff. Same sender covers password reset and any future notification use. Note: this is **delivery plumbing**, not the deferred notifications feature (SMS/WhatsApp stay out of scope per §6).
- [ ] **Enable leaked-password protection** in Supabase Auth (HaveIBeenPwned check) — currently off.
- [ ] **Rotate / retire the seeded demo credentials.** `prisma/seed.ts` creates real Supabase Auth users — with `email_confirm: true` and the password from `SEED_OWNER_PASSWORD` (default `KayEdu!Dev123`) — for the owner, the manager, the receptionist, the first demo teacher, and the first demo student, all sharing that one password, so every role can be signed into and tested. **`npm run db:seed` must never run against production.** The first real owner is provisioned through the admin panel + invite flow (M9), not the seed.
- [ ] **Set `NEXT_PUBLIC_APP_URL`** to the real origin per environment (it is `http://localhost:3000` in dev).

### B. Data & tenant security

- [ ] **Give the RLS backstop real policies.** RLS is *enabled* on every table but **zero policies exist**, so PostgREST access is denied outright (safe by accident) while Prisma connects as a role that bypasses RLS. `02-architecture.md` §5 layer 2 asks for actual per-tenant policies. Before production: write the `center_id ∈ caller's memberships` policies, and confirm the Prisma connection role is **non-superuser**. **M10: drafted**, not yet applied — `supabase/m10-rls-and-storage.sql` writes the policies (and the three helper functions below) for every tenant table, deliberately outside `prisma migrate dev`/`deploy` since this is security-sensitive SQL against a live project. Review it, then run it once by hand (Supabase SQL Editor or `psql "$DIRECT_URL" -f supabase/m10-rls-and-storage.sql`) before checking this box.
- [ ] **Remove or lock down `public.rls_auto_enable()`** — a `SECURITY DEFINER` function currently executable by both `anon` and `authenticated` via `/rest/v1/rpc/rls_auto_enable`. Revoke `EXECUTE`, switch it to `SECURITY INVOKER`, or drop it. **M10: drafted** in the same `supabase/m10-rls-and-storage.sql` (revokes `EXECUTE` if the function exists) — same "review, then run by hand" note as above.
- [ ] **Service-role key hygiene.** `SUPABASE_SERVICE_ROLE_KEY` lives in the local `.env` for the seed. In production it exists only as a Vercel server-side env var — never `NEXT_PUBLIC_*`, never in a client bundle. Already correct in code today (nothing references it as `NEXT_PUBLIC_*`); this stays an ongoing operational discipline, not a one-time fix.
- [ ] **Create the remaining Storage buckets + policies.** `avatars/` and `id-cards/` exist as of M3 — private, size/MIME limited, paths namespaced by `centerId`, with `storage.objects` policies mirroring tenant isolation (`02-architecture.md` §10). `logos/` (center branding) and `session-uploads/` (teacher uploads) are provisioned in `supabase/m10-rls-and-storage.sql` (M10), same shape — pending the same manual review-and-run as the RLS policies above. The three `SECURITY DEFINER` helpers those policies read (`kayedu_member_center_ids`, `kayedu_write_center_ids`, `kayedu_own_student_profile_ids`) are defined in the same file: each takes no arguments, filters on `auth.uid()`, and grants `EXECUTE` to `authenticated` only.
- [ ] **Backups + a *tested* restore**, and a privacy/legal review before handling minors' data (`02-architecture.md` §12). Needs a live project and legal/product sign-off this session cannot provide.

### C. Operations & pipeline

- [ ] **Run the acceptance gates in CI**, not by hand: `npm run check:isolation` (cross-center by id, M1), `npm run check:config` (center configuration, M2), `npm run check:people` (teachers, students, blocks, identity matching and storage paths, M3), `npm run check:classes` (classes, schedules, conflicts, session generation, session lifecycle, M4/M10), `npm run check:payments` (snapshot immutability, FIXED/PERCENTAGE splits, drop-ins, void-then-recreate, consecutive absence, attendance-correction audit, cross-center isolation, M5/M10), `npm run check:analytics` (revenue/expense reconciliation, by-teacher breakdown, cross-center isolation, receptionist profit-denial, M6) `npm run check:teacher-portal` (shared-teacher two-center zero-leakage, combined-dashboard union correctness, per-center StudentBlock scope TEACHER regression, M7), `npm run check:student-portal` (instant-enroll vs. requires-confirmation branching, capacity enforcement, duplicate-reservation prevention, both StudentBlock scopes, reject-then-re-request row reuse, cross-center isolation on a student's own reservations/enrollments, M8), `npm run check:approvals` (ChangeRequest/Reservation accept-decline correctness, NEW_SESSION session creation, RECEPTIONIST denial, cross-center isolation on the pending queue, M8.5/M10), `npm run check:admin` (center provisioning/activate-suspend/plan-edit, platform-KPI reconciliation, support-access audit shape, M9), `npm run check:performance` (rush-attendance concurrency, M10, criterion 14) and `npm run check:rtl` (en/ar parity, logical-CSS-only, M10, criterion 15). `02-architecture.md` §5 requires them as gates. **M10: the workflow is wired** (`.github/workflows/ci.yml` — typecheck/lint/`prisma validate`, then `migrate deploy` + all twelve gates), but it still needs `DATABASE_URL`/`DIRECT_URL` repo secrets pointed at a dedicated CI/staging Supabase project before it can actually run — a GitHub-side action, not something this session could provision.
- [ ] **Migrations via `prisma migrate deploy` in CI** — never `migrate dev` against a deployed database. **M10: wired** in `.github/workflows/ci.yml`, same secret-provisioning caveat as above.
- [ ] **Error monitoring** (e.g. Sentry) wired before the pilot. Not started at M10 — needs a Sentry account/DSN this session doesn't have; scaffolding the SDK config without a real project to point it at seemed lower-value than the other gaps closed this pass.
- [ ] **Session-generation cron registered on Vercel.** The generator itself (`lib/db/sessions.ts`) and its HTTP entry point (`app/api/cron/generate-sessions/route.ts`, guarded by a `CRON_SECRET` bearer check) land with M4 — the rolling window does not materialize itself until a `vercel.json`/`vercel.ts` `crons` entry actually calls that route on a schedule (docs/02-architecture.md §11), and `CRON_SECRET` must be set in the Vercel project's env vars. Until then, the manual "Generate sessions" buttons on `/classes` and a class's detail page are the only trigger. Not started at M10 — needs a live Vercel project.
- [ ] **Data import/export** paths for onboarding and responsible offboarding (§7 criterion set / M10). Not started this pass — a CSV export would have fit, but a half-built import/export pair (export without import, or either without the duplicate-matching review a real import needs) seemed worse than punting the whole thing cleanly for a dedicated pass.
- [ ] **Manually verify live cross-center identity behavior once 2+ real centers exist.** `npm run check:people` proves duplicate-matching (including matching on a contact that lives only on another center's local record) and independent per-center name/contact editing against throwaway fixture centers — but only one real center is seeded today (`prisma/seed.ts`), so this has never been exercised with real staff, real data, or real timing. Once a second real center is onboarded: register/add a person already known to the first center and confirm the match panel finds them and links correctly; rename or re-contact that person at one center and confirm the other center's record — and the person's own portal login — is unaffected (`01-data-model.md` §6).

### D. Code-level shortcuts

- [x] ~~`.dark` block in `app/globals.css` is stock shadcn placeholder values~~ — removed (2026-09-01). Dark mode is not part of `04-design-system.md`; `@custom-variant dark` stays only because the stock `components/ui/button.tsx` still carries inert `dark:` utility classes.
- [ ] **Nav items marked `disabled: true`** in `components/shell/nav.ts` are milestone placeholders that render as "Soon". Every one must be either implemented or removed before a center sees the app.
- [ ] **Run through all 15 acceptance criteria in §7** (M10) — this checklist is the *infrastructure* gate; §7 is the *product* gate. Both must pass. **M10: 14 of 15 are automated** across the ten `check:*` gates (see the CI item above for the full mapping) — criterion 15 (RTL) is automated via `check:rtl`'s static analysis, which is as far as static checks (CLAUDE.md rule 1: no browser testing) can go; a real click-through in both locales on real devices is still a manual pass, and is explicitly the step **after** this milestone (the comprehensive seeded multi-center/multi-role manual testing pass), not part of it.

---

## 2.2 Open Decisions register

> §2 records what is **settled**. This section records what is **not** — every question still open that will change what gets built, who owns answering it, and where it stands. An open question that lives only in someone's head is the same failure mode §2.1 exists to prevent, one level up.
>
> **Rules.** One row per decision. A decision that gets answered moves out of this table and into §2 (if it locks behavior), §5 (if it is a business rule), `05-phase-2-backlog.md` (if the answer is "later"), or §2.1 (if it becomes a pre-deployment task) — it never just gets deleted, and it never stays here with the answer written in the status column. `Status` is one of **Open** (nobody is working it), **In progress** (actively being resolved), or **Blocked** (waiting on something named).

| # | Decision | Why it matters | Who decides | Status |
|---|---|---|---|---|
| **OD-1** | **Domain purchase** — which domain KayEdu runs on, and when it is bought. | Blocks the transactional email sender (SPF/DKIM need a domain we own, §2.1.A), `NEXT_PUBLIC_APP_URL` per environment, and any subdomain-per-center branding (`02-architecture.md` §4). It is the first item in M20 for that reason. | Business partner (purchase) + Founder/Dev (DNS, Vercel wiring) | Open |
| **OD-2** | **Privacy / legal review for minors' data** — what Egyptian law requires of us for students under 18: consent, retention, parental access, breach duty. | Almost every record in this system belongs to a minor. It gates production entirely (§2.1.B, `02-architecture.md` §12), and it directly shapes M16: whether a parent may see a child's data at all, and on what basis. | Business partner, with external legal counsel | Open |
| **OD-3** | **Contract terms with the first pilot centre** — pricing, term, support obligations, data ownership, exit/offboarding. | The **deployment gate** (§2) is literally "nothing ships until this is signed." Data-ownership and exit terms also set the scope of OD-4. | Business partner + Founder/Dev | Open |
| **OD-4** | **Data export scope** — what a centre can export, in what format, on demand vs. at offboarding, and whether it includes another centre's view of a shared person. | M20 ships export as a pre-deployment requirement, so its scope has to be decided before then. The shared-person question is the hard one: a teacher at two centres must not have Centre A's export reveal Centre B's data — the same boundary M12's teacher-detail fix defends. | Founder/Dev (feasibility) + Business partner (contractual promise) | Open |
| **OD-5** | **Demo centre branding** — what name, logo and theme colour the demo tenant uses in owner meetings. | The demo is the sales instrument; per-tenant theming is the trick that sells it (`02-architecture.md` §9). Using a real centre's branding without permission is not an option, and a placeholder that looks unfinished undercuts the demo. Also affects what M18's seed rewrite creates. | Business partner | Open |
| **OD-6** | **Parent ↔ child verification mechanism** — exactly how a phone number claimed as a parent phone becomes a verified parent account. | **A phone match alone must never grant access** (§5 "Parent role"). The candidates are: centre staff approving the link from the student's profile, an OTP to the parent phone (`05-phase-2-backlog.md` entry 12), or a one-time code the centre hands the parent. Until this is answered, M16 can build the role, the child selector and the portal, but **not** the account-creation path. | Founder/Dev (mechanism) + Business partner (what a centre will actually operate) | **Blocked** on OD-2 (whether parental access is even permissible in the shape we assume) |
| **OD-7** | **Does Center 60's connectivity justify offline mode?** — whether the reception loop actually loses writes on their real internet, often enough to justify M21. | M21 is honestly expensive: this app has **no client data layer today**, so scoped offline means building one (`03-build-order.md` M21). Building it speculatively is the worst outcome; discovering the need after the pilot fails is the second worst. | Founder/Dev, on evidence from the pilot | **Blocked** on the pilot running (measure real drop frequency and duration during a rush before deciding) |

---

## 3. Roles & permissions

**Six roles at Phase 1 kickoff, eight now** — and only some of them are database enum values, which is where the old "six hardcoded roles" wording quietly misled. Two counts exist and both are correct:

- **`Role` (the Prisma enum) = centre memberships only.** `OWNER`, `MANAGER`, `RECEPTIONIST`, `TEACHER`, and — as of **M12** — `ACCOUNTANT`. These are the values a `Membership` row can hold.
- **`TenantRole` (the resolved context type) = the enum plus the two relationships that are not memberships**: `STUDENT` (a `StudentProfile`, not a `Membership`), `PLATFORM_ADMIN` (the global `User.isPlatformAdmin` flag), and — as of **M16** — `PARENT`. This is what `can()` is keyed on (`02-architecture.md` §6).

So: **five membership roles, eight resolved roles.** Whenever a doc says "roles," it means the resolved set unless it names the enum.

| Role | Kind | Scope | Core capability |
|---|---|---|---|
| **Super Admin (KayEdu)** | `User.isPlatformAdmin` | Platform | Create/suspend center tenants, platform KPIs, support, audit, review academic-catalog suggestions. Never browses tenant data casually. Bypasses the data-visibility window (§5). |
| **Owner** | `Membership` | **Organization** — every branch under it | Full control: money, staff, config, everything a Manager can do + ownership actions. **The only role that may grant roles or permissions**, and the only one that may widen another member's branch access. |
| **Manager** | `Membership` | One branch (unless the Owner grants more) | Runs the branch: teachers, classes, students, sessions, analytics, expenses, config, approvals, delete rights, teacher-edit deadlines. |
| **Receptionist** | `Membership` | One branch (unless the Owner grants more) | Daily ops: reception desk, check-in, record attendance + payment, add students, view today's sessions. **Cannot** see center profit/settlement unless granted. |
| **Accountant** *(M12)* | `Membership` | One branch (unless the Owner grants more) | Baseline: **analytics + expenses**. Everything beyond that baseline is configurable through the matrix like every other role. Deliberately *not* given staff management, class management or attendance rights by default. |
| **Teacher** | `Membership` | One or more centers | Their own schedule, sessions, students, analytics/earnings, request new classes/sessions, block students, approve students joining their classes. Only sees data for centers they belong to. Membership scope is unchanged by the org layer. |
| **Student** | `StudentProfile` | One or more centers | Discover/reserve classes, see personal schedule, enrollments, own attendance history, rate sessions they attended. |
| **Parent** *(M16)* | `ParentLink` | One or more children, at whatever centers those children attend | A child selector plus a per-child mirror of the student portal. Read-only. Never a superset of what the child can see. |

**From hardcoded map to configurable matrix (M12).** Phase 1 shipped a hardcoded `Record<TenantRole, Permission[]>` plus exactly two boolean grant columns on `CenterSettings`. That is replaced by a **stored, action-level permission matrix**: every role × effectively every action in the app, editable per centre. The invariants survive the change unchanged:

- **Deny by default.** An action with no explicit grant is denied. A new action added to the codebase is denied to everyone until someone grants it.
- **Server-side is authoritative.** `can()` on the client only hides controls; the loader/action check is the boundary (`02-architecture.md` §6).
- **Only OWNER grants.** Granting a role, changing the matrix, or widening a member's branch access are OWNER-only actions, and every one of them is audited.
- **Grants widen, never narrow.** A configured matrix cannot hand a role something the platform forbids for that role (a TEACHER can never be granted `center.profit.view`), and cannot be used to strip an OWNER of ownership actions.

**Permission rules that matter:**
- A Receptionist seeing **center profit** is **denied by default**.
- A Teacher sees their **own earnings/analytics by default** — no center grant needed. A teacher's own session earnings are not `center.profit.view`; that distinction is load-bearing and documented in `02-architecture.md` §6.
- Attendance **corrections**, **financial corrections**, **refunds** and **settlement transitions** require elevated permission and are **audited**.
- Teacher's **deadline to edit a session** is set by the center manager (a center setting).
- **Delete** of teachers/students is a Manager/Owner action, not Receptionist.
- **Changing a user's role invalidates or re-resolves their session immediately** (§5, security fix 17) — a demoted user must not keep their old rights until their cookie happens to expire.

> Full permission matrix (action × role) lives in `02-architecture.md` §6. This section is the intent.

---

## 4. The four experiences & their screens

### 4.1 Center (Owner / Manager / Receptionist / Accountant) — the ERP

A navbar **branch switcher** ("Whole Management" = all branches of the organization, or a specific branch). Who sees what in it follows §5 "Branch architecture": an **Owner** sees every branch under their organization plus the all-branches roll-up; a **Manager / Receptionist / Accountant** sees the one branch their membership names, or the several the Owner has granted them, and sees the roll-up only when they hold more than one. Selecting a specific branch sets the active `centerId` — the same cookie mechanism that already exists — so every screen below stays exactly as `centerId`-scoped as it is today. The roll-up is **analytics only**; no operational screen ever spans branches.

0. **Auth** — login/register. Owners/Managers/Receptionists are **invited by email**. Teachers & Students self-register.
1. **Dashboard** — today's sessions, attendance status, KPIs, outstanding operational items.
2. **Teachers** — add/edit/delete teacher (first/last name, phone, alt phone, email, active flag); teacher detail with all their classes; teacher block-list (block students from joining them).
3. **Classes** — add/edit class (subject, grade, education system, price, one-or-more class times, room, education type/configurable price, **center-cut config**, capacity, attendance-required flag + late threshold, accepts-new-students, requires-confirmation); remove/block students; filterable dashboard.
4. **Students** — add/edit/delete student (name, email, phone, alt phone optional, grade, parent name/phone/alt, assign to teacher+subject+class optionally); enrollment view showing which teachers/subjects the student is in, with **per-week attendance history** per teacher/subject; **bulk grade promotion** (Manager); **print as ID card / print as paper**.
   > **Corrected wording (was "promote grade at term end").** This document promised a term-end trigger while **no `Term` or `AcademicYear` entity exists anywhere** in `prisma/schema.prisma` — an internal inconsistency, now fixed in both directions. What is shipped, and what this item means, is a **manual, staff-initiated bulk promotion**: a Manager selects a grade and promotes its students, whenever the centre decides its year has turned. There is no automatic trigger and no term boundary to hang one on. The missing entity is recorded as `05-phase-2-backlog.md` entry 11, along with everything else waiting on it (term-scoped analytics, automatic promotion, report cards). Do not re-introduce "at term end" phrasing anywhere until that entity exists.
5. **Analytics** — filters (Day / Week / Month + specific-date and range pickers, §5 "Date filters"; by teacher). Revenue: total, teacher share, center share, expenses, net, averages. Users: total/new students, total/active/new teachers. **Org-level roll-up (M11):** an Owner (or anyone holding more than one branch) can view one branch or **all branches** — the roll-up is a union of per-branch `centerId`-scoped queries summed in memory, exactly the shape the teacher dashboard already uses, never a query spanning centres in the database. **Refunds are subtracted** from collected revenue and from that payment's centre/teacher shares (§5 "Refunds"). Reads are bounded by the data-visibility window (§5).
6. **Expenses** — manage categories; add expense (category, amount, date); same date filters. Also the Accountant's home ground: baseline ACCOUNTANT holds analytics + expenses and nothing else (§3).
7. **Sessions** — dashboard of today's sessions (filterable to week/month, by teacher/subject/class/status). Session detail: info panel + enrolled roster (shows if class-specific), add student (existing or new; one-time or enrolled), mark attendance → confirm payment method → session receipt (total, center share, teacher share, attendance count, absentees with consecutive-absence counts). Block/remove student from session.
8. **Reception Desk** — the fast check-in surface: search by student code / name / phone, add new student, select session + payment method + attendance status, today's sessions marked live, add-session button.
9. **Approvals** — review teacher-submitted class/session requests **and student enrolment requests**: accept/decline/contact/edit-and-confirm. **From M15** this screen is where a centre approves a student's request to join one of its classes, under the rules in §5 "Approvals & enrolment" — the block check on both `StudentBlock` scopes, the room-capacity hard cap, and the 7-day cooling-off after a rejection. Teachers get their **own** approvals page for students joining *their* classes (§4.2 item 6), a separate queue from this one. **Delivered** (`/approvals`, closing the gap flagged at M6/M7/M8): a combined queue of every PENDING `ChangeRequest` (types `NEW_CLASS` and, as of **M10**, `NEW_SESSION`) and every PENDING `Reservation` at the active center, OWNER/MANAGER only (`approvals.manage` — not in RECEPTIONIST's baseline or grantable set, spec §7 acceptance criterion 9's denial shape). Accept/decline only, all entity types; **contact** and **edit-and-confirm** are deliberately not built — see the M10 punt reasoning in `03-build-order.md`'s Approvals section (no messaging entity exists anywhere in this app, and neither entity type has an obvious "what would you edit" shape).
   > **Decision: accepting a `NEW_CLASS` `ChangeRequest` flips its status; it does not auto-create a `ClassGroup`.** The request payload (`lib/validation/teacher.ts`'s `classRequestSchema`: subject/grade/day/time/capacity/attendance settings) carries no price, center-cut config, or room — all mandatory `ClassGroup` fields only a center decides, and money can never be guessed at (CLAUDE.md rule 2). Accepting means "yes, go create this class"; staff then create the real class at `/classes` manually, reading the approved request's details off the Approvals screen. Accepting a `Reservation`, by contrast, **does** immediately act — it calls the same `confirmReservation` (M8) that creates the `StudentProfile` (if needed) and the `ACTIVE` `Enrollment`, because a reservation already carries everything an enrollment needs (an existing `ClassGroup`); there is no missing-data problem to defer. A `NEW_SESSION` `ChangeRequest` (M10) is the same shape as a `Reservation`, not a `NEW_CLASS` one: it names an **existing** `ClassGroup`, which already carries everything a real `Session` needs — price, center-cut, room — so there is nothing left for a center to decide that a `NEW_CLASS` request is still missing. Accepting immediately creates the `Session` (`lib/db/approvals.ts`'s `resolveSessionRequest`), re-running the exact same teacher/room conflict check the session generator itself uses (`findSessionConflicts`, against every other class's sessions on the requested date) and respecting the center's own `scheduleConflictPolicy` — WARN creates the session flagged with the conflict, DENY refuses it outright — the identical rule `rescheduleSession` (spec §7 criterion 11) already applies to a manually-moved session. No money, room, or scheduling decision is ever guessed at here; the only thing "accept" adds beyond a `NEW_CLASS` accept is that there's nothing left to add.
10. **System Configuration** — **Academic catalog picker (M13)**: Education Systems, Grades and Subjects are no longer centre-authored rows. A centre **picks** entries from the platform-owned global catalog and may **suggest** a missing one into a review queue a platform admin resolves; for a picked entry the centre edits only its own **display name and prices** (including the education system's **default fixed centre share**, §5 "Center cut"). Every catalog entry carries an Arabic and an English name and renders in the active locale. Rooms (number + capacity) stay centre-authored and now belong to the **centre directly**, not to a branch (§5 "Branch architecture"). **Permissions matrix** (M12, OWNER-only) — the action × role grid that replaces the two grant toggles, plus role assignment and cross-branch grants. **Teacher Timeout** (days of no completed sessions until inactive, or none). **Card Customization** — a **visual ID-card layout editor** (§5 "UX & data integrity"): drag, resize, add from a palette, remove with ×. A centre never sees JSON. **Data visibility window** — the per-centre override of the 1-month default (§5). Users & Roles (invite by email or add existing user by email).
11. **Teacher settlements (M14)** — the payout register: a teacher's payable, **derived from frozen `teacherShareSnapshot` values and never recomputed**, as either a single session's share or a period roll-up. `DRAFT → APPROVED → PAID`, no partially-paid state. Permissioned and audited. Deliberately visible **outside** the data-visibility window — a teacher must always be able to verify they were paid (§5).
12. **Refunds (M14)** — marking a recorded payment `REFUNDED` (cash back to the student; **no balance is ever created**). The original `Payment` row is preserved untouched and a refund record is written alongside it. Permissioned and audited. Distinct from a void — see §5 "Void vs. refund".

### 4.2 Teacher portal (cross-center)

0. **Auth** — one login, connects to multiple centers.
1. **Analytics** — filter by center/time/grade: total earnings, total sessions, unique students attended.
2. **Sessions** — search by student; filter date/status/grade; session detail (grade, attendance, absent, earning, center earning, print); future sessions; edit session description (subject to the center's **edit-deadline** setting as of M10 — `CenterSettings.teacherEditDeadlineHours`, `null` = no deadline); **request new session** (center, free room + time, grade, subject) — **delivered at M10** (`/teacher/sessions`'s request card, a `ChangeRequest` type `NEW_SESSION`, resolved at `/approvals`); block student.
3. **Students** — search by code/name/phone; detail shows all sessions this student attended **with this teacher**; block student.
4. **Classes** — request new class at a center where they're a trusted teacher (grade, subject, timing/date range or semester, attendance settings + late threshold, capacity); remove/block students. "Trusted teacher" is a real, per-teacher, center-configurable flag as of **M10** (`Membership.isTrustedTeacher`, default `true` — a manager toggles it on a teacher's own profile); both request forms are hidden and refused when a center has it off.
5. **Upload files for sessions** — placeholder, details TBD later.
6. **Approvals (M15)** — the teacher's own queue: students requesting to join **their** classes, accept or reject. Separate from the centre's `/approvals` queue (§4.1 item 9) and governed by the same rules in §5 "Approvals & enrolment" — the same block checks, the same capacity cap, and the same 7-day cooling-off on a rejection.
7. **Centre directory (M15)** — for a teacher who belongs to **no** centre yet. They browse centres and request to teach a session or a class at one, pending that centre's approval. **A teacher with no memberships must never land on the student Discover screen** — that was the old fall-through and it is wrong (§5 "Teacher onboarding").
8. **Ratings received** — the aggregate students have given them, as an **average out of 5 only**. The teacher can **never** see who rated them, and never sees the count (§5 "Teacher ratings"). The rating follows the teacher across centres.
9. **Settlements (M14)** — what this teacher has been paid and what is outstanding, read from the same settlement records §4.1 item 11 describes. Always readable regardless of the data-visibility window.

### 4.3 Student portal

0. **Auth** — one login, connects to multiple centers. As of **M8**, a student's very first center connection is made *through* this portal — Discover is the self-serve mechanism (docs/02-architecture.md §3 "students by discovery/enroll"), so a brand-new sign-up with zero relations anywhere can still reach `/student/discover` and make their first reservation/enrollment (`requireStudentUser()`, `lib/auth/tenant.ts`).
1. **Sessions** — filter by date; past + future; session detail visible inline. **Delivered at M8** (`/student/schedule`): upcoming sessions come from active enrollments, past sessions come from the student's own `SessionAttendee` history (so a drop-in attendance shows up too), unioned across every center the student has a `StudentProfile` at (`getStudentContexts`, mirroring the teacher dashboard's per-center union, M7). Read-only, as the spec requires — a student never marks their own attendance/payment.
2. **Discover & Classes** — browse/enroll in classes, with **teacher-side validation** (does the teacher auto-accept new students or require confirmation). **Delivered at M8** (`/student/discover`, docs/04-design-system.md §10): a marketplace-style grid across every active center, filtered by subject/grade (matched by *name*, since `Subject`/`Grade` were center-local master data — a class card's subject id had no meaning across two centers) and by day of week. **M13 removes that constraint**: with a platform-owned catalog, a subject id *does* mean the same thing everywhere, so the name-matching workaround (and the "fetch every centre's classes and filter in memory" that follows from it, `02-architecture.md` §14) can finally be replaced with a real scoped `where`. Respects `ClassGroup.acceptsNewStudents`, both `StudentBlock` scopes (TEACHER and CLASS), and capacity. `requiresConfirmation = false` writes an active `Enrollment` directly; `true` writes a PENDING `Reservation` (`/student/reservations` lists a student's own PENDING/CONFIRMED/REJECTED/CANCELLED requests, across every center, with a cancel action for their own PENDING ones).

3. **Rate your sessions (M17)** — a **skippable** pop-up on login: the sessions this student attended in the **last 7 days**, each rated 1–5. Skipping costs nothing and is never nagged into a blocker. What the ratings become is in §5 "Teacher ratings".
4. **Self-registration profile (M18)** — a student who signs up themselves gets a **full profile page**, not a stub: name, grade, email, phone, alt phone, parent name/phone/alt phone, password. The same fields a receptionist would have filled in, filled in by the student.

> **Confirming a reservation now has a UI.** The gap flagged here at M8 (and at M6/M7 for `ChangeRequest`) is closed by the **Approvals** screen (spec §4.1 item 9, `/approvals`): `lib/db/reservations.ts`'s `confirmReservation`/`rejectReservation` are called from there now, not just from the gate script.

### 4.4 Super Admin (KayEdu platform)

Create/activate/suspend center tenants; move a centre through its **lifecycle states** (`ONBOARDING / ACTIVE / GRACE / SUSPENDED / ARCHIVED`, §5 — there are no plans and no module entitlements); controlled privileged support access; platform KPIs (active centers/teachers/students, sessions, adoption); audit sensitive actions; **own the global academic catalog** and resolve centre suggestions into it (§5 "Global academic catalog"); adjust a centre's **data-visibility window** (§5). A platform admin **bypasses** the visibility window entirely.

**Delivered at M9** (`/admin/centers`, `/admin/centers/[id]`, `/admin/platform`, gated by `requirePlatformAdmin()` — `lib/auth/tenant.ts`, unchanged since M1): **Center tenant management** — `createCenterAction` provisions a Center + its CenterSettings row (percentage cut 15%, 10-minute late threshold, Cairo timezone — the same defaults `prisma/seed.ts` uses) + a founding-Owner `Invitation` in one nested write (`lib/db/platform.ts`'s `createCenterWithSettings`), mirroring how `configureCenter` provisions a fresh center's config at M2: no per-center branching, one call does the whole thing. The invite link is shared manually by the platform admin, reusing the exact `/settings/staff` invite-link mechanism (email delivery stays out of Phase 1 scope, docs/02 §3) — without it a freshly created center would have no member able to reach `/settings/staff` to invite anyone, ever. `/admin/centers` lists every tenant with staff/teacher/student counts (`platformCenterList`) and an activate/suspend toggle (`setCenterActiveAction`); `/admin/centers/[id]` adds a `Center.plan` editor (`updateCenterPlanAction` — a free-text field, not a billing system, per the schema) and per-center stats. **Platform KPIs** (`/admin/platform`): active/suspended center counts, total teachers, total students, total sessions, and an adoption trend (centers created per month, last six months) — every figure through an aggregate/`groupBy`/`count` (`lib/db/platform.ts`), never fetch-and-sum, the same discipline M6 established. **Privileged support access**: every visit to a center's `/admin/centers/[id]` detail page writes an `AuditLog` row (`action: "platform.support.access"`, `centerId` of the tenant viewed, `actorUserId` of the admin) before anything renders — a read-only view, not a full masquerade/impersonation system, which is enough for Phase 1 (docs/03-build-order.md M9). **Global reference data**: nothing concrete needed it yet — skipped rather than inventing scope, per this section's own instruction. Gated by `npm run check:admin` (`scripts/admin-check.ts`) — center creation/activation/suspension/plan-edit through the real `lib/db/platform.ts` functions, platform KPIs reconciled as a delta against a possibly non-empty database (these functions are deliberately **not** `centerId`-scoped — a platform admin spans every tenant by design), per-center list/detail stats reconciled exactly, and every support-access view asserted to write exactly one audit row.

### 4.5 Parent portal (M16)

A fifth experience, and the narrowest one. A parent signs in and gets:

0. **Auth** — one login, from a phone number a student has listed as their parent phone. The account is **not** created by the phone match alone; see §5 "Parent role & portal".
1. **Child selector** — one parent, potentially several children, potentially at different centres.
2. **A mirror of the student portal, per child** — that child's schedule, sessions, attendance history, enrollments and payment history, read-only.

The parent portal is **never a superset of what the child can see**. If a screen is not in §4.3, it is not in the parent portal either. It adds no write path of any kind: a parent cannot enrol, reserve, cancel, rate, or edit anything.

---

## 5. Resolved business rules (Phase 1)

**Identity & duplicates.** One `User` per person, keyed on verified phone/email. Registering an existing person at a new center creates a **new membership/enrollment**, never a duplicate person. Duplicate-matching + merge is a defined workflow (details in data model).

**Contact details are center-local (revised, M3).** `User.email`/`User.phone` are the person's **global auth credentials** — how they sign in, set once. What a center has on file for a teacher or student (their phone, alt phone, email as *that center* knows them) is a **separate, center-local record** on `StudentProfile`/`Membership`, always editable by that center regardless of whether the person is shared elsewhere. Duplicate-matching on add/register checks **both**: the global `User` contacts and every center's existing local contact record, because a person may have been entered somewhere with a contact that never made it onto their global `User`. No match → create the person (the entered contact seeds the global `User` at that one moment) and the center's own local record. A match → link a new membership/profile to the existing person and write the entered contact as this center's local record only, touching nothing global. Full detail in `01-data-model.md` §6.

**Money — the sacred rules.**
- Charge basis = **one session**. Price comes from the class (or session override).
- The **center's cut** is configured on the class as either `FIXED` or `PERCENTAGE`. Teacher share = collected amount − center cut.
- **Snapshot at payment time.** When a payment is recorded, freeze `price`, `center_share`, and `teacher_share` onto the payment row. **Never recompute historical money from current settings.** If a class's cut changes later, past payments keep their old numbers. **Every rule below leaves this one untouched** — settlements, refunds and the per-education-system default all read or produce snapshots, none of them recompute one.
- No debt: if a student didn't pay, there's no balance — they're simply an unpaid attendee/absent per the roster, with no money recorded.
- Corrections/refunds are permissioned and audited; a correction writes a **new** audit-tracked change, it does not silently overwrite history.

**Center cut — what FIXED actually means (settled).** `PERCENTAGE` is unchanged: the centre takes `round(amount × value / 100)`. **`FIXED` means the exact piastre amount of the session price that the *centre* takes** — a 120 EGP session with `FIXED 15 EGP` yields 15 EGP to the centre and 105 EGP to the teacher. The framing is deliberately **centre-side**, and the alternative framing a teacher sometimes asks for — *"pay me a flat 200 EGP per session regardless of how many students show up"* — **is not expressible in this model and is not supported in Phase 1.** It cannot be: the teacher's share is derived per payment from what a student actually paid, so a headcount-independent flat fee has nothing to derive from when two students turn up instead of twenty, and would require a per-session teacher payable that exists whether or not anyone paid. That is a second financial model (a guaranteed fee, with the centre absorbing the shortfall), not a configuration of this one. If a centre needs it, it is a Phase 2 conversation with its own snapshot rules — not something to approximate by setting `FIXED` and hoping the headcount holds.

**Per-education-system default fixed share.** Each education system carries a **configurable default fixed centre share** — e.g. American 40 EGP, IGCSE 50 EGP — used as the **default** when a class's cut is set to `FIXED`. It is **overridable per class and per session**. It is a default at configuration time only: it seeds the class's `centerShareValue` and is never consulted again at payment time, so changing a system's default never moves a class already configured, let alone a payment already recorded. The split math itself stays in exactly one place (`lib/money.ts`, CLAUDE.md rule 3).

**Void vs. refund — two different things, and both now exist.** These were conflated in earlier drafts ("corrections/refunds" as one phrase). They are not the same event and must not share a mechanism:

| | **Void** | **Refund** |
|---|---|---|
| **What happened** | The payment should never have been recorded — wrong student, wrong session, wrong amount, fat-fingered entry. | The payment was correct and the money is now being given back to the student, in cash. |
| **Effect on the row** | `voided = true` + reason; money fields untouched. A corrected `Payment` may then be written as a **second** row. | Original row **preserved untouched**; a **refund record** is written alongside it, referencing it. |
| **Effect on analytics** | The voided payment simply is not counted — it was never real revenue. | Collected revenue is **reduced**, and so are that payment's centre and teacher shares. The revenue *was* real and is being reversed. |
| **Effect on the teacher** | Nothing to settle — there was no valid payment. | The teacher's share of that payment is reversed too. A settlement already `PAID` is not rewritten (§ "Teacher settlements"); the reversal lands in the next period. |
| **Creates a balance?** | No. | **No.** Cash back, nothing owed either way, no student balance anywhere (§2 "Student debt" is unchanged). |

Both are permissioned and audited. Neither ever `UPDATE`s a money field on the original row.

**Teacher settlements.** A settlement record moves `DRAFT → APPROVED → PAID`. There is **no partially-paid state** — a settlement is either fully paid or it is not, because a partial state invites exactly the "how much is still owed" bookkeeping the no-debt rule refuses to carry. Totals are **derived from the frozen `teacherShareSnapshot` values and never recomputed** from current class config. Two shapes are supported and both are first-class, because real centres do both: **per-session** — a centre paying a teacher cash right after each session marks that single session's teacher share paid — and **period roll-up** — a settlement covering a date range. Every transition is permissioned and audited. Settlement records are **carved out of the data-visibility window** (below): a teacher who cannot read a settlement from four months ago cannot verify they were ever paid, which would make the record worthless.

**Attendance.**
- Statuses: **Present, Late, Absent, Excused**. *(M10: "Excused configurable per class" is real — `ClassGroup.allowExcused`, default `true`, a Classes screen toggle; the roster's Attendance control hides the button and the Server Actions refuse the status server-side when a class has it off.)*
- **Late threshold** (minutes) is per class.
- Consecutive-absence and total-absence counts are derived from attendance history (`lib/db/attendance.ts`'s `consecutiveAbsenceCount`, M5) and surfaced on the session receipt. *(M10: now also surfaced on the student profile page — a per-class "absent N times in a row" alert for every active enrollment with a live streak.)*
- Corrections require permission and are audited; sessions have an **edit deadline** for teachers, set by the manager. *(M5: attendance corrections are permissioned and audited — `attendance.record` for a first mark, `attendance.correct` for changing an already-marked row. M10: the teacher edit-deadline setting is real — `CenterSettings.teacherEditDeadlineHours`, `null` = no deadline, a General Settings toggle, enforced in the session-description edit action.)*

**Scheduling.**
- A class can meet on **multiple days/times**.
- Sessions are generated on a rolling window from the class schedule.
- Teacher and room **conflicts** are detected/warned per configured rules — **within one centre only** (settled). A teacher double-booked between two *different* centres is **not** detected, deliberately: finding that clash means one centre learning that a teacher works elsewhere, when, and with whom, which is exactly the disclosure M12's teacher-detail fix closes on purpose. Cross-centre detection needs a teacher-consented free/busy model and is `05-phase-2-backlog.md` entry 2. Within a centre, the branch layer changes nothing — rooms and sessions belong to the centre directly (see "Branch architecture"), so the existing checks already cover every room a centre has.
- Cancel/reschedule updates affected rosters and (later) notifications; material changes are audited. *(M10: `lib/db/sessions.ts`'s `cancelSession`/`rescheduleSession`, gated on `session.cancel`/`session.manage`. Cancelling never touches money/attendance — a payment that needs undoing is `voidPayment`'s separate job; rescheduling re-runs the generator's own conflict check. Notifications stay out of scope per §2.)*

**Reservations / enrollment.** *(M8, `lib/db/reservations.ts`'s `reserveOrEnroll`.)*
- A class flags **accepts-new-students** and **requires-confirmation**. If confirmation is required, a student request is **Pending** until center/teacher accepts; otherwise it's **Confirmed** immediately — implemented literally as "no `Reservation` row at all, an active `Enrollment` written directly" for the instant path, `ReservationStatus` genuinely not applicable there.
- Capacity is enforced; full-class behavior (reject vs waitlist) is a defined rule (default: block enroll when full). For an instant-enroll class this is checked at request time, refusing the write outright (`classFull`). For a confirmation-required class it is deliberately **not** checked at request time — a center may legitimately want more requests than seats so it can choose who to confirm — and is re-checked in `confirmReservation` instead, at the moment a seat is actually claimed.
- Duplicate enroll/reservation is prevented. `Reservation` is unique on `(classGroupId, studentId)` with no `centerId`/`status` in that key (docs/01-data-model.md §2), so — like `Enrollment` — the row is reused across its lifecycle: a REJECTED/CANCELLED request re-requested later resets the same row to PENDING rather than inserting a second one, which the unique constraint would refuse.
- A student's identity is the global `User` (CLAUDE.md rule 4); their center-local `StudentProfile` is created the moment a seat is actually claimed — instantly for the immediate-enroll path, or on confirmation for the pending path — never merely from sending a request. This is the self-serve "connect to a center" mechanism docs/02-architecture.md §3 refers to for students.

**Blocking.** Teachers (and centers) can block a student from a teacher/class/session. A blocked student cannot enroll or be added.

**Teacher inactivity.** A center-configurable **timeout** (N days with no completed session, counting from last completed session) flips a teacher to inactive; `none` disables it.

---

## 5.1 Settled decisions (recorded so they read as decided, not missed)

> Everything in this section is a **choice with a reason**, not a gap. Several of them look, from the outside, like something a more thorough build would have done differently — which is precisely why the reasoning is written down rather than left to be rediscovered as a "bug" later.

**Check-in & the QR payload — static, printed, centre-scoped.** The ID card encodes `KAYEDU|{centerId}|{studentCode}` and nothing else: no session, no timestamp, no rotating token. This is deliberate on four counts. **Offline reliability** — a printed card scans with no network, no battery and no app; a session-aware token needs a live server at exactly the moment (the rush) when the connection is least reliable. **No smartphone dependency** — a great many students do not carry one, and a check-in method that assumes they do is a check-in method that fails for the students it fails for, silently. **It is already centre-scoped** — a card issued by Centre A carries A's `centerId` and reception refuses a payload from anywhere else, so a card is not a platform-wide credential. **The anti-impersonation control is reception's photo check, not the code** — a human comparing the face in front of them to the photo on the screen is what stops a borrowed card, and no token scheme replaces that. Two consequences follow and both are load-bearing: the scan result **must display the student's photo** (see §7 criterion 16 — this is currently missing, and M18 fixes it), and a dynamic token stays in `05-phase-2-backlog.md` entry 1 until an observed impersonation problem justifies the trade.

**Branch architecture.** A new **`Organization`** model is the paying customer. The existing **`Center`** becomes the branch-level tenant and gains an `organizationId`. **`center_id` remains the sole isolation key** — `lib/db/scoped.ts`, `getTenantContext()` and the gate scripts' isolation model do not change, and that is the point of doing it this way: the org layer is additive, so nothing that currently guarantees isolation has to be re-proven. An **Owner** holds an **org-level membership** resolving to every centre under it; **Manager / Receptionist / Accountant** hold **centre-level memberships** naming exactly one branch, unless the Owner explicitly grants additional branches (M12). **Teacher memberships are unchanged** — a teacher belongs to centres, exactly as today, and the org layer neither widens nor narrows that. Analytics gains an **org-level roll-up** (one branch, or all), computed as a union of per-branch scoped queries. The old **`Branch` model is retired**: `Room.branchId` and `Session.branchId` are dropped, and rooms and sessions belong to the centre directly — the old `Branch` was a location sub-entity under a tenant, which is the job the centre itself now does. There is **no limit on branches per organization**. Naming is resolved in the **i18n layer only** (see §2): a full DB rename is `05-phase-2-backlog.md` entry 18.

**Global academic catalog.** Subjects, grades and education systems become **platform-owned**. A centre **picks** entries from the catalog rather than authoring its own, and may **suggest** a missing entry into a queue platform admins review and either add to the catalog or decline. For a picked entry, a centre may edit **only its own display name and prices** — never the canonical entry. Every catalog entry carries **both an Arabic and an English name**, so a subject reads correctly in either locale without a centre translating anything. **Person names stay single-valued and do not change with locale**: a person has one name per relationship (the centre-local name, `01-data-model.md` §6), not an Arabic one and an English one — a human's name is not a translatable string, and pretending otherwise creates two records of the same person that drift. This also unblocks the portability the platform is sold on: with a global catalog, "IGCSE Physics" means the same thing at every centre, which is what makes Discover's cross-centre filtering (`02-architecture.md` §14) able to stop matching on strings.

**Approvals & enrolment.** A centre approves student enrolment requests from `/approvals` (§4.1 item 9). **Teachers get their own approvals page** for students enrolling in *their* classes (§4.2 item 6) — a separate queue, because the teacher-side decision ("do I want this student") is a different decision from the centre-side one ("does this fit our roster"). Two rules apply to both queues: a request **must check both `StudentBlock` scopes** (TEACHER and CLASS) and be **refused** when the student is blocked from that teacher or that class — an approval flow that can approve a blocked student makes the block meaningless; and a **rejected student cannot re-request the same class for 7 days**, with the UI **stating that clearly** when they try, rather than silently failing or letting them spam the queue. The cooling-off is per (student, class), not per centre.

**Capacity.** Enrolment is **hard-capped by room capacity**. Exceeding it refuses with a message naming the actual fix — *"change the room or increase its capacity"* — not a bare "class full", because the person hitting this wall is staff who can resolve it. **Session attendance may exceed room capacity**: 25 people in a 20-seat room is a real and acceptable thing on the day, and blocking the desk from marking a student present who is physically standing there would be absurd. A student **may still submit an enrolment request** when the class is full (a centre may want the queue, and a seat may free up), but **staff cannot manually add or approve past the cap** until the room changes. Enrolment is a planning act with a hard limit; attendance is a record of what happened and has none.

**Reschedule with linkage.** A rescheduled session **links to its replacement immediately** — the original is not silently mutated into the new one, so the history reads "this session moved to that one" rather than "this session was always on Thursday." The target may be a **future date or the same day at a different time**. The **room must be free for the entire start→end window**, not merely at the start instant. The **same rule applies whether a teacher or centre staff initiates** it — there is no looser path for staff. (`startTime`/`endTime` already exist on both `ClassSchedule` and `Session`, so the full-window check needs no new fields.)

**Teacher onboarding.** A teacher who belongs to **no centre** must **not** land on the student Discover screen — the current fall-through, and plainly wrong: it shows a teacher a shopping list of classes to enrol in as a student. They get a **centre directory** instead, and can **request to teach** a session or a class at a centre, pending that centre's approval. This is the teacher-side counterpart to what Discover does for students: the self-serve way to make a first connection.

**Parent role & portal.** A new **PARENT** role. A parent account arises from a **phone number students have listed as their parent phone**; the parent gets a **child selector** and a portal mirroring the student portal per child (§4.5). Two hard constraints. **It must be refused for a phone already belonging to a teacher, staff member or platform admin** — those people's phone numbers appear on student records all the time (a teacher's own child attends the centre), and letting a phone match silently mint a parent account for someone who already holds a privileged role is a privilege-escalation path, not a convenience. And **a phone match alone must never grant access**: an explicit **verification/approval step is required** before a parent account can read a child's data. The exact mechanism — staff approval, OTP, or a centre-issued code — is **OD-6** in §2.2 and is not settled; M16 builds everything except that step until it is.

**Teacher ratings.** After attending sessions, a student sees a **skippable** login pop-up inviting them to rate those sessions **1–5**, covering the **last 7 days**. What is published is an **average out of 5 only** — shown on class/session browsing, **never the count**, because a count is what turns a rating into a popularity contest and lets a teacher (or a centre) infer who rated them from a small sample. Visible to **students, centres and the teacher**; the teacher can **never see who rated them**. The rating **follows the teacher across centres** — it is an attribute of the person, like their identity, not of a membership.

**Data visibility window.** By default, **no centre-side role may view data older than 1 calendar month** — analytics, money, old sessions, attendance history. Platform admin bypasses it. It is **per-centre configurable** in `CenterSettings` and adjustable by a platform admin. Four constraints are part of the decision, not implementation detail:
- **It is a read restriction and never a deletion.** Every snapshot row stays exactly where it is. Nothing is pruned, archived away, or made unrecoverable — widening the window restores full visibility instantly, because nothing was lost.
- **It is enforced in the data layer, not the UI.** A direct URL or API call must not bypass it, mirroring the shape the receptionist profit-denial already has (§7 criterion 9): the denial is a scoped query and a loader-level refusal, not a hidden button.
- **Settlement / payout records are carved out** and stay visible. Otherwise a teacher can never verify they were paid, which defeats the entire point of having the record.
- **Audit logs are carved out.** An audit trail a centre cannot read past last month is not an audit trail.

**Centre lifecycle.** `Center.active` (a boolean) is replaced by **`ONBOARDING / ACTIVE / GRACE / SUSPENDED / ARCHIVED`**. **`Center.plan` is removed entirely** — the column, the editor, the Server Action, and every reference in code and docs. It was free text with no behavior behind it, and leaving it in place implies a billing system that does not exist. **No module entitlements**: one product, configured, never gated per centre (§8).

**UX & data integrity.** A cluster of small decisions that are individually minor and collectively the difference between a demo and a tool:
- **Visual ID-card layout editor** — drag, resize, add from a palette, remove with ×. **A centre never sees JSON.** The stored `cardLayout` shape is unchanged; only the editor is.
- **Phone validation, 11–15 digits, one shared normalizer.** `+20100…`, `20100…` and `0100…` all normalize to `01…`, through **one function** used by validation, duplicate-matching **and** search. Three implementations of this rule is three different answers to "is this the same person."
- **All search inputs become live type-ahead dropdowns.**
- **All date filters become the same component**: Day / Week (today −7) / Month (1st → today) buttons, plus a specific-date picker, a range picker, an Apply, and a reset back to today's default.
- **Soft-delete / deactivate wherever removal could corrupt history or analytics**; hard delete only where nothing references the row. **The 404 on student delete is a bug and gets fixed.**
- **Self-registration creates a student with a full profile page** (§4.3 item 4), not a stub.
- **Receptionist phone lookup during registration reuses M3's duplicate-match panel** — **not** a raw "phone → full record" endpoint. It returns only the minimum needed to confirm identity, requires an **explicit link action**, is **rate-limited**, and **never exposes another centre's private fields**. A lookup that hands back a full record on a guessed phone number is a people-enumeration API with a friendly name.

**Two security fixes (M12).**
- **Teacher detail leak.** A centre Owner or Manager viewing a teacher **must not see which other centres that teacher works at.** The teacher's portability is theirs, not their employer's, and this is the same boundary `05-phase-2-backlog.md` entry 2 refuses to cross for scheduling.
- **Role-change session invalidation.** Changing a user's role **must invalidate or re-resolve their session immediately**. A demoted user keeping their old rights until a cookie expires is a permission system with a grace period nobody agreed to.

---

## 6. Explicitly OUT of Phase 1

**→ [`05-phase-2-backlog.md`](./05-phase-2-backlog.md)** is the list, and it is the only list. Every deferred item lives there with **what it is**, **why it was deferred**, and **what it depends on** — a comma-separated line here was enough to say "no" in a meeting and useless for re-deciding six months later.

Deferred items must not creep in. Requests for them get the three-bucket answer (see §8), and a new "Roadmap / Phase 2" answer gets **written into the backlog file**, not remembered. An item that appears both there and in `03-build-order.md` is a bug.

One change worth calling out, because it reverses an earlier line in this section: the **parent portal is no longer deferred** — a PARENT role and a per-child mirror of the student portal are Phase 1 as of **M16** (§4.5).

---

## 7. Acceptance criteria (test with real scenarios, not button clicks)

These are the QA gates. If these pass, Phase 1 is trustworthy.

1. **Shared teacher, two centers:** Center A and Center B share teacher T. T's portal shows a correct combined schedule; **zero** Center-A data leaks into Center B and vice versa.
2. **Shared student, two centers:** One student identity, two separate enrollment/payment histories, no cross-leak.
3. **Money snapshot:** Record a payment; change the class's center-cut; confirm the old payment's numbers are unchanged and the new session uses the new cut.
4. **Fixed vs percentage cut:** A class with `FIXED 15 EGP` and a class with `PERCENTAGE 15%` both compute center/teacher shares correctly on a 120 EGP session.
5. **Drop-in:** Add a non-enrolled student to a session once; attendance + payment recorded with no enrollment created; they don't appear as enrolled next session.
6. **Capacity:** A full class blocks further enrollment per rule.
7. **Conflict:** Two classes can't book the same room at the same time; a teacher can't be double-booked (warn/deny per rule).
8. **Attendance correction:** Only permitted roles can change a recorded status; the change is audited.
9. **Receptionist denied profit:** A receptionist cannot view center profit by UI or by direct URL/API.
10. **Tenant isolation by URL/API:** A Center-X user cannot read a Center-Y record by manipulating an ID in the URL or API call — **denied**.
11. **Cancelled session:** Roster, schedules, and any financial/attendance effects update correctly; change is audited.
12. **Duplicate registration:** Registering an existing phone/email triggers the match/merge workflow, not a duplicate person.
13. **Consecutive absence:** After marking a student absent 3 sessions in a row, the session receipt and profile show "absent 3 times in a row."
14. **Performance:** High-volume attendance entry during a rush stays responsive.
15. **RTL:** Every screen renders correctly in Arabic RTL and English LTR.

**Criteria added by M11–M19** (each gated by the `check:*` script named in `03-build-order.md`):

16. **Reception scan shows the photo:** scanning a card (or selecting a search result) at Reception displays the student's photo — the anti-impersonation control §5.1 "Check-in & the QR payload" names. *(Currently **failing** — see §7.1.)*
17. **Cancelled session refuses money and attendance:** recording attendance or a payment on a `CANCELLED` session is refused server-side, not merely hidden. *(Currently **failing** — see §7.1.)*
18. **Branch isolation is still centre isolation:** with an organization holding two branches, a user scoped to Branch A cannot read a Branch B record by URL/API; the org roll-up returns exactly the sum of the two per-branch figures.
19. **Owner-only granting:** a MANAGER cannot change the permission matrix, assign a role, or widen a member's branch access — by UI or by direct action call.
20. **Role change invalidates the session:** a demoted user's next request resolves the new role, with no window where the old rights still work.
21. **Teacher's other centres stay hidden:** a centre Owner/Manager viewing a teacher sees nothing about that teacher's memberships elsewhere, by UI or by API.
22. **Refund arithmetic:** refunding a payment reduces collected revenue and that payment's centre and teacher shares by exactly its amounts, leaves the original row's money fields untouched, and creates no balance anywhere.
23. **Settlement totals derive, never recompute:** a settlement's total equals the sum of the frozen `teacherShareSnapshot` values in its scope, and stays correct after the class's cut changes.
24. **Cooling-off holds:** a rejected student re-requesting the same class within 7 days is refused, and told why.
25. **Capacity split:** enrolment past room capacity is refused (with the change-the-room message) while marking attendance past room capacity succeeds.
26. **Reschedule needs the whole window:** a target slot whose room is free at the start but busy before the end is refused.
27. **Rating anonymity:** the teacher-facing aggregate exposes an average only — no rater identity and no count — through the API as well as the UI.
28. **Visibility window is a data-layer denial:** a centre role cannot read out-of-window analytics/sessions/attendance by direct URL or API; settlement and audit rows in the same range remain readable; nothing is deleted.

### 7.1 Verified gaps (static check, this session — behaviour not yet changed)

Two of the criteria above were checked against the code as it stands and **fail today**. Neither is fixed in this docs pass; both are assigned below.

- **Criterion 17 — `cancelSession` does not prevent attendance or payment on a cancelled session.** `cancelSession` ([lib/db/sessions.ts:278](../lib/db/sessions.ts#L278)) flips `Session.status` to `CANCELLED` and returns; that is all it does, and it is correctly documented as not touching money. But **nothing downstream re-reads that status**: `setAttendanceAction`, `addStudentToSessionAction`, `addNewStudentToSessionAction` and `recordPaymentAction` ([app/[locale]/(center)/sessions/actions.ts](<../app/[locale]/(center)/sessions/actions.ts>)) each load the session and check only existence and `allowExcused`; `checkInAction` ([app/[locale]/(center)/reception/actions.ts:44](<../app/[locale]/(center)/reception/actions.ts#L44>)) does the same; and `recordPayment` ([lib/db/payments.ts](../lib/db/payments.ts)) validates the attendee's status but never the session's. The UI is no barrier either — the session detail page passes `cancelled` only to `SessionLifecycleActions` (to disable the cancel button), while the roster below it still renders live attendance and payment controls. **A cancelled session accepts a full, snapshotted payment.** Assigned to **M15** (session lifecycle sits with the reschedule/approval rules) — the fix is a server-side refusal in the attendance and payment write paths plus a read-only roster, not a hidden button.
- **Criterion 16 — the Reception scan result does not display the student's photo.** `StudentProfile.photoUrl` exists ([prisma/schema.prisma:411](../prisma/schema.prisma#L411)), but the Reception page builds its `selectedStudent` as `{ id, name, code }` only ([app/[locale]/(center)/reception/page.tsx](<../app/[locale]/(center)/reception/page.tsx>)) — for both the QR-payload branch and the search-result branch — and nothing under `app/[locale]/(center)/reception/` references `photoUrl` or renders an avatar at all. So the control §5.1 names as **the** anti-impersonation measure behind the static QR decision is currently not on screen. Assigned to **M18** (UX sweep). This one matters more than its size suggests: the QR payload decision is *justified* by the photo check, so until it ships, that justification is aspirational.

---

## 8. Product governance (the anti-scope-creep shield)

Every center request is sorted into exactly one bucket **before** anything is promised:

- **Configurable behavior** → "Yes, you can turn that on in settings." (Preferred answer.)
- **Roadmap / Phase 2** → "That's coming in a later phase."
- **Custom, separately scoped** → "That's a custom add-on we'd price separately."

Never fork the codebase per center. The feeling of "their own system" comes from **branding + configuration**, not custom code. (This is the script for the owner meetings.)

---

## 9. Glossary

> **Read the first two entries together.** The DB vocabulary and the UI vocabulary deliberately differ, and the mapping is the single most confusable thing in these docs. When a doc names a **model** (`Center`, `Organization`) it means the database. When it names a **screen label** ("Branch", "Centre") it means what a user reads. The i18n layer is the only place the two meet (`02-architecture.md` §8); a full DB rename is `05-phase-2-backlog.md` entry 18.

- **`Organization`** (DB) = **"Center"** (UI) = the paying customer. Holds one or more branches. Not a tenant — carries no `center_id` and isolates nothing.
- **`Center`** (DB) = **"Branch"** (UI) = the tenant, and one physical location. **`center_id` is the sole isolation key**, unchanged by the org layer.
- **`Branch`** (the retired model) = the old location sub-entity under a tenant. **Dropped at M11**, along with `Room.branchId` and `Session.branchId` — rooms and sessions belong to the centre directly. Do not confuse it with the UI word "Branch", which now means `Center`.
- **Membership** = a user's role-scoped relationship to a center (staff/teacher/accountant). An **Owner's** membership is org-level and resolves to every branch; every other staff membership names one branch unless the Owner grants more.
- **Enrollment** = a student's link to a specific class. Hard-capped by room capacity; attendance is not.
- **Session** = one dated instance of a class.
- **Attendee** = a student marked on a session's roster (enrolled or drop-in).
- **Center cut / share** = the **centre's** portion of a session's collected amount — `PERCENTAGE` of it, or a `FIXED` piastre amount of it. Never framed teacher-side (§5.1).
- **Settlement** = a teacher's payout record, `DRAFT → APPROVED → PAID`, derived from snapshotted shares and never recomputed.
- **Void** = a payment that should never have been recorded. **Refund** = a correct payment given back in cash. Different mechanisms, different analytics effects (§5).
- **Catalog entry** = a platform-owned subject / grade / education system, with an Arabic and an English name, that centres pick from and may suggest additions to.
- **Visibility window** = the read-only horizon (1 calendar month by default) past which a centre-side role cannot read data. A restriction, never a deletion.
