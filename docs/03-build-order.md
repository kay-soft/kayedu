# KayEdu — Build Order (Phase 1)

> Turns "huge project" into an ordered sequence of buildable milestones. Each milestone is a set of Claude Code sessions with a clear **done** definition. Build the **single-center daily loop first** (that's the value a center pays for); portability and portals follow. Don't jump ahead — later milestones assume earlier ones are solid.

**Legend:** each milestone lists **Goal**, **Build**, **Done when** (its acceptance gate).

---

## M0 — Environment & skeleton
**Goal:** the app runs, connects to Supabase, migrates, and renders a themed shell in AR/EN.
**Build:** scaffold Next.js; add deps; drop in `schema.prisma`, `docs/`, `CLAUDE.md`; `.env`; `prisma migrate dev --name init`; next-intl `[locale]` routing + `ar.json`/`en.json`; base layout with RTL + a placeholder brand color; shadcn init + a few primitives; Prisma singleton (`lib/db/client.ts`).
**Done when:** `npm run dev` shows a themed layout that flips AR(RTL)/EN(LTR) via the locale switch, and the DB has all tables.

## M1 — Identity, auth & tenancy (the backbone)
**Goal:** real users, memberships, center selection, and enforced isolation primitives.
**Build:** Supabase Auth (email/password) + `User` mirror on first login; `Membership`, `Center`, `CenterSettings`; `/select-center` hub; `getTenantContext()`; `lib/db/scoped.ts`; `lib/auth/permissions.ts`; route-group role gates; staff **invite** flow (`Invitation` + accept). Seed one center, one owner.
**Done when:** you log in, land on select-center (or auto-select), enter the center dashboard scoped to it, and a hardcoded test proves a user of Center A cannot load a Center B record by ID.

## M2 — Center configuration / master data
**Goal:** a center can set up its academic + operational reference data.
**Build:** Settings screens for Education Systems (name + base price), Grades (name + system), Subjects (name + grade), Rooms (name + capacity, per branch), Branches, Teacher-Timeout, Card Customization (JSON), default center-cut. Users & Roles (invite/add). All CRUD scoped + audited where sensitive.
**Done when:** a fresh center can be fully configured through the UI with no SQL, and adding a *second* center and configuring it needs zero code changes.

## M3 — People: teachers & students
**Goal:** manage the humans.
**Build:** Teachers (add/edit/deactivate/delete; detail page; teacher block-list). Students (add/edit/delete; `StudentProfile` with parent info + `studentCode`; enrollment view; grade promotion; print ID card + paper). Duplicate-match on register/add. Supabase Storage for avatars + generated ID cards (with QR).
**Done when:** you can register a student once and connect them to the center; a printable QR ID card generates; a teacher can be blocked-list a student; duplicate phone/email triggers match not duplicate.

## M4 — Classes, schedules & session generation
**Goal:** the academic structure and its calendar.
**Build:** ClassGroup CRUD (subject/grade/system/room/price/**center-cut config**/capacity/attendance flags/late threshold/accepts-new/requires-confirmation); ClassSchedule (multi-day); Enrollment (add/remove/block); the **session generator** (rolling window + holiday calendar); teacher/room **conflict** detection.
**Done when:** a class with two weekly slots generates correct future sessions, a room/teacher double-book is prevented/warned, and enrolling past capacity is blocked.

## M5 — The daily loop ⭐ (reception → attendance → payment → receipt)
**Goal:** the beating heart — what a center opens every day. **This is the milestone that sells.**
**Build:** Today's Sessions dashboard (filters). Session detail: enrolled roster + add student (existing/new, drop-in or enroll) + mark attendance (Present/Late/Absent/Excused). **Reception Desk**: search by code/name/phone (+ QR scan), select session, method, status. Payment recording that **freezes the snapshots** via `lib/money.ts` in a transaction. Session receipt (total, center share, teacher share, present/absent, consecutive-absence counts). Void/correct with audit.
**Done when:** all money acceptance tests pass — fixed *and* percentage cuts compute correctly; a recorded payment is unchanged after the class cut changes; a drop-in records attendance+payment with no enrollment; consecutive-absence shows on the receipt.
**Delivered:** all of the above, gated by `npm run check:payments`. QR "scan" is a hardware barcode-scanner-friendly text match on Reception's search box (`lib/id-card.ts`'s `parseStudentQrPayload`), not a camera — no camera code exists in this app. **Not built in M5** (tracked as fast-follows, not silently dropped): session cancel/reschedule/edit (docs/02 §11); consecutive-absence surfaced on the student profile page (session receipt only for now); a per-class "Excused" toggle (all four statuses are offered on every class).

