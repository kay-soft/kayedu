# CLAUDE.md — KayEdu

You are working on **KayEdu**, a multi-tenant ERP for Egyptian education centers, with connected teacher and student web portals. This file is your standing context.

## Before implementing anything
Read the relevant docs first — they are the source of truth, not your assumptions:
- `docs/00-master-product-spec.md` — scope, roles, business rules, **settled decisions (§5.1)**, **open decisions (§2.2)**, acceptance criteria
- `docs/01-data-model.md` — entities, financial ledger, tenant isolation, the data-visibility window
- `docs/02-architecture.md` — folder structure, auth, permissions, i18n, theming
- `docs/03-build-order.md` — milestones and their "Done when" gates
- `docs/04-design-system.md` — colors, typography, components, responsive + RTL rules
- `docs/05-phase-2-backlog.md` — everything deferred, with why and what it depends on

If the docs are silent on something that touches **money, permissions, or tenant isolation**, ask instead of assuming. If it *is* covered, check §5.1 (settled decisions) before treating it as a gap — several things that look like oversights are recorded choices with reasons.

---

## Working rules (how to operate in this repo)

**1. No browser testing unless the milestone prompt explicitly enables it; when enabled, use playwright-cli or @playwright/test, headless only.** Otherwise do NOT launch a browser, run headless browser automation, take screenshots, or curl pages in a loop to verify UI — it burns budget for little value. Verify with **static checks**: `npx tsc --noEmit`, `npx eslint .`, `npx prisma validate`, and unit tests. For anything visual or interactive, **write a short numbered list of what the user should check themselves** and stop. (The end-to-end smoke suite, `npm run e2e`, exists since SYS — run it only when a milestone prompt enables browser testing.)

**2. Always end with staged changes + a commit message.** After any code change: run `git add -A`, then print a suggested commit message (conventional-commit style, e.g. `feat(auth): add membership resolution and center selection`) in a copyable block. **Do not commit or push** — the user reviews and commits.

**3. Keep the docs in sync.** If you change behavior, schema, architecture, or design tokens, update the matching file in `docs/` in the same session. Docs drifting from code is a bug. Mention which docs you updated.

**4. Everything must be responsive.** Every UI must work on phone, tablet, and desktop — not just a laptop monitor. Follow `docs/04-design-system.md` §6: mobile-first, sidebar collapses to a drawer below `lg`, tables become stacked cards below `md` (never horizontal-scroll primary data), min 44×44px touch targets, modals become full-screen sheets on mobile, and 375px width is the floor. A screen that only looks right on desktop is not done.

**5. Stay in scope.** Implement the current milestone only. If a task drifts into Phase 2 territory or another milestone, stop and flag it. A deferral is written into `docs/05-phase-2-backlog.md` (what it is / why deferred / what it depends on), never just mentioned in a reply. An item must never appear in both the backlog and `03-build-order.md`.

**6. Deferrals and open questions get written down.** A "we'll decide later" goes into the **Open Decisions register** (`docs/00-master-product-spec.md` §2.2) with who decides and what it blocks. A "we'll build later" goes into the backlog. An unrecorded decision is the same failure mode as an undocumented shortcut.

**7. Never reset a database.** Never run `prisma migrate reset`, `prisma migrate diff` with a `--shadow-database-url`, `prisma db push --force-reset`, or any other command that can drop or reset a schema, against **any** URL taken from `.env` (that is the shared dev Supabase database — a shadow-DB diff against it wiped it once, in R4). Schema comparison uses a throwaway local shadow database, or none: a read-only `prisma migrate diff --from-url <.env URL> --to-schema-datamodel prisma/schema.prisma --script` is fine, and so is `prisma migrate deploy` (it only applies pending migrations). Anything destructive needs the user's explicit approval first. **Hand-written indexes Prisma cannot express** (since U2: the partial unique `Session_classGroupId_date_startTime_live_key … WHERE "rescheduledToId" IS NULL`) show up in every generated diff as a `DROP INDEX` — **delete that line from the generated migration** before keeping it (`docs/02-architecture.md` §11); `check:session-lifecycle` fails if the index is gone. Since W2 the same applies to `AssessmentOption_one_correct_per_question … WHERE "isCorrect"` (`check:assessments` fails if it is gone). Since W7a, also `TeacherAssistant_pair_live_key … WHERE "revokedAt" IS NULL` (`check:assistants` fails if it is gone). Since W8b, also `WorkspaceInvitation_one_pending_per_profile … WHERE "status" = 'PENDING'` (`check:workspaces` fails if it is gone).

