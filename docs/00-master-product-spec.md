# KayEdu — Master Product Spec (Phase 1)

> **Status:** Working draft, Phase 1 scope. This document is the single source of truth. When the note, the blueprint PDF, and this document disagree, **this document wins**. Update this file first, then code.
>
> **Owner:** KAY-SOFT (Founder/Dev + Business partner)
> **Product:** KayEdu — multi-center education management platform
> **Last updated:** Phase 1 kickoff

---

## 1. What KayEdu is (in one paragraph)

KayEdu is a **multi-tenant, web-based ERP for private education centers** in Egypt, with connected portals for teachers and students. A center runs its daily operations through it — students, classes, sessions, attendance, per-session payments, teacher settlements, expenses, and analytics. Teachers and students each have **one KayEdu identity** that can connect to multiple centers. Phase 1 is the operational foundation; Phase 2 (mobile apps, homework, exams, grades, parent portal, AI assistance) builds on top of it later and is **out of scope for now**.

---

## 2. Locked decisions (do not re-litigate without updating this file)

These are settled. They shape the schema and the whole build.

| Area | Decision |
|---|---|
| **Tech stack** | Next.js (App Router) + TypeScript, PostgreSQL via **Supabase** (Auth + Storage + Postgres), Prisma ORM, Vercel hosting (Frankfurt region), shadcn/ui, Tailwind, `next-intl` for i18n. |
| **Tenancy** | **Single shared database**, isolated by `center_id` on every tenant-scoped table. **Not** database-per-center. Adding a center = insert a row + upload a logo, no code changes. |
| **Branding** | Per-center logo, name, and theme color — a **theming layer** separate from data isolation. |
| **Identity** | One global `User` per person. Their relationship to a center is a separate **Membership** (role-scoped). Attendance, payments, enrollments hang off the membership/enrollment, never the raw user. |
| **Financial model** | **Pay-per-session only.** Recorded at the desk (offline). No online payment gateway in Phase 1. |
| **Center's cut** | Configurable **per center, and per subject/grade/class**. Two modes: **fixed EGP** (e.g. 15 EGP) or **percentage** (e.g. 15%). Stored explicitly on each class. |
| **Student debt** | **Does not exist** in Phase 1. No "owes money" balances. Attend = pay, or not counted. |
| **Prepaid / packages / discounts / monthly subscriptions** | Not in Phase 1. Schema stays flexible so they *can* be added later, but nothing is built for them now. |
| **Drop-in attendance** | Supported. A student can attend a session **once without being enrolled**, or be a regular enrolled student. |
| **Payment methods (recorded, not processed)** | Cash (default), InstaPay, Wallet, Visa. |
| **Notifications** | **Deferred.** In-app only later; no SMS/WhatsApp cost in Phase 1. The notification layer is designed so WhatsApp/SMS plug in later without rework. |
| **Languages** | Arabic + English, full **RTL** support, from day one. |
| **Check-in methods** | ID card with QR **and** manual search by student code / name / phone. All available. |
| **Session generation** | Recurring schedules generate individual session instances on a **rolling window** (~4–6 weeks ahead), with per-session cancel/reschedule and a holiday calendar. |
| **Offline resilience** | No full offline mode in v1. Resilient optimistic UI + retries so a brief internet drop doesn't lose data. Full offline-sync is a possible later feature. |
| **Deployment gate** | Nothing goes to production until there's a signed contract with the first center. |

---

## 2.1 Pre-deployment checklist

> The **Deployment gate** above says *when* we may deploy. This section says *what must be closed out first*. Everything listed here is a **deliberate development shortcut** standing in for a production requirement — each one is fine right now and unacceptable in front of a paying center. Nothing ships to production until every box is ticked. Add to this list the moment a new shortcut is taken; a shortcut that isn't written down here is a shortcut that gets forgotten.
>
> Referenced from `02-architecture.md` §13 (Deployment).

### A. Auth & email

