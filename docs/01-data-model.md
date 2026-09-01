# KayEdu — Data Model (Phase 1)

> The **why** behind the schema. The **what** lives in `/prisma/schema.prisma`. Read this before touching the schema, and update both together.

---

## 1. Four design principles (memorize these)

**1. Identity is global; everything else is scoped.**
A `User` is one person, once, platform-wide. Their relationship to a center is a separate `Membership` (for staff/teachers) or `Enrollment` (for a student in a class). Attendance, payments, and analytics attach to the **scoped** record, never to the raw `User`. This is what makes "one identity across many centers" work without duplicates.

**2. Every tenant-scoped row carries `centerId`.**
Not database-per-center — one database, and `centerId` is on every table that belongs to a center. It's indexed, and it's the key that isolation is enforced on (app layer + Postgres RLS as backstop). Global tables (`User`, `Center`, platform tables) are the only ones without it.

**3. Money is append-only and snapshotted.**
A `Payment` row **freezes** the price, the center's share, and the teacher's share at the moment it's recorded. Historical money is **never** recomputed from current settings. Corrections create new, audited records — they don't overwrite. This single rule is why centers will trust the numbers.

**4. The roster is decoupled from enrollment.**
A `SessionAttendee` can exist **with** an enrollment (regular student) or **without** one (drop-in / one-time). Attendance and payment therefore never *require* an enrollment. This keeps the pay-per-session, drop-in-friendly reality of Egyptian centers modelled correctly.

---

## 2. Entity map by layer

### Identity layer (global — no `centerId`)
- **User** — the person. Auth via Supabase; profile fields here (name, phone, altPhone, email, avatar, locale, `isPlatformAdmin`).

### Organization layer
- **Center** — the tenant. `slug` (for subdomain/branding), `name`, `logoUrl`, theme color, `active`, plan/onboarding metadata.
- **Branch** — physical location under a center.
- **CenterSettings** — one row per center: default center-cut mode/value, teacher-timeout days (`null` = disabled, never `0`), card-layout JSON, timezone, late-threshold default, **`scheduleConflictPolicy`** (`WARN` default | `DENY` — whether a teacher/room double-booking is saved-and-flagged or refused outright, docs/02 §11), and the **permission-grant toggles** (`receptionistCanViewProfit`, `receptionistCanCorrectAttendance`) — both `false` by default and read only through `permissionGrantsFromSettings()` (`02-architecture.md` §6). Configured from the Settings screens (M2/M4); the row is upserted, so a center provisioned without one is still configurable.
- **Membership** — `userId × centerId × role` for **Owner / Manager / Receptionist / Teacher**. `active`, invite metadata, a (currently unused) financial-visibility flag, and a **center-local name + contact record** (`firstName`/`lastName`/`email`/`phone`/`altPhone`, see §6).
- **Invitation** — pending email invite: `centerId`, email, role, token, status, expiry.