## M6 — Analytics, expenses & the Center Dashboard
**Goal:** owners see the money and the trends.
**Build:** Analytics with date filters + by-teacher (total revenue, center share, teacher share, expenses, net, averages; students total/new, teachers total/active/new) — **all read from frozen snapshots**. Expenses (categories + entries + filters). Receptionist is denied profit views. **The Center Dashboard also lands here** (spec §4.1 item 1) — it was never assigned to an earlier milestone (M1 shipped only a placeholder with people-count stat cards) and needs exactly the revenue/attendance aggregation queries this milestone builds, so `/dashboard` and `/analytics` both call `lib/db/analytics.ts` with different date-range defaults (today vs. day/week/month/year/all) instead of duplicating the math.
**Done when:** analytics numbers reconcile exactly with the underlying payment snapshots for any date range, and a receptionist cannot reach profit by UI or URL. **Delivered:** the above, gated by `npm run check:analytics` — reconciliation across an in-range/out-of-range date split, by-teacher `groupBy` correctness, and cross-center isolation on every analytics/expense query, plus a direct assertion that RECEPTIONIST holds neither `analytics.center.view` nor `expense.manage` (grantable or not). **Not built in M6** (tracked as a fast-follow, not silently dropped): the Approvals screen referenced by spec §4.1 item 9 doesn't exist yet, so the Dashboard's "outstanding operational items" surfaces only today's not-yet-started sessions.

## M7 — Teacher portal (cross-center)
**Goal:** the portability payoff for teachers.
**Build:** teacher dashboard with **center switcher**; combined + per-center schedule; sessions (search/filter, detail, print, edit description within deadline); students (search, per-teacher history); analytics per visibility; request new class/session (`ChangeRequest`) → center **Approvals** screen; block student.
**Done when:** a teacher shared by two centers sees a correct combined schedule and earnings, each scoped to that center's granted visibility, with **zero** cross-center leakage (the flagship acceptance test).
**Delivered:** teacher dashboard (`/teacher/dashboard`) — combined KPI row (centers, sessions today/this week, earnings this month) plus one card per center, each computed by its own centerId-scoped query (`lib/db/teacher-portal.ts`'s `teacherCenterSummary`) and only unioned in memory (`combineTeacherSummaries`), never a query spanning centers; the "center switcher" is the existing `/select-center` cookie flow, reused as-is. Sessions (`/teacher/sessions`, `/teacher/sessions/[id]`) — search by student, filter by date/status/grade, roster/attendance as a read-only view (marking attendance/payment stays a center-staff action), absent count with the consecutive-absence alert, earning + center earning (always shown here — this is the teacher's own session, a different thing from the center-staff `center.profit.view` gate), print (`/teacher/sessions/[id]/print`), and an unconditional description edit (`updateDescription`, pinned to `centerId` **and** `teacherId`). Students (`/teacher/students`, `/teacher/students/[id]`) — search by code/name/phone narrowed to students this teacher has an attendance record with (`teacherStudentProfileIds`), detail shows only sessions attended **with this teacher** (`studentSessionsWithTeacher`), and reuses the `StudentBlock` scope TEACHER mechanism from M3 with `refId` always resolved server-side from `ctx.user.id` — never a client-sent teacher id. Classes (`/teacher/classes`) — a request form (subject, grade, timing, capacity, attendance settings) writes a `ChangeRequest` (type `NEW_CLASS`) and lists the teacher's own past requests. Upload files for sessions is a "coming soon" placeholder card on the session detail page, per spec. Gated by `npm run check:teacher-portal` (`scripts/teacher-portal-check.ts`) — the flagship shared-teacher, two-center, zero-leakage scenario, plus a regression check that a shared teacher's block at one center does not carry to the other.
**Not built in M7** (tracked as fast-follows, not silently dropped): the **Approvals** screen that would review a `ChangeRequest` — still missing, as flagged at M6; this milestone only adds the write path (`scoped(ctx).changeRequests`) and a teacher's own "my requests" list, so a request sits `PENDING` until a later milestone builds the review UI. A dedicated, filterable-by-grade **Analytics** screen (spec §4.2 item 1: "total earnings, total sessions, unique students attended") — the Dashboard's combined/per-center summary covers the same ground at a coarser grain; `/teacher/analytics` stays a disabled nav placeholder. A **teacher edit-deadline** setting for session descriptions — no such `CenterSettings` column exists yet (same gap M5 flagged for attendance corrections), so the description edit is unconditional for now. A **"trusted teacher"** flag — the schema has no such column, so every active TEACHER membership at a center is treated as trusted for the class-request form. **Request new session** (`ChangeRequest` type `NEW_SESSION`, spec §4.2 item 2) — only `NEW_CLASS` requests are built.