- [ ] **Re-enable Supabase email confirmation.** Currently **disabled** so dev accounts can sign in instantly (Supabase dashboard → Authentication → Providers → Email → *Confirm email*). The code path already exists — `signUpAction` returns `status: "emailConfirmationRequired"` and `Auth.register.confirmEmail` is translated in both locales — so this is a dashboard toggle, not a code change. Until it is on, **anyone can register with an email address they do not control.**
- [ ] **Wire a real transactional email sender** (e.g. Resend) once we own a domain, with SPF/DKIM configured. Today staff invite links are **copy/paste-shared manually** by the inviter (`02-architecture.md` §3, `createInvitationAction` → `InviteForm`), which is correct for Phase 1 and unworkable for a real center inviting a dozen staff. Same sender covers password reset and any future notification use. Note: this is **delivery plumbing**, not the deferred notifications feature (SMS/WhatsApp stay out of scope per §6).
- [ ] **Enable leaked-password protection** in Supabase Auth (HaveIBeenPwned check) — currently off.
- [ ] **Rotate / retire the seeded owner credential.** `prisma/seed.ts` creates a Supabase Auth user with `email_confirm: true` and the password from `SEED_OWNER_PASSWORD` (default `KayEdu!Dev123`). **`npm run db:seed` must never run against production.** The first real owner is provisioned through the admin panel + invite flow (M9), not the seed.
- [ ] **Set `NEXT_PUBLIC_APP_URL`** to the real origin per environment (it is `http://localhost:3000` in dev).

### B. Data & tenant security

- [ ] **Give the RLS backstop real policies.** RLS is *enabled* on every table but **zero policies exist**, so PostgREST access is denied outright (safe by accident) while Prisma connects as a role that bypasses RLS. `02-architecture.md` §5 layer 2 asks for actual per-tenant policies. Before production: write the `center_id ∈ caller's memberships` policies, and confirm the Prisma connection role is **non-superuser**.
- [ ] **Remove or lock down `public.rls_auto_enable()`** — a `SECURITY DEFINER` function currently executable by both `anon` and `authenticated` via `/rest/v1/rpc/rls_auto_enable`. Revoke `EXECUTE`, switch it to `SECURITY INVOKER`, or drop it.
- [ ] **Service-role key hygiene.** `SUPABASE_SERVICE_ROLE_KEY` lives in the local `.env` for the seed. In production it exists only as a Vercel server-side env var — never `NEXT_PUBLIC_*`, never in a client bundle.
- [ ] **Create the remaining Storage buckets + policies.** `avatars/` and `id-cards/` exist as of M3 — private, size/MIME limited, paths namespaced by `centerId`, with `storage.objects` policies mirroring tenant isolation (`02-architecture.md` §10). Still to create: `logos/` (center branding) and `session-uploads/` (teacher uploads), with the same shape. Also review the three `SECURITY DEFINER` helpers those policies read (`kayedu_member_center_ids`, `kayedu_write_center_ids`, `kayedu_own_student_profile_ids`) in the security pass below: each takes no arguments and filters on `auth.uid()`, and `EXECUTE` is granted to `authenticated` only.
- [ ] **Backups + a *tested* restore**, and a privacy/legal review before handling minors' data (`02-architecture.md` §12).

### C. Operations & pipeline

