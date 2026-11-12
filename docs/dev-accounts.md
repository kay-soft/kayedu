# KayEdu — Dev accounts (demo seed)

> Every account the demo seed (`npm run db:seed`, `prisma/seed.ts`) owns in Supabase Auth. **All fictional, all on one reserved domain: `@example.com` by default, or whatever `SEED_EMAIL_DOMAIN` says in your `.env`** (the table below is regenerated for the configured domain by `npm run seed:docs`). The password of every one is the value of **`SEED_PASSWORD`** in your `.env` (≥ 6 characters, never committed, never printed by any script) — **except the platform admin**, whose password is **`SEED_ADMIN_PASSWORD`** (≥ 6 characters and different from `SEED_PASSWORD`; SEC-2a, D-21). Sign in at `/en/login` or `/ar/login`.
>
> The blueprint these come from is `prisma/seed-data/plan.ts` — `npm run seed:verify` checks this file lists every account in it, at the configured domain.

## Accounts

<!-- accounts:start -->
| Email | Person | Role | Centre |
|---|---|---|---|
| `admin@example.com` | Sherine Abdelhamid | Platform admin (Super Admin) | — (whole platform) |
| `owner.center60@example.com` | Tarek Hegazy | Owner (organization level — both branches) | Center 60 — Downtown |
| `manager.downtown@example.com` | Hala Mostafa | Manager | Center 60 — Downtown |
| `receptionist.downtown@example.com` | Mina Gerges | Receptionist | Center 60 — Downtown |
| `accountant.downtown@example.com` | Ehab Lotfy | Accountant | Center 60 — Downtown |
| `manager.nasrcity@example.com` | Wael Shaker | Manager | Center 60 — Nasr City |
| `receptionist.nasrcity@example.com` | Noha Fouad | Receptionist | Center 60 — Nasr City |
| `accountant.nasrcity@example.com` | Samar Khalil | Accountant | Center 60 — Nasr City |
| `owner.nokhba@example.com` | Hisham Badawy | Owner | Al Nokhba Academy |
| `receptionist.nokhba@example.com` | Rasha Younes | Receptionist | Al Nokhba Academy |
| `owner.onboarding@example.com` | Mervat Salah | Owner | Al Amal Learning Hub (ONBOARDING) |
| `owner.suspended@example.com` | Kamal Osman | Owner | Future Skills Academy (SUSPENDED) |
| `teacher.shared@example.com` | Hesham Mansour | Teacher | Center 60 — Downtown + Center 60 — Nasr City |
| `teacher.downtown@example.com` | Mona El-Sayed | Teacher | Center 60 — Downtown |
| `teacher.nasrcity@example.com` | Salma Reda | Teacher | Center 60 — Nasr City |
| `teacher.crossorg@example.com` | Mahmoud Gaber | Teacher | Center 60 — Nasr City + Al Nokhba Academy |
| `teacher.new@example.com` | Walid Ashour | Teacher (no centre yet — requests to teach) | — |
| `student.downtown@example.com` | Youssef Hassan | Student | Center 60 — Downtown |
| `student.both@example.com` | Farida Salah | Student (studies at both organizations) | Center 60 — Downtown + Al Nokhba Academy |
| `student.nasrcity@example.com` | Mariam Ibrahim | Student | Center 60 — Nasr City |
| `student.new@example.com` | Omar Metwally | Student (no centre — has a pending reservation) | — |
| `parent.family@example.com` | Hanan Kamel | Parent (2 linked children) | Center 60 — Downtown + Nasr City |
| `parent.nokhba@example.com` | Ashraf Salah | Parent (one child at two branches) | Al Nokhba Academy + Center 60 — Downtown |
| `teacher.premium@example.com` | Amira Soliman | Teacher, premium (Downtown class + a personal workspace) | Center 60 — Downtown + workspace “Premium Physics” |
| `teacher.expired@example.com` | Khaled Fawzy | Teacher, premium lapsed (workspace only, read-only) | workspace “Chemistry Circle” |
| `assistant.premium@example.com` | Laila Hamdy | Assistant of teacher.premium (Full) | — (works at Downtown and in the workspace) |
| `assistant.checkin@example.com` | Bassem Naguib | Assistant of teacher.premium (Custom: check-in + payments) | — (works in the workspace “Premium Physics” only) |
| `student.workspace@example.com` | Seif Ragab | Workspace student (linked by invitation) | workspace “Premium Physics” |
| `student.invited@example.com` | Malak Ezzat | Student (with a pending workspace invitation) | Center 60 — Downtown |
| `multi.experience@example.com` | Rami Wahba | Teacher + student + parent (the role switcher) | Center 60 — Downtown (+ student.new's parent) |
<!-- accounts:end -->

## What each should see

Navigation is gated on the stored permission matrix (`PermissionGrant`), with each item showing on exactly the permission its page asserts (docs/02 §6.2). A freshly provisioned centre carries the baseline from `provisionCenterBaseline`, so:

| Role | Sidebar |
|---|---|
| Owner / Manager | Dashboard · Reception · Sessions · Approvals · Classes · Students · Teachers · Analytics · Expenses · Refunds · Settlements · Audit trail · Settings |
| Receptionist | Dashboard · Reception · Sessions · Students |
| Accountant | Dashboard · Analytics · Expenses |
| Teacher (with a branch; premium or not — premium does not change the nav) | Dashboard · Sessions · Calendar · Students · Classes · Exams & homework · Approvals · Earnings · Settlements · Assistants · Workspaces · Profile |
| Teacher with only a workspace (`teacher.expired`) | Workspaces · Calendar · Exams & homework · Earnings · Assistants · Branches |
| Assistant, Full (`assistant.premium`) | Home · Exams & homework · Classes · Workspaces · Requests · Overview · Earnings |
| Assistant, custom check-in + payments (`assistant.checkin`) | Home · Workspaces |
| Student | Schedule · Calendar · Exams & homework · Discover · Reservations |
| Parent | Schedule · Calendar |
| Platform admin | Centers · Platform · Catalog · Teachers (W6: premium by exact email) |

The teacher, workspace-only and assistant lists are the hand-written oracles in `scripts/lib/expected-nav.ts` (`EXPECTED_TEACHER_NAV`, `EXPECTED_WORKSPACE_ONLY_TEACHER_NAV`, `EXPECTED_ASSISTANT_NAV`); `seed:verify`, `check:permissions` and `e2e/navigation.spec.ts` read them.

`owner.suspended@example.com` resolves no centre at all and is sent to the select-centre screen's empty state; `owner.onboarding@example.com` signs in normally. A parent with a linked child lands on `/parent` (SYS — the select-centre hub used to tell them they were not connected to a branch); `teacher.new@example.com` lands on the hub, whose "Find a branch to teach at" leads to the directory, and any `/teacher/*` URL sends them there directly. `npm run e2e` (SYS) signs in as these accounts and checks each row of this table.

## The world behind them

- **Organization "Center 60"** — two branches, **Downtown** (centre data window **30 days**, teacher window 30) and **Nasr City** (centre window **60 days**, teacher window 30, a styled ID card). One org-level Owner; per branch a Manager, Receptionist and Accountant; six teachers at Nasr City and **eight at Downtown** (Hesham Mansour teaches at both; Mahmoud Gaber also teaches at Al Nokhba; X1 adds teacher.premium and multi.experience at Downtown); five rooms each with two joinable pairs; **56 students and 11 classes at Downtown** (X1 adds teacher.premium's class and its ten new students), **45 students and 10 classes at Nasr City**. Downtown has a custom payment method ("Bank transfer").
- **Branch limits (F1, U5)** — Center 60 may have **3** branches (it has two, so the platform admin can add one more at **Branches → Add to an existing center**; a fourth is refused until the limit is raised at **Branches → Centers & branch limits**). Al Nokhba Academy and both test centres have a limit of **1** and are at it. Re-running the seed puts these limits back. Since U5 **no centre account can add, edit, pause or delete a branch** — there is no Settings → Branches; the platform admin does all of it from `/admin/centers/[id]` and `/admin/organizations/[id]`.
- **Organization "Al Nokhba Academy"** — one smaller branch (20 students, 4 classes): the isolation test bed. Farida Salah studies here *and* at Downtown.
- **Two sign-in test centres** — Al Amal Learning Hub (ONBOARDING) and Future Skills Academy (SUSPENDED), one staff account each.
- **Catalog** — three education systems (Egyptian National, American, IGCSE), 19 grades and **11 subjects, each once**, linked to the grades that teach them (71 subject–grade links — Mathematics alone to 14 grades across the three systems), all bilingual (U3).
- **History** — the last five weeks of closed sessions (≈ 80% present, 10% late, 10% absent; payments over Cash / InstaPay / Vodafone Cash and the custom method; a few live absent-switch voids; one auto-closed, one cancelled session per branch), then **today, relative to when you ran the seed**: a live session (started earlier today, not ended), upcoming sessions, a one-time session, an extra session and one rescheduled session.
- **Money and workflow** — settlements (one PAID, one APPROVED, one DRAFT per Center 60 branch), expenses in Rent / Salaries / Utilities / Supplies / Marketing, ratings inside the last seven days (the three signed-in students' own sessions are left unrated so the pop-up appears), reservations (pending, confirmed, and rejected inside the 7-day cooldown) and teacher change requests (NEW_CLASS, NEW_SESSION, and a zero-centre teacher's request to teach).
- **Not signed-in people** — about 110 students, parents' phone numbers and the other teachers are real rows with no login. Their emails are `@example.com` too and mean nothing.
- **Phones** are stored in E.164, `+201XXXXXXXXX` (010 / 011 / 012 / 015), produced through `lib/phone.ts`, and shown as `+20 1XX XXX XXXX`; you can search by any spelling (`0101…`, `+20 101…`); no photos exist (`photoUrl` is empty).

## Bookable classes — single-session attendance (F6, seeded since U3)

Three existing term-long classes take single-session bookings. Each has sessions every week of the coming two weeks and enrolled students, so its seats are partly used. Book from **Discover → the class → Upcoming sessions** with a student who is **not** enrolled in it (an enrolled student is refused as already enrolled).

| Branch | Class | Booking | Test with |
|---|---|---|---|
| Center 60 — Downtown | **English · Primary 6** (Karim, Wednesdays 16:00–17:30) | **Instant**, at most **3** bookings per session | `student.nasrcity@…` (Mariam) — the fourth booking on one session is refused |
| Center 60 — Downtown | **English · Grade 10** (American, Karim, Thursdays 17:00–19:00) | **Instant**, no booking cap (only the room's seats) | `student.nasrcity@…` (Mariam) |
| Center 60 — Nasr City | **Mathematics · Secondary 3** (Hesham, Sundays 15:00–17:00) | **Needs approval** — the booking waits in Nasr City's Approvals and Hesham's own queue | `student.downtown@…` (Youssef); approve as `manager.nasrcity@…` or Hesham, `teacher.shared@…` |

To reach a cap of 3 on one session, book it as Mariam, then as Youssef and Farida (`student.both@…`), then try a fourth student — or a fresh sign-up. `seed:verify` asserts the three classes, their modes and caps, that each has sessions in the coming two weeks, and that its enrolments leave seats free.

## Family links and the two dev parent codes (F3)

Parents are linked to children by one-time codes (`docs/00-master-product-spec.md` §5.1 "Parent role & portal"). The seed links them through the real code paths, and leaves **two waiting codes** with fixed, **dev-only** plaintexts so a tester can link a parent by hand. Every other code is random, shown once and stored only as its hash — these two are known only because this file prints them.

| Code | What it is | Use it to test |
|---|---|---|
| `SEED-PRNT` | **Farida Salah's** (`student.both@…`) own invitation for a second parent, "Nadia Salah" (a student invitation) | Sign up a new account (not a student), open `/en/family/join#SEEDPRNT` and link — Farida then appears at both her branches. Farida's Account → Family shows it as waiting until then. |
| `SEED-BRCH` | **Center 60 — Downtown's** printed code for **Mazen Kamel**, who has no login (a branch code) | The same, at `/en/family/join#SEEDBRCH` — a code for a student with no account. Downtown's student page for Mazen shows it waiting ("ending CH"). |

- **`parent.family@…`** (Hanan Kamel) — two linked children: **Yara** (Downtown, by Yara's own invitation) and **Ziad** (Nasr City, by Nasr City's printed code). Mazen's code is the waiting one above.
- **`parent.nokhba@…`** (Ashraf Salah) — one child, **Farida**, linked by Al Nokhba's printed code; she studies at Al Nokhba **and** Downtown, so both appear in the child selector.
- On a database that had the old verified `ParentLink`s, the F3 migration already copied them into family links (shown as "Linked before codes"); the seed then leaves those links as they are.
- Each code works **once**. After one is used, re-running the seed reports it as `ACCEPTED`; to test again, use the student or branch screens to make a fresh code. **Never** seed these codes into a production project (the seed refuses one anyway).

## Premium, assistants and workspaces (W6–W10, seeded since X1)

The seed's X1 phase (`prisma/seed-data/w-world.ts`) builds this through the W writers, after the branches, their history and the families. **Only `teacher.premium` and `teacher.expired` are ever premium in the seed**; `teacher.downtown` (the free teacher, and the e2e premium target), `teacher.shared` and every other seeded account never are.

| Account | What it shows | Try |
|---|---|---|
| `teacher.premium@…` (Amira Soliman) | Premium for about a year from the seed run (granted by the seeded platform admin through W6). A TEACHER at **Downtown**, teaching **Physics · Secondary 2** (Thursdays 15:00–16:30, Lab, **FIXED 30 EGP** of 150 EGP — the branch cut, from tomorrow on; no history and no money, so Downtown's analytics and settlements are unchanged), and the owner of the workspace **"Premium Physics"**. The teacher nav is the same as any teacher's. | Workspaces → Premium Physics: Classes, Students, Sessions (today's live one), Settings; Assistants (two linked, one waiting invite); Earnings (Downtown + the workspace, the workspace never settled); Exams & homework with the Source filter. |
| `teacher.downtown@…` (Mona El-Sayed) | The **free** teacher: never premium, no workspace, no assistant. Assistants and Workspaces show the premium card ("Contact KayEdu") and no action. | Compare with teacher.premium. |
| `teacher.expired@…` (Khaled Fawzy) | Premium that **has lapsed** (granted on a clock 50 days back, ending 40 days later). No branch: the workspace-only shell. Its workspace **"Chemistry Circle"** has one class, one student and one closed past session, all **read-only** with the "renew premium" banner; Earnings reads it; Assistants shows its one assistant with **Remove** only (revoking and removing need no premium, D-W37). | Try to add a student or a session: refused. |
| `assistant.premium@…` (Laila Hamdy) | teacher.premium's assistant on the **Full** preset — every key but `students.phones`. Works at Downtown (Exams & homework, Classes, Requests, Overview) and in the workspace (check-in, payments, Earnings). It is also teacher.expired's assistant, but that link is **not effective** while the premium has lapsed, so that teacher's name is never shown. | Account → Assistant roles lists one teacher. Check a student in on today's workspace session. |
| `assistant.checkin@…` (Bassem Naguib) | teacher.premium's assistant, invited as **Co-teacher**, then cut down to **`checkin.workspace` + `payments.workspace`** — the teacher's page reads **Custom**. The workspace keys grant nothing at a branch, so this assistant does nothing at Downtown, and with no `analytics.view` sees no Earnings. | Only Home and Workspaces in the sidebar; check in and take a payment on the live workspace session. |
| `student.workspace@…` (Seif Ragab) | A login whose User.phone the teacher typed: the invitation was **accepted**, so the profile in Premium Physics is linked (no branch profile). Enrolled in the workspace's Physics · Secondary 3 class; has submitted the closed workspace exam. | Calendar shows the workspace sessions tagged Private; Exams & homework shows the open quiz, the homework and the revealed "Forces test". |
| `student.invited@…` (Malak Ezzat) | A Downtown student (enrolled in teacher.premium's Downtown class) whose User.phone matches a **PENDING** invitation from Premium Physics. | The bell and the hub show the invitation; Accept or Decline. |
| `multi.experience@…` (Rami Wahba) | **The one seeded multi-experience account** (W5): a TEACHER at Downtown (no classes), a Downtown student (in teacher.premium's class), and the parent of `student.new`. The parent link is a **fixture** the writer would refuse (a student account cannot accept a parent code), inserted in the shape `e2e/experience-switcher.spec.ts` uses; that spec still inserts its own account. | Sign in: the hub offers Teacher, Student and Parent; switch between them from the header. |

**The workspace "Premium Physics".** Two classes, both at the forced **PERCENTAGE 0** cut (a workspace class is never FIXED, D-W24): Physics · Secondary 3 (Sundays 19:00–20:30, 200 EGP) and Physics · Secondary 2 (Wednesdays 19:00–20:30, 150 EGP). Nine students: six typed with a phone only, `student.workspace` (linked), `student.invited`'s typed profile (invitation pending) and **Hazem Lotfy** (unlinked, holding the dev share code). The last 45 days are closed sessions with check-ins and payments over the hidden **Cash** method, with **one void** and **one refund**, so Earnings shows payments − refunds (`seed:verify` prints the reconciliation). After 00:40 Cairo the seed also starts an extra session about 20 minutes before it runs, partly checked in and partly paid (through the real workspace writers), so check-in, pay and End session can be tried. Exams and homework: "Kinematics quiz" (open now), "Forces test" (closed, score and answers revealed), "Homework: motion graphs" (published) and "Energy exam (draft)".

**Downtown, teacher.premium's class.** student.downtown, student.invited, multi.experience and eight new students without a login. "Electricity quiz" (open now), "Homework: circuits" (published), "Waves exam" (closed, score and answers **revealed**) and "Optics exam" (closed, **still hidden** — no score, no answers). student.downtown has taken both closed exams, and the published ones raise **student.downtown's bell**. **teacher.premium's bell stays empty by design:** no notification kind is addressed to a teacher (W1, D-W12).

### The two dev assistant and share codes

Like the parent codes above: fixed, **dev-only** plaintexts, stored only as their sha256 through the writers' own hash function. Every other code is random, shown once and never stored.

| Code | What it is | Use it to test |
|---|---|---|
| `SEED-ASST-NVTE` | **teacher.premium's** unredeemed assistant invite (Co-teacher preset) | Sign in as any account that is not teacher.premium (a fresh sign-up, or e.g. `student.nasrcity@…`), open **Join as an assistant** (`/en/assistant-join`), type the code and Confirm. teacher.premium's Assistants page lists it as waiting until then. |
| `SEED-SHRE-KEYS` | The **share code** of Hazem Lotfy, an unlinked typed profile in Premium Physics | Sign in as an account with no profile in that workspace, open the join link (`/en/workspace-join#SEEDSHREKEYS`, or type the code), confirm — the profile is linked. The Students tab shows the code active until then. |

- Each code works **once**. Both expire **7 days** after the seed run that last touched them. **Re-run `npm run db:seed` to renew an expired dev code**: a waiting code (unused, unrevoked) gets a fresh 7-day expiry — a direct update of its `expiresAt` only; a used or revoked code is never touched or resurrected. `seed:verify` checks that both are waiting and unexpired right after a seed.
- **Never** seed these codes into a production project (the seed refuses a production target anyway).
- On a throwaway **local** database (no Supabase Auth) the accounts have no login, so the two workspace invitations are not sent and `seed:verify` skips the checks that need a login.

## Running it

```text
npm run seed:preflight           # BEFORE the wipe: password, project refs, service-role key, one probe auth user (created, read back, deleted)
(bash) export ALLOW_DEV_WIPE=yes      (PowerShell) $env:ALLOW_DEV_WIPE="yes"
npm run db:wipe-dev              # you type the project ref to confirm
npm run db:seed                  # re-runs the same Auth check first; safe to run again if it is interrupted
npm run seed:verify
(bash) unset ALLOW_DEV_WIPE           (PowerShell) Remove-Item Env:ALLOW_DEV_WIPE
```

The wipe empties the application tables only. It never touches `_prisma_migrations`, the `auth` / `storage` schemas, RLS settings or any Supabase-owned object — so Supabase Auth users from earlier seeds stay.

**Auth users the seed does not own.** The seed stamps each account it creates with a marker (`app_metadata.kayedu_seed`, writable only through the admin API) and resets only accounts that carry it. An auth user outside its list is never modified or deleted — the preflight and the seed's summary list them. If an auth user already has a *seed address* but no marker, the preflight fails and the seed refuses to run rather than reset someone else's password: delete it in the Supabase dashboard or pick another `SEED_EMAIL_DOMAIN`.

**After the wipe, an old account that signs in** (one of the other auth users above, e.g. your own) still authenticates — Auth was not touched — but its application `User` row is gone, so the first request creates a fresh, blank one: no centre, no role, `isPlatformAdmin` false. It lands on the select-centre / Discover empty state. Use `admin@…` for the platform admin, or re-flag your own user afterwards (`UPDATE "User" SET "isPlatformAdmin" = true WHERE email = '…'`, in the Supabase SQL editor).
