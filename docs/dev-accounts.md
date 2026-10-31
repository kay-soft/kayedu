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
<!-- accounts:end -->

## What each should see

Navigation is gated on the stored permission matrix (`PermissionGrant`), with each item showing on exactly the permission its page asserts (docs/02 §6.2). A freshly provisioned centre carries the baseline from `provisionCenterBaseline`, so:

| Role | Sidebar |
|---|---|
| Owner / Manager | Dashboard · Reception · Sessions · Approvals · Classes · Students · Teachers · Analytics · Expenses · Refunds · Settlements · Audit trail · Settings |
| Receptionist | Dashboard · Reception · Sessions · Students |
| Accountant | Dashboard · Analytics · Expenses |
| Teacher | Dashboard · Sessions · Students · Classes · Approvals · Settlements |
| Student | Schedule · Discover · Reservations |
| Parent | Schedule |
| Platform admin | Centers · Platform · Catalog |

`owner.suspended@example.com` resolves no centre at all and is sent to the select-centre screen's empty state; `owner.onboarding@example.com` signs in normally. A parent with a linked child lands on `/parent` (SYS — the select-centre hub used to tell them they were not connected to a branch); `teacher.new@example.com` lands on the hub, whose "Find a branch to teach at" leads to the directory, and any `/teacher/*` URL sends them there directly. `npm run e2e` (SYS) signs in as these accounts and checks each row of this table.

## The world behind them

- **Organization "Center 60"** — two branches, **Downtown** (data-visibility window **30 days**) and **Nasr City** (**60 days**, a styled ID card). One org-level Owner; per branch a Manager, Receptionist and Accountant; six teachers each (Hesham Mansour teaches at both; Mahmoud Gaber also teaches at Al Nokhba); five rooms each with two joinable pairs; ~45 students and ~10 classes each. Downtown has a custom payment method ("Bank transfer").
- **Branch limits (F1)** — Center 60 may have **3** branches (it has two, so `owner.center60@…` can try **Settings → Branches → Add branch** once; a fourth is refused until the platform admin raises the limit at **Branches → Centers & branch limits**). Al Nokhba Academy and both test centres have a limit of **1** and are at it. Re-running the seed puts these limits back. Settings → Branches is in the Owner's settings sub-navigation only — a Manager never sees it.
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
