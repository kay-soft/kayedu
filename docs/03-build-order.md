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

## M8 — Student portal & discovery/reservation (fast-follow)
**Goal:** students self-serve; the network layer switches on.
**Build:** student schedule (past/future, detail); **Discover** (browse published offerings with filters); reserve/enroll with teacher validation (auto-accept vs confirm) → `Reservation`; my reservations; capacity/duplicate handling.
**Done when:** a student reserves a class, the center/teacher confirms per rule, and the class appears in the student's personal schedule across connected centers.

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