## M8 — Student portal & discovery/reservation (fast-follow)
**Goal:** students self-serve; the network layer switches on.
**Build:** student schedule (past/future, detail); **Discover** (browse published offerings with filters); reserve/enroll with teacher validation (auto-accept vs confirm) → `Reservation`; my reservations; capacity/duplicate handling.
**Done when:** a student reserves a class, the center/teacher confirms per rule, and the class appears in the student's personal schedule across connected centers.
**Delivered:** `/student/schedule` (upcoming from active enrollments + past from `SessionAttendee` history, unioned per center via `getStudentContexts`, read-only, filterable by date); `/student/discover` (marketplace grid across every active center, docs/04 §10, subject/grade/day filter pills, subject-accent top border, status badge, teacher avatar+local-name, price via `lib/format.ts`, respecting `acceptsNewStudents` and both `StudentBlock` scopes); `/student/reservations` (a student's own PENDING/CONFIRMED/REJECTED/CANCELLED requests across every center, with a cancel action on their own PENDING ones). The write path (`lib/db/reservations.ts`'s `reserveOrEnroll`) branches on `ClassGroup.requiresConfirmation` exactly as specified — instant enroll writes an ACTIVE `Enrollment` directly with no `Reservation` row at all; confirmation-required writes a PENDING `Reservation`, reusing the same row across a reject/re-request cycle rather than erroring on the `(classGroupId, studentId)` unique constraint. A brand-new sign-up with zero relations anywhere can still reach Discover and make their first reservation/enrollment — `requireStudentUser()` (`lib/auth/tenant.ts`) is a looser gate than `requireExperience`, requiring only a signed-in `User`; `/select-center`'s empty state now links to Discover as the way out of what was previously a dead end for a self-registering student (docs/02 §4). Gated by `npm run check:student-portal` (`scripts/student-portal-check.ts`) — instant-enroll vs. requires-confirmation branching, capacity enforcement (checked at request time for instant-enroll, deferred to confirm time for requires-confirmation), duplicate-reservation/duplicate-enrollment prevention, both `StudentBlock` scopes, and the shared-teacher-style cross-center isolation scenario.
**Not built in M8** (tracked as a fast-follow, not silently dropped): the **Approvals** screen a confirmation-required reservation needs — still missing, flagged at M6, M7, and now here a third time. `confirmReservation`/`rejectReservation` (`lib/db/reservations.ts`) are real, transaction-safe, capacity/block-rechecking functions with full gate coverage, but nothing in the product UI calls them yet — until Approvals exists, a confirmation-required class cannot actually be confirmed except by direct script/database access, which is the gate script's own path today. Discover's subject/grade filters match on center-local master-data *names*, not ids, and are applied to the full combined result set in the application layer rather than pushed into each center's database query (docs/02 §14) — fine at Phase 1's pilot scale, a deliberate simplification to revisit if the platform grows past a handful of centers.

## M9 — Super Admin (platform)
**Goal:** operate the platform safely.
**Build:** create/activate/suspend center tenants; plan/onboarding metadata; controlled privileged support access (audited); platform KPIs (active centers/teachers/students, sessions, adoption); global reference data where appropriate.
**Done when:** a new center tenant can be provisioned end-to-end from the admin panel, and privileged access to tenant data is logged.

## M10 — Hardening, QA & pilot-readiness
**Goal:** trustworthy enough to run a real center.
**Build:** run **all 15 acceptance scenarios** as automated + manual tests; performance pass on rush attendance; audit coverage; backups + tested restore; error monitoring; data import (onboarding) + export (offboarding); privacy review for minors' data; seed a realistic demo center for meetings.
**Done when:** every acceptance criterion in `00-master-product-spec.md` §7 passes, and one real center can run a day of live sessions in a preview environment.

---

## Sequencing notes
- **Demo shell** can be pulled forward: after M0–M1 + a themed M5 with seed data, you have a clickable, brand-swappable demo for owner meetings — even before the deeper milestones are complete.
- **Multi-center** is proven at M2 (config) and M7 (teacher portal), not bolted on at the end — the architecture carries it from M1.
- **Money** is concentrated in M5/M6 and gated hard by tests. Treat those gates as non-negotiable.
- Each milestone = one durable Claude Code working session (or a few), starting from `CLAUDE.md` + the relevant doc section, so context cost stays low.