**8. Run only the gates the change needs.** After a change, run the gates relevant to the touched area, plus `npx tsc --noEmit` and `npx eslint .`. Run the full `npm run check:all` and `npm run e2e` **only when the user asks, or before a deployment — and then only against a staging database**. Never run `e2e`, or any gate that writes data (most `check:*` gates create and clean up rows), against the shared dev project as routine verification. Since S1 this is enforced in code: a database-writing gate, `check:all`, `gates:users` and `e2e` refuse to run unless `KAYEDU_ENV=staging` or the database is on localhost, and refuse the dev project of `.env` (no override flag). Staging's runbook is `docs/staging.md`; `db:seed`, `db:wipe-dev` and `seed:verify` keep their own fences.

---

## Stack
- **Next.js (App Router) + TypeScript** — one language front to back
- **PostgreSQL via Supabase** (Auth + Storage + Postgres), **Prisma v6** ORM
- **Vercel** hosting, Frankfurt region
- **shadcn/ui + Tailwind** (base-nova style, `rtl: true`), **next-intl** for AR/EN + RTL

## Non-negotiable rules (violating these breaks the product)

1. **Tenant isolation.** Every tenant-scoped query MUST be filtered by `centerId` from the resolved session context. Never query a tenant table without a center scope. Use `getTenantContext()` and the scoped helpers in `lib/db/`. A missing `centerId` filter is a bug. **The organization/branch layer (M11) does not change this**: `Organization` is global, `Center` is still the tenant, `center_id` is still the *sole* isolation key, and a multi-branch view is a **union of per-branch scoped queries summed in memory** — never a `where` spanning centres in the database.

2. **Money is frozen and append-only.** When recording a `Payment`, compute and store `priceSnapshot`, `centerShareSnapshot`, `teacherShareSnapshot` at that instant. NEVER recompute historical money from current class config. Corrections VOID (with reason + `AuditLog`) and re-create — never UPDATE money fields in place. Money is **integer piastres (EGP × 100)**, never floats.

3. **Center cut logic** lives in exactly one place (`lib/money.ts`) — never inline it, and never on the client:
   ```
   centerShare = shareType === "FIXED"
     ? shareValue                                  // the piastres the CENTRE takes
     : Math.round(amount * shareValue / 100);
   teacherShare = amount - centerShare;
   ```
   `FIXED` is framed **centre-side**. A teacher-side "flat EGP per session regardless of headcount" is **not expressible in this model** and is not supported — see `docs/00-master-product-spec.md` §5.1 "Center cut". An education system's `defaultFixedCenterShare` (M13) is a **configuration-time default only**; it is never consulted at payment time.

4. **Identity vs membership.** A `User` is global (one per person) and holds only the auth credential (`authId`/`email`/`phone`) plus a platform-wide default name — it is the thing duplicate-matching keys on — its **global email** only (confirmed, under `REQUIRE_EMAIL_CONFIRMATION`); never a phone (no phone is verified — SEC-2a, D-02), never name. **Since W8b (D-W39, W-C6), a phone — `User.phone` of an account with a login, never `contactPhone` — may *address* a PERSONAL-workspace invitation the account holder must accept, but it never links and never matches a duplicate.** A sign-up never links itself to a person a centre created: that opens a claim staff approve in person (`lib/auth/identity-link.ts`). Their center relationship is a `Membership` (staff/teacher) or `StudentProfile`/`Enrollment` (student), and **that relationship owns its own local name and contact record** (`firstName`/`lastName`/`email`/`phone`/`altPhone`) — seeded from the `User` when the relationship is created, then editable at that center immediately and independently of any other center, with no lock of any kind. Attendance/payments/analytics attach to the scoped record, never the raw `User`. An existing person joining a new center = new membership, not a new user.