### Academic / config layer (all `centerId`-scoped)
- **EducationSystem** — name (وطني/لغات/IG/…) + base price.
- **Grade** — name + educationSystem link.
- **Subject** — name + grade link.
- **Room** — belongs to a branch; name/number + capacity.
- **ClassGroup** — the class: teacher, subject, grade, educationSystem, room, price, **centerShareType (FIXED|PERCENTAGE) + centerShareValue**, capacity (`0` = unlimited, same convention as `Room.capacity`), `attendanceRequired`, `lateThresholdMinutes`, `acceptsNewStudents`, `requiresConfirmation`, `active`. One room per class — not one per slot (see the `ClassSchedule` note below).
- **ClassSchedule** — recurring slot(s) for a class: dayOfWeek, startTime, endTime. (A class can have several.) No `roomId` of its own: the class's single `ClassGroup.roomId` is what teacher/room conflict detection checks against every other class's slots (`lib/scheduling.ts`'s `findScheduleConflicts`), and it's what the class detail page shows in its read-only context panel (docs/04 §9, revised from the original per-slot-room mockup).

### People-in-center layer
- **StudentProfile** — a student's per-center record: `userId × centerId`, grade, a **center-local name + contact record** (`firstName`/`lastName`/`email`/`phone`/`altPhone` — see §6), parent name/phone/altPhone, `studentCode` (the ID-card number, unique per center, **system-assigned** — see §6), `photoUrl`, active. (Per-center so centers own their data and grade taxonomy is center-local.) The **photo lives here, not on `User.avatarUrl`**: a picture a center took for its own ID card is that center's data, is stored under `avatars/{centerId}/…`, and must not follow the person to another center. `User.avatarUrl` stays the person's own global avatar.
- **StudentCodeCounter** — `centerId` (PK), `next`. One row per center; the race-free source of the next `studentCode` (§6). Not a business entity a screen shows — a plumbing table for `lib/db/students.ts`.
- **Enrollment** — `studentProfile × classGroup`: status (ACTIVE/REMOVED/BLOCKED), enrolledAt. Unique on `(studentProfileId, classGroupId)` — the row is reused across its lifecycle rather than recreated: REMOVED frees the seat, BLOCKED means a `StudentBlock` (scope CLASS) currently sits on top of what was an active enrollment, and un-blocking restores it to ACTIVE rather than creating a fresh row (M4, `app/[locale]/(center)/classes/actions.ts`).
- **StudentBlock** — a teacher or class blocking a student: `centerId`, scope (TEACHER|CLASS), refId, blockedUserId, reason. Unique on `(centerId, scope, refId, blockedUserId)` — blocking the same student twice is a bug — and indexed on `(centerId, scope, refId)` because "is this student blocked here?" is a hot lookup on the enrol/add path. A block is **per center**: a teacher shared by two centers who blocks a student at one has not blocked them at the other. Scope CLASS (`refId` = a `ClassGroup` id, M4) is enforced at enrollment time exactly like scope TEACHER already was at M3 — the same `studentBlocks.isBlocked()` helper, just a different scope/refId pair.

### Session & attendance layer (all `centerId`-scoped)
- **Session** — one dated instance: classGroup, teacher, room, date, start/end, status (SCHEDULED/LIVE/COMPLETED/CANCELLED), `priceSnapshot`, description. Unique on `(classGroupId, date, startTime)` — the key the session generator's idempotent regeneration (M4, `lib/db/sessions.ts`) relies on: a `createMany({ skipDuplicates: true })` against it never creates a second row for a slot a previous run already materialized.
- **Holiday** — a center's own holiday calendar (M4): `centerId`, `date`, an optional `name`. Unique on `(centerId, date)`. Not itself a business screen a role opens daily — it's the input the session generator (`lib/db/sessions.ts`) skips dates against, edited from a small panel on `/classes` (docs/02 §11).
- **SessionAttendee** — roster row: session, `studentProfileId?` (null-safe for pure drop-ins), `enrollmentId?` (null for drop-ins), `attendanceStatus` (PRESENT/LATE/ABSENT/EXCUSED), `isDropIn`, recordedBy, recordedAt.
- **Payment** — the ledger row (see §3): session, sessionAttendee, studentProfile, amount, method, **priceSnapshot, centerShareSnapshot, teacherShareSnapshot**, receiptRef, recordedBy, recordedAt.

### Finance-adjacent layer
- **ExpenseCategory** / **Expense** — center expenses with category, amount, date.
- **Settlement** *(summary, not source of truth)* — optional roll-up of a teacher's payable over a period, computed **from** the frozen `teacherShareSnapshot` values. Source of truth is always the `Payment` rows.

### Workflow layer
- **Reservation** — student's request to join a class: status (PENDING/CONFIRMED/REJECTED/CANCELLED). (Fast-follow feature.)
- **ChangeRequest** — teacher's request to add a class/session at a center: type, payload JSON, status, resolvedBy. Feeds the Approvals screen.

### Platform / trust layer
- **AuditLog** — `centerId?`, actorUserId, action, entityType, entityId, before/after JSON, createdAt. Written for financial, permission, and attendance-correction changes.

---

## 3. The financial ledger — the part to get perfectly right

**The flow of one paid attendance:**

1. A `Session` is generated from a `ClassGroup`. At generation it copies the class price into `session.priceSnapshot` (so a mid-window price change doesn't rewrite already-generated sessions unexpectedly — the manager can still edit a specific session's price before it runs).
2. At the desk, the student is marked on the roster → a `SessionAttendee` row (Present/Late, `isDropIn` true or false).
3. Payment is confirmed → a `Payment` row is created, and **at that instant** we compute and freeze:
   - `amount` = what was collected (normally = session price).
   - `centerShareSnapshot` = `centerShareType == FIXED ? centerShareValue : round(amount * centerShareValue / 100)`.
   - `teacherShareSnapshot` = `amount − centerShareSnapshot`.
   - `priceSnapshot` = the session price at that moment.
4. These three snapshots are **immutable**. Analytics and settlements read them directly; they never recompute from the class config.

**Why snapshots, concretely:** teacher raises their price / center changes its cut in March. February's already-recorded payments must still show February's split, or a teacher will (rightly) dispute the books. Recomputing live is the classic bug that loses a client. Snapshot = the books are always internally consistent and auditable.

**Corrections & refunds:** never `UPDATE` a `Payment`'s money fields. Instead mark it `voided` (with reason + `AuditLog`) and, if needed, write a corrected `Payment`. History stays intact.

**No debt:** there is no balance table. If a student didn't pay, there's simply no `Payment` row — they're an unpaid/absent attendee. Nothing owes anything.

**Rounding rule:** percentage cuts round to the nearest piastre (`Math.round`); document any change here because it affects totals.

---

## 4. Multi-tenant isolation strategy

**Primary defense — application layer.** Every tenant-scoped query goes through a helper that requires a resolved `centerId` from the session context and injects it into the `where`. No raw `prisma.session.findMany()` without a center scope — that's a lint/review red flag. A `getTenantContext()` resolves the current user's membership + active center on every request.

**Backstop defense — Postgres Row-Level Security.** RLS policies on tenant tables ("a row is visible only if its `center_id` is in the caller's memberships") catch anything the app layer misses. Belt and suspenders. *(Exact Prisma-plus-Supabase-RLS wiring is documented in `02-architecture.md`, because it needs care — Prisma can bypass RLS if connected as the wrong role.)*

**Teacher cross-center visibility.** A teacher's portal queries span the centers they're a member of, but each center's rows are still filtered by that membership's granted visibility. Combined views are unions of permitted per-center data — never a bypass of scoping.

**The two isolation tests that must pass** (from the spec's acceptance criteria): shared-teacher no-leak, and Center-X-can't-read-Center-Y-by-ID. Write these as automated tests early.

---

## 5. Key relationships (quick reference)

```
User 1─* Membership *─1 Center
User 1─* StudentProfile *─1 Center
Center 1─* Branch 1─* Room
Center 1─* EducationSystem 1─* Grade 1─* Subject
ClassGroup *─1 Subject / Grade / EducationSystem / Room / Center
ClassGroup (teacher) *─1 User        (must have a teacher Membership at that Center)
ClassGroup 1─* ClassSchedule
ClassGroup 1─* Session
StudentProfile 1─* Enrollment *─1 ClassGroup
Session 1─* SessionAttendee *─0..1 StudentProfile
SessionAttendee 1─0..1 Payment
Center 1─* Expense *─1 ExpenseCategory
Center 1─* Holiday
```

---

## 6. Naming & convention notes

- Tables/models: PascalCase singular (`ClassGroup`). Enums: PascalCase. Fields: camelCase in Prisma (maps to snake_case columns via `@map` if preferred).
- Every tenant table: `centerId String` + `@@index([centerId])`, and compound indexes on hot query paths (e.g. `@@index([centerId, date])` on `Session`).
- Timestamps: `createdAt`, `updatedAt` everywhere.
- Money: store EGP as **integers in piastres** (i.e. `Int`, amount × 100) to avoid floating-point money bugs — or `Decimal`. **Decision: use `Int` piastres.** Document any display conversion in one place.
- Soft-delete the things centers care about auditing (students, teachers, classes) via `active`/`deletedAt` rather than hard delete.
- **People deletion is a relationship deletion.** Deleting a teacher removes their `Membership` at that center; deleting a student removes their `StudentProfile`. Both are refused while history exists — a teacher with classes/sessions, a student with attendance or payments — and the center is told to deactivate instead, because money and attendance are append-only (§3). The global `User` row survives, and is removed only when the person has never signed in (`authId` is null) and holds no other membership or student profile anywhere: someone this platform created who now exists nowhere. Both deletions write an `AuditLog` row, as do block and unblock.
- **Name, like contact, is center-local — nothing about a person's record is global-locked (revised again).** `StudentProfile` and `Membership` each carry their own `firstName`/`lastName` alongside `email`/`phone`/`altPhone`. When a center's record is created — registering a student, adding a teacher — the local name is **seeded** from the relevant `User`: for a brand-new person it's simply what was typed on the form (`createPerson()` in `lib/db/identity.ts`); for a person who matched an existing identity it's that person's **actual** name (`seedLocalName()` in `lib/db/identity.ts`), not whatever staff happened to type before the match was found. From that moment on the local name is editable at that center **immediately, with no lock of any kind** — a teacher shared by two centers can have a different spelling, nickname, or even a different name at each. `User.firstName`/`User.lastName` stay the platform-wide default (still required, since `User` must always have a name to exist as a person) and are never written back to by a center's edits — `localName()` in `lib/identity.ts` reads the local value and falls back to the global one only for the rare record whose local name was never seeded (a `Membership` created through the older staff-invite path, which this predates and does not touch). Fully symmetric with contact now: nothing on a `StudentProfile`/`Membership` is gated by sharing or by whether the person has signed in.
- **Duplicate-matching searches three tables, not one.** `findPeopleByContact()` (`lib/db/identity.ts`) checks the global `User` **and** every center's local `StudentProfile`/`Membership` contact columns, because a person may have been entered somewhere with a contact that never made it onto their global `User`. Zero, one, or two-plus-conflicting matches are the three outcomes the add-teacher/add-student actions branch on (spec §5).
- **Contact details are stored normalized** — email lower-cased, Egyptian mobiles as `01XXXXXXXXX` — so the duplicate match in `lib/identity.ts` cannot be dodged by typing `+20…`. The unique columns are on `User` only; the center-local copies on `StudentProfile`/`Membership` are deliberately **not** unique-constrained — two different people at two different centers can legitimately share a contact string (a shared front-desk phone, a family email), and it is the global `User` uniqueness plus the match workflow that keeps one human one row.
- **Student codes are system-assigned, never typed.** `StudentProfile.studentCode` is claimed from a per-center `StudentCodeCounter` row with one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, inside the same transaction that creates the `StudentProfile` (and the new `User`, when there is one) — see `lib/db/students.ts` (`claimStudentCode`). Postgres's row lock on the counter's primary key makes concurrent claims race-free: two receptionists registering at once still get consecutive, non-colliding numbers. Running the claim and the insert in one transaction means a failure anywhere else rolls both back, so a crash never burns a number into a permanent gap. Codes start at `1001` and are a center's own numbering — the same number legitimately exists in two different centers.
- **Config master data (education systems, grades, subjects, branches, rooms) deactivates by default.** Hard delete is offered in the UI but refused while anything still references the row: these relations are optional FKs, so Postgres would `SET NULL` and silently orphan (a grade losing its subjects, a room losing its sessions) rather than fail. The settings actions count references first and tell the center to deactivate instead.
