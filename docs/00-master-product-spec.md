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

## 3. Roles & permissions

Six roles. Start them **hardcoded** (not a fully dynamic permission engine) with a small number of toggles. Make it configurable *only* if centers demand it.

| Role | Scope | Core capability |
|---|---|---|
| **Super Admin (KayEdu)** | Platform | Create/suspend center tenants, platform KPIs, support, audit. Never browses tenant data casually. |
| **Owner** | One center | Full control of their center: money, staff, config, everything a Manager can do + ownership actions. |
| **Manager** | One center | Runs the center: teachers, classes, students, sessions, analytics, expenses, config, approvals, delete rights, teacher-edit deadlines. |
| **Receptionist** | One center | Daily ops: reception desk, check-in, record attendance + payment, add students, view today's sessions. **Cannot** see center profit/settlement unless granted. |
| **Teacher** | One or more centers | Their own schedule, sessions, students, analytics/earnings **per center per permission**, request new classes/sessions, block students. Only sees data for centers they belong to. |
| **Student** | One or more centers | Discover/reserve classes, see personal schedule, enrollments, own attendance history. |

**Permission rules that matter (Phase 1):**
- A Receptionist seeing **center profit** is **denied by default**.
- A Teacher sees earnings/analytics **only within the visibility that center granted**.
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
9. **Approvals** — review teacher-submitted class/session requests: accept/decline/contact/edit-and-confirm.
10. **System Configuration** — Education Systems (name + base price), Subjects (name + grade), Grades (name + education type), Rooms (number + capacity), Role config, **Teacher Timeout** (days of no completed sessions until inactive, or none), **Card Customization** (position of name/id/logo etc.), Users & Roles (invite by email or add existing user by email).

### 4.2 Teacher portal (cross-center)

0. **Auth** — one login, connects to multiple centers.
1. **Analytics** — filter by center/time/grade: total earnings, total sessions, unique students attended.
2. **Sessions** — search by student; filter date/status/grade; session detail (grade, attendance, absent, earning, center earning, print); future sessions; edit session description; **request new session** (center, free room + time, grade, subject); block student.
3. **Students** — search by code/name/phone; detail shows all sessions this student attended **with this teacher**; block student.
4. **Classes** — request new class at a center where they're a trusted teacher (grade, subject, timing/date range or semester, attendance settings + late threshold, capacity); remove/block students.
5. **Upload files for sessions** — placeholder, details TBD later.

### 4.3 Student portal

0. **Auth** — one login, connects to multiple centers.
1. **Sessions** — filter by date; past + future; session detail visible inline.
2. **Discover & Classes** — browse/enroll in classes, with **teacher-side validation** (does the teacher auto-accept new students or require confirmation).

> **Build-order note:** the student **discovery/reservation** layer is a *fast-follow*, not the first thing built. It only creates value once several centers/classes are published. The center ERP daily loop is built first.

### 4.4 Super Admin (KayEdu platform)

Create/activate/suspend center tenants; manage plans/onboarding metadata; controlled privileged support access; platform KPIs (active centers/teachers/students, sessions, adoption); audit sensitive actions; manage global reference data where appropriate.

---

## 5. Resolved business rules (Phase 1)

**Identity & duplicates.** One `User` per person, keyed on verified phone/email. Registering an existing person at a new center creates a **new membership/enrollment**, never a duplicate person. Duplicate-matching + merge is a defined workflow (details in data model).

**Money — the sacred rules.**
- Charge basis = **one session**. Price comes from the class (or session override).
- The **center's cut** is configured on the class as either `FIXED` (EGP) or `PERCENTAGE`. Teacher share = collected amount − center cut.
- **Snapshot at payment time.** When a payment is recorded, freeze `price`, `center_share`, and `teacher_share` onto the payment row. **Never recompute historical money from current settings.** If a class's cut changes later, past payments keep their old numbers.
- No debt: if a student didn't pay, there's no balance — they're simply an unpaid attendee/absent per the roster, with no money recorded.
- Corrections/refunds are permissioned and audited; a correction writes a **new** audit-tracked change, it does not silently overwrite history.

**Attendance.**
- Statuses: **Present, Late, Absent, Excused** (Excused configurable per class).
- **Late threshold** (minutes) is per class.
- Consecutive-absence and total-absence counts are derived from attendance history and surfaced on the session receipt and student profile.
- Corrections require permission and are audited; sessions have an **edit deadline** for teachers, set by the manager.

**Scheduling.**
- A class can meet on **multiple days/times**.
- Sessions are generated on a rolling window from the class schedule.
- Teacher and room **conflicts** are detected/warned per configured rules.
- Cancel/reschedule updates affected rosters and (later) notifications; material changes are audited.

**Reservations / enrollment.**
- A class flags **accepts-new-students** and **requires-confirmation**. If confirmation is required, a student request is **Pending** until center/teacher accepts; otherwise it's **Confirmed** immediately.
- Capacity is enforced; full-class behavior (reject vs waitlist) is a defined rule (default: block enroll when full).
- Duplicate enroll/reservation is prevented.

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