5. **i18n / RTL always.** No hardcoded UI strings — everything through `next-intl` (`messages/ar.json`, `messages/en.json`). Logical CSS properties only (`ps-`/`pe-`, `start`/`end`) — never `left`/`right`. Every screen works in both locales.
   - **UI vocabulary vs. DB vocabulary.** The UI says **"Branch"** where the DB says `Center`, and **"Center"** where the DB says `Organization`. That mapping lives **only** in the message files — never rename a model, column, variable or route to match it (`docs/02-architecture.md` §8; the full DB rename is backlog entry 18).
   - **Catalog entries are bilingual** (`nameAr` + `nameEn`). **Person names are not** — one name per relationship, never a locale variant.

6. **Roles.** Five `Membership` enum values — OWNER, MANAGER, RECEPTIONIST, **ACCOUNTANT** (M12), TEACHER — plus three resolved-only roles: Super Admin (`user.isPlatformAdmin`), Student (via `StudentProfile`), and **Parent** (via `FamilyLink` — a one-time code, never a phone; M16, F3). Eight resolved roles, five enum values; `docs/00-master-product-spec.md` §3 explains why both counts are correct. **From M12 permissions are a stored, configurable action-level matrix, not a hardcoded map** — deny-by-default, server-side authoritative, **OWNER-only granting**, and a hardcoded grantable ceiling a centre cannot configure around. Do not add a new hardcoded role check after M12. **The one recorded exception (W-batch, W7 — W-C3):** a ninth resolved role, **ASSISTANT** (via `TeacherAssistant`, not a `Membership`), whose rights are a **fixed catalogue the premium teacher toggles per assistant**. It is deny-by-default and server-side, it is checked *after* the teacher's own authority (never instead of it), it is never wider than the teacher, and it is never a centre-matrix cell. PERSONAL workspaces are authorised by owning the workspace (the U9 precedent) and add no matrix action. **Assessments (W2, D-W30/W-C10)** add exactly one: `assessment.manage.own`, TEACHER-only (in the baseline, Owner-switchable, a hard ceiling for every other staff role) — and owning the class, session or row is still required on top of it.

7. **Audit the sensitive stuff.** Financial changes (including **refunds** and **settlement transitions**), permission and role changes, branch grants, and attendance corrections write an `AuditLog` row.
   - **Void ≠ refund.** A void is "this should never have been recorded" (not counted). A refund is "the money went back, in cash" (subtracted from revenue and from both shares, original row preserved, **no balance ever created**). Different mechanisms; never collapse them into one flag.
   - **Settlements derive, never recompute.** A settlement total is the sum of frozen `teacherShareSnapshot` values — `DRAFT → APPROVED → PAID`, with **no partially-paid state**. A settlement **claims** each payment it counts, and a payment belongs to at most one live settlement (database-enforced, SEC-2b); a DRAFT may be CANCELLED, releasing its claims; a non-OWNER never approves or pays a settlement they created.
   - **Audit rows commit with the change and carry ids and amounts only** — written on the money transaction (`writeAuditLog(input, tx)`), never a person's name, contact or free text (the reason lives on the record; `lib/db/audit-row.ts` refuses it). The log is append-only (a trigger).

8. **Design system compliance.** Use the tokens in `docs/04-design-system.md`. Don't invent colors, radii, or spacing per screen. Semantic colors are fixed: present/paid = green, late/pending = amber, absent/void = red, upcoming = blue.

9. **The data-visibility window is a data-layer rule** (M19). Centre-side roles read nothing older than the centre's window (1 month default). Enforce it in the scoped helpers alongside `centerId`, **never in the UI** — a direct URL or API call must not bypass it. It is a **read restriction, never a deletion**. `Settlement` and `AuditLog` are carved out; platform admin bypasses.

10. **One normalizer per rule.** Phone numbers go through `lib/phone.ts` — used by validation, duplicate-matching **and** search alike. Money goes through `lib/money.ts`. Dates format through `lib/format.ts`. A second implementation of any of these is a second answer to the same question.