- [ ] **Run the acceptance gates in CI**, not by hand: `npm run check:isolation` (cross-center by id, M1), `npm run check:config` (center configuration, M2), `npm run check:people` (teachers, students, blocks, identity matching and storage paths, M3), `npm run check:classes` (classes, schedules, conflicts, session generation, M4), `npm run check:payments` (snapshot immutability, FIXED/PERCENTAGE splits, drop-ins, void-then-recreate, consecutive absence, cross-center isolation, M5), `npm run check:analytics` (revenue/expense reconciliation, by-teacher breakdown, cross-center isolation, receptionist profit-denial, M6) `npm run check:teacher-portal` (shared-teacher two-center zero-leakage, combined-dashboard union correctness, per-center StudentBlock scope TEACHER regression, M7), `npm run check:student-portal` (instant-enroll vs. requires-confirmation branching, capacity enforcement, duplicate-reservation prevention, both StudentBlock scopes, reject-then-re-request row reuse, cross-center isolation on a student's own reservations/enrollments, M8) and `npm run check:approvals` (ChangeRequest/Reservation accept-decline correctness, RECEPTIONIST denial, cross-center isolation on the pending queue). `02-architecture.md` §5 requires them as gates; today they are manual local commands.
- [ ] **Migrations via `prisma migrate deploy` in CI** — never `migrate dev` against a deployed database.
- [ ] **Error monitoring** (e.g. Sentry) wired before the pilot.
- [ ] **Session-generation cron registered on Vercel.** The generator itself (`lib/db/sessions.ts`) and its HTTP entry point (`app/api/cron/generate-sessions/route.ts`, guarded by a `CRON_SECRET` bearer check) land with M4 — the rolling window does not materialize itself until a `vercel.json`/`vercel.ts` `crons` entry actually calls that route on a schedule (docs/02-architecture.md §11), and `CRON_SECRET` must be set in the Vercel project's env vars. Until then, the manual "Generate sessions" buttons on `/classes` and a class's detail page are the only trigger.
- [ ] **Data import/export** paths for onboarding and responsible offboarding (§7 criterion set / M10).
- [ ] **Manually verify live cross-center identity behavior once 2+ real centers exist.** `npm run check:people` proves duplicate-matching (including matching on a contact that lives only on another center's local record) and independent per-center name/contact editing against throwaway fixture centers — but only one real center is seeded today (`prisma/seed.ts`), so this has never been exercised with real staff, real data, or real timing. Once a second real center is onboarded: register/add a person already known to the first center and confirm the match panel finds them and links correctly; rename or re-contact that person at one center and confirm the other center's record — and the person's own portal login — is unaffected (`01-data-model.md` §6).

### D. Code-level shortcuts

- [x] ~~`.dark` block in `app/globals.css` is stock shadcn placeholder values~~ — removed (2026-09-01). Dark mode is not part of `04-design-system.md`; `@custom-variant dark` stays only because the stock `components/ui/button.tsx` still carries inert `dark:` utility classes.
- [ ] **Nav items marked `disabled: true`** in `components/shell/nav.ts` are milestone placeholders that render as "Soon". Every one must be either implemented or removed before a center sees the app.
- [ ] **Run through all 15 acceptance criteria in §7** (M10) — this checklist is the *infrastructure* gate; §7 is the *product* gate. Both must pass.

---

## 3. Roles & permissions

Six roles. Start them **hardcoded** (not a fully dynamic permission engine) with a small number of toggles. Make it configurable *only* if centers demand it.

| Role | Scope | Core capability |
|---|---|---|
| **Super Admin (KayEdu)** | Platform | Create/suspend center tenants, platform KPIs, support, audit. Never browses tenant data casually. |
| **Owner** | One center | Full control of their center: money, staff, config, everything a Manager can do + ownership actions. |
| **Manager** | One center | Runs the center: teachers, classes, students, sessions, analytics, expenses, config, approvals, delete rights, teacher-edit deadlines. |
| **Receptionist** | One center | Daily ops: reception desk, check-in, record attendance + payment, add students, view today's sessions. **Cannot** see center profit/settlement unless granted. |
| **Teacher** | One or more centers | Their own schedule, sessions, students, analytics/earnings, request new classes/sessions, block students. Only sees data for centers they belong to. |
| **Student** | One or more centers | Discover/reserve classes, see personal schedule, enrollments, own attendance history. |

**Permission rules that matter (Phase 1):**
- A Receptionist seeing **center profit** is **denied by default**.
- A Teacher sees their **own earnings/analytics by default** (M3) — no center grant needed. `Membership.canSeeEarnings` exists as schema flexibility for a possible future per-center toggle, defaults `true`, and nothing currently reads it to gate anything.
- Attendance **corrections** and **financial corrections** require elevated permission and are **audited**.
- Teacher's **deadline to edit a session** is set by the center manager (a center setting).
- **Delete** of teachers/students is a Manager/Owner action, not Receptionist.

> Full permission matrix (action × role) lives in `02-architecture.md`. This section is the intent.

---

## 4. The four experiences & their screens

### 4.1 Center (Owner / Manager / Receptionist) — the ERP

A navbar **branch switcher** ("Whole Management" = all branches, or a specific branch).

0. **Auth** — login/register. Owners/Managers/Receptionists are **invited by email**. Teachers & Students self-register.
1. **Dashboard** — today's sessions, attendance status, KPIs, outstanding operational items.
2. **Teachers** — add/edit/delete teacher (first/last name, phone, alt phone, email, active flag); teacher detail with all their classes; teacher block-list (block students from joining them).
3. **Classes** — add/edit class (subject, grade, education system, price, one-or-more class times, room, education type/configurable price, **center-cut config**, capacity, attendance-required flag + late threshold, accepts-new-students, requires-confirmation); remove/block students; filterable dashboard.
4. **Students** — add/edit/delete student (name, email, phone, alt phone optional, grade, parent name/phone/alt, assign to teacher+subject+class optionally); enrollment view showing which teachers/subjects the student is in, with **per-week attendance history** per teacher/subject; **promote grade** at term end (Manager); **print as ID card / print as paper**.
5. **Analytics** — filters (day/week/month/year/all-time/specific date, by teacher). Revenue: total, teacher share, center share, expenses, net, averages. Users: total/new students, total/active/new teachers.
6. **Expenses** — manage categories; add expense (category, amount, date); same date filters.
7. **Sessions** — dashboard of today's sessions (filterable to week/month, by teacher/subject/class/status). Session detail: info panel + enrolled roster (shows if class-specific), add student (existing or new; one-time or enrolled), mark attendance → confirm payment method → session receipt (total, center share, teacher share, attendance count, absentees with consecutive-absence counts). Block/remove student from session.
8. **Reception Desk** — the fast check-in surface: search by student code / name / phone, add new student, select session + payment method + attendance status, today's sessions marked live, add-session button.
9. **Approvals** — review teacher-submitted class/session requests: accept/decline/contact/edit-and-confirm. **Delivered** (`/approvals`, closing the gap flagged at M6/M7/M8): a combined queue of every PENDING `ChangeRequest` (type `NEW_CLASS`) and every PENDING `Reservation` at the active center, OWNER/MANAGER only (`approvals.manage` — not in RECEPTIONIST's baseline or grantable set, spec §7 acceptance criterion 9's denial shape). Accept/decline only, both entity types; **contact** and **edit-and-confirm** are not built (see the decision below and the not-built note in `03-build-order.md`).
   > **Decision: accepting a `ChangeRequest` flips its status; it does not auto-create a `ClassGroup`.** The request payload (`lib/validation/teacher.ts`'s `classRequestSchema`: subject/grade/day/time/capacity/attendance settings) carries no price, center-cut config, or room — all mandatory `ClassGroup` fields only a center decides, and money can never be guessed at (CLAUDE.md rule 2). Accepting means "yes, go create this class"; staff then create the real class at `/classes` manually, reading the approved request's details off the Approvals screen. Accepting a `Reservation`, by contrast, **does** immediately act — it calls the same `confirmReservation` (M8) that creates the `StudentProfile` (if needed) and the `ACTIVE` `Enrollment`, because a reservation already carries everything an enrollment needs (an existing `ClassGroup`); there is no missing-data problem to defer.
10. **System Configuration** — Education Systems (name + base price), Subjects (name + grade), Grades (name + education type), Rooms (number + capacity), Role config, **Teacher Timeout** (days of no completed sessions until inactive, or none), **Card Customization** (position of name/id/logo etc.), Users & Roles (invite by email or add existing user by email).

### 4.2 Teacher portal (cross-center)

0. **Auth** — one login, connects to multiple centers.
1. **Analytics** — filter by center/time/grade: total earnings, total sessions, unique students attended.
2. **Sessions** — search by student; filter date/status/grade; session detail (grade, attendance, absent, earning, center earning, print); future sessions; edit session description; **request new session** (center, free room + time, grade, subject); block student.
3. **Students** — search by code/name/phone; detail shows all sessions this student attended **with this teacher**; block student.
4. **Classes** — request new class at a center where they're a trusted teacher (grade, subject, timing/date range or semester, attendance settings + late threshold, capacity); remove/block students.
5. **Upload files for sessions** — placeholder, details TBD later.

### 4.3 Student portal

0. **Auth** — one login, connects to multiple centers. As of **M8**, a student's very first center connection is made *through* this portal — Discover is the self-serve mechanism (docs/02-architecture.md §3 "students by discovery/enroll"), so a brand-new sign-up with zero relations anywhere can still reach `/student/discover` and make their first reservation/enrollment (`requireStudentUser()`, `lib/auth/tenant.ts`).
1. **Sessions** — filter by date; past + future; session detail visible inline. **Delivered at M8** (`/student/schedule`): upcoming sessions come from active enrollments, past sessions come from the student's own `SessionAttendee` history (so a drop-in attendance shows up too), unioned across every center the student has a `StudentProfile` at (`getStudentContexts`, mirroring the teacher dashboard's per-center union, M7). Read-only, as the spec requires — a student never marks their own attendance/payment.
2. **Discover & Classes** — browse/enroll in classes, with **teacher-side validation** (does the teacher auto-accept new students or require confirmation). **Delivered at M8** (`/student/discover`, docs/04-design-system.md §10): a marketplace-style grid across every active center, filtered by subject/grade (matched by *name*, since `Subject`/`Grade` are center-local master data — a class card's subject id has no meaning across two centers) and by day of week. Respects `ClassGroup.acceptsNewStudents`, both `StudentBlock` scopes (TEACHER and CLASS), and capacity. `requiresConfirmation = false` writes an active `Enrollment` directly; `true` writes a PENDING `Reservation` (`/student/reservations` lists a student's own PENDING/CONFIRMED/REJECTED/CANCELLED requests, across every center, with a cancel action for their own PENDING ones).

> **Confirming a reservation now has a UI.** The gap flagged here at M8 (and at M6/M7 for `ChangeRequest`) is closed by the **Approvals** screen (spec §4.1 item 9, `/approvals`): `lib/db/reservations.ts`'s `confirmReservation`/`rejectReservation` are called from there now, not just from the gate script.

### 4.4 Super Admin (KayEdu platform)

Create/activate/suspend center tenants; manage plans/onboarding metadata; controlled privileged support access; platform KPIs (active centers/teachers/students, sessions, adoption); audit sensitive actions; manage global reference data where appropriate.

---

## 5. Resolved business rules (Phase 1)

**Identity & duplicates.** One `User` per person, keyed on verified phone/email. Registering an existing person at a new center creates a **new membership/enrollment**, never a duplicate person. Duplicate-matching + merge is a defined workflow (details in data model).

**Contact details are center-local (revised, M3).** `User.email`/`User.phone` are the person's **global auth credentials** — how they sign in, set once. What a center has on file for a teacher or student (their phone, alt phone, email as *that center* knows them) is a **separate, center-local record** on `StudentProfile`/`Membership`, always editable by that center regardless of whether the person is shared elsewhere. Duplicate-matching on add/register checks **both**: the global `User` contacts and every center's existing local contact record, because a person may have been entered somewhere with a contact that never made it onto their global `User`. No match → create the person (the entered contact seeds the global `User` at that one moment) and the center's own local record. A match → link a new membership/profile to the existing person and write the entered contact as this center's local record only, touching nothing global. Full detail in `01-data-model.md` §6.

**Money — the sacred rules.**
- Charge basis = **one session**. Price comes from the class (or session override).
- The **center's cut** is configured on the class as either `FIXED` (EGP) or `PERCENTAGE`. Teacher share = collected amount − center cut.
- **Snapshot at payment time.** When a payment is recorded, freeze `price`, `center_share`, and `teacher_share` onto the payment row. **Never recompute historical money from current settings.** If a class's cut changes later, past payments keep their old numbers.
- No debt: if a student didn't pay, there's no balance — they're simply an unpaid attendee/absent per the roster, with no money recorded.
- Corrections/refunds are permissioned and audited; a correction writes a **new** audit-tracked change, it does not silently overwrite history.

**Attendance.**
- Statuses: **Present, Late, Absent, Excused**. *(M5 note: "Excused configurable per class" has no schema field yet — all four statuses are offered on every class today; a per-class toggle is a small fast-follow if a center actually asks for it.)*
- **Late threshold** (minutes) is per class.
- Consecutive-absence and total-absence counts are derived from attendance history (`lib/db/attendance.ts`'s `consecutiveAbsenceCount`, M5) and surfaced on the session receipt. *(M5 note: not yet surfaced on the student profile page — tracked as a gap, not silently dropped.)*
- Corrections require permission and are audited; sessions have an **edit deadline** for teachers, set by the manager. *(M5 note: attendance corrections are permissioned and audited as of M5 — `attendance.record` for a first mark, `attendance.correct` for changing an already-marked row; the teacher edit-deadline setting itself is not yet built.)*

**Scheduling.**
- A class can meet on **multiple days/times**.
- Sessions are generated on a rolling window from the class schedule.
- Teacher and room **conflicts** are detected/warned per configured rules.
- Cancel/reschedule updates affected rosters and (later) notifications; material changes are audited.

**Reservations / enrollment.** *(M8, `lib/db/reservations.ts`'s `reserveOrEnroll`.)*
- A class flags **accepts-new-students** and **requires-confirmation**. If confirmation is required, a student request is **Pending** until center/teacher accepts; otherwise it's **Confirmed** immediately — implemented literally as "no `Reservation` row at all, an active `Enrollment` written directly" for the instant path, `ReservationStatus` genuinely not applicable there.
- Capacity is enforced; full-class behavior (reject vs waitlist) is a defined rule (default: block enroll when full). For an instant-enroll class this is checked at request time, refusing the write outright (`classFull`). For a confirmation-required class it is deliberately **not** checked at request time — a center may legitimately want more requests than seats so it can choose who to confirm — and is re-checked in `confirmReservation` instead, at the moment a seat is actually claimed.
- Duplicate enroll/reservation is prevented. `Reservation` is unique on `(classGroupId, studentId)` with no `centerId`/`status` in that key (docs/01-data-model.md §2), so — like `Enrollment` — the row is reused across its lifecycle: a REJECTED/CANCELLED request re-requested later resets the same row to PENDING rather than inserting a second one, which the unique constraint would refuse.
- A student's identity is the global `User` (CLAUDE.md rule 4); their center-local `StudentProfile` is created the moment a seat is actually claimed — instantly for the immediate-enroll path, or on confirmation for the pending path — never merely from sending a request. This is the self-serve "connect to a center" mechanism docs/02-architecture.md §3 refers to for students.

**Blocking.** Teachers (and centers) can block a student from a teacher/class/session. A blocked student cannot enroll or be added.

**Teacher inactivity.** A center-configurable **timeout** (N days with no completed session, counting from last completed session) flips a teacher to inactive; `none` disables it.

---

## 6. Explicitly OUT of Phase 1

Native mobile apps · online live teaching · homework · exams/assessment engine · AI paper scanning/generation · full parent portal · advanced LMS/content library · university workflows · marketplace monetization · online payment processing · student debt/credit balances · packages/subscriptions/discounts · SMS/WhatsApp notifications.

These are Phase 2+ and must not creep in. Requests for them get the three-bucket answer (see §8).

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

---

## 8. Product governance (the anti-scope-creep shield)

Every center request is sorted into exactly one bucket **before** anything is promised:

- **Configurable behavior** → "Yes, you can turn that on in settings." (Preferred answer.)
- **Roadmap / Phase 2** → "That's coming in a later phase."
- **Custom, separately scoped** → "That's a custom add-on we'd price separately."

Never fork the codebase per center. The feeling of "their own system" comes from **branding + configuration**, not custom code. (This is the script for the owner meetings.)

---

## 9. Glossary

- **Center** = the tenant/organization. `center_id` is the isolation key.
- **Branch** = a physical location under a center.
- **Membership** = a user's role-scoped relationship to a center (staff/teacher).
- **Enrollment** = a student's link to a specific class.
- **Session** = one dated instance of a class.
- **Attendee** = a student marked on a session's roster (enrolled or drop-in).
- **Center cut / share** = the center's portion of a session's collected amount (fixed EGP or %).
- **Settlement** = the teacher's payable amount, derived from snapshotted shares.