**W-batch rules** (decisions D-W01…D-W26 in `docs/00-master-product-spec.md` §5.1 "W-batch"; planned W1–W9):

11. **Correct answers never leave the server before reveal.** No page payload, prop, Server Action answer or select a student or parent can reach contains a correct option or per-answer correctness until the window or deadline has closed **and** `showCorrectAnswers` is on. Time comes from the attempt's `startedAt` on the server, grading is server-side, and the score is frozen at submit (D-W09).
12. **No cron for assessments or notifications.** A past-due attempt is finalised the next time it is read (D-W10). A notice is written by its event or computed on read (D-W12). Premium expiry is computed per request (D-W15). No scheduled job, timer route or polling — the R4 rule stands.
13. **PERSONAL centres are excluded from centre-only surfaces.** `Center.kind = PERSONAL` never appears on Explore, Discover, the teacher centre directory, the hub and the switcher, the admin centre and organization lists, the platform KPIs, the branch limit, the provisioning baseline or the seed-world checks — one filter, spread, never a per-screen condition (D-W20). **The filter is `BRANCH_ONLY` (`lib/db/center-kind.ts`, re-exported from `lib/db/platform.ts`; delivered W8a, D-W38)**, already inside `ACCESSIBLE_CENTER`, `COUNTED_BRANCHES`, Explore's `publicBranchWhere` and the console's `PLATFORM_CENTER` — **any new centre-wide surface must spread it** (or one of those). It is still a tenant: `center_id` isolation applies unchanged; a workspace is resolved only for its owner (`getWorkspaceContext`) and authorised only by `workspaceCan` + `assertWorkspaceWritable`, never the matrix.
14. **On-behalf actions audit both actor and teacher.** Every write an assistant makes records `actorUserId` = the assistant and `onBehalfOfUserId` = the teacher, on the change's own transaction, ids only (D-W18).
15. **Workspace payments never reach settlements.** A PERSONAL-workspace payment is recorded through the unchanged `recordPayment` with a forced 0 cut (PERCENTAGE 0 through `lib/money.ts`). No settlement writer, and no `SettlementClaim`, ever accepts it (D-W24).

## Architecture conventions
- Route groups by experience: `(center)`, `(teacher)`, `(student)`, `(parent)` (M16), `(admin)`, `(auth)` under `app/[locale]/`
- Server Components + Server Actions by default; client components only where interactivity demands
- Data access lives in `lib/db/` behind tenant-scoped functions — components never call Prisma directly
- `zod` validation on every Server Action input
- **A `"use server"` file exports only async functions (and types).** Next throws at runtime — dev and production — on any other export (a constant, an initial form state, a class), and the page that imports it shows "This screen didn't load". Keep initial states and shared values in a normal module (`lib/validation/*`, `action-state.ts`); `check:design` fails on a violation
- Every action: `getTenantContext()` → permission check → validate → scoped write → audit if sensitive → `revalidatePath`
- One product, configured. Never fork behavior per center — differences are settings + theming

## Out of scope (Phase 1 — do not build)
**The list is `docs/05-phase-2-backlog.md`**, and it is the only list. Every deferred item is there with what it is, why it was deferred, and what it depends on. Highlights: mobile apps · online teaching · materials, question banks, non-multiple-choice or image questions, gradebooks/progress · AI features · online payment gateways · student debt/balances · packages/subscriptions/discounts · SMS/WhatsApp notification *features* (the provider accounts are provisioned at M20; the features are not) · cross-centre teacher conflict detection · waitlists · academic terms · the full `Center`→`Branch` DB rename.

**Changed:** the **parent portal is no longer out of scope** — a PARENT role and a per-child mirror of the student portal are Phase 1 as of **M16**. **Changed (W-batch, planned):** multiple-choice **exams and homework**, an **in-app notification inbox** (email behind `EMAIL_ENABLED`, off), a **role switcher**, **premium teachers**, **assistants** and **PERSONAL workspaces** are in the build as W1–W9 (`docs/03-build-order.md`).
