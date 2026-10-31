# 07 — Security & Anti-Fraud Audit (SEC-1)

> **Status:** SEC-1 was report only. **SEC-2a** (identity & access, data exposure, platform) fixed **43** findings; **SEC-2b** (money integrity, concurrency, anti-fraud) fixed **19**; **SEC-2c** (validation, injection, availability, D-18 abuse limits) fixed **7** more — **69 FIXED, 3 OPEN, 3 DEFERRED**, each remaining one with its reason in §1.1. Each fixed finding is asserted by name (`SEC-NN`) in `npm run check:security`; the Data API posture by `npm run check:rls`.
> **Audited:** branch `dev` at `977f9cf` (2026-10-13), plus the live shared dev Supabase project. The database was only read, except for throwaway repro fixtures, which were created and deleted.
> **Method:** 13 parallel area audits, then a re-read by the lead of every Critical/High finding against the code. A finding only made this report once its `file:line` evidence was confirmed. Docs were treated as claims to check, not as facts. Where a doc turned out to be wrong, §9 lists it.
> **Severity scale:**
> - **Critical:** an unprivileged or remote actor can compromise accounts, cross tenants, or reach money.
> - **High:** privilege escalation, exposure of minors' PII, insider money fraud that goes undetected, or a role bypass.
> - **Medium:** abuse that needs an insider and leaves a trace; denial of service; missing defence-in-depth that has a plausible exploit.
> - **Low:** hardening.
> - **Info:** a note.

## Contents
1. [Summary](#1-summary)
2. [Attack-surface inventory](#2-attack-surface-inventory)
3. [Findings](#3-findings) — Critical · High · Medium · Low · Info
4. [Repro scripts](#4-repro-scripts)
5. [Prioritized fix plan](#5-prioritized-fix-plan)
6. [NEEDS-DECISION register](#6-needs-decision-register)
7. [Verified safe](#7-verified-safe)
8. [Live platform state observed](#8-live-platform-state-observed)
9. [Docs contradicted by this audit](#9-docs-contradicted-by-this-audit)

---

## 1. Summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 10 |
| Medium | 20 |
| Low | 32 |
| Info | 12 |
| **Total** | **75** |

**What holds.** Tenant isolation at the data layer is sound:
- every centre and teacher Server Action scopes nested ids by `centerId`;
- the `kayedu_center` cookie, including its "Whole Management" organisation value, is checked against the user's live relations on every request;
- OWNER-only ceilings hold even when an action is called directly;
- payment amounts are derived on the server and the money snapshots are frozen;
- all raw SQL is parameterised;
- the ID-card SVG is escaped;
- the PostgREST and Storage endpoints are closed to the anon and authenticated roles on the dev project.

**What breaks.** The serious problems sit in four places:
1. **Identity proofing.** An unconfirmed email or an unverified phone can attach a stranger to a child's record, a teacher membership or a parent link (SEC-01, SEC-02, SEC-03, SEC-04).
2. **Money invariants enforced only in app code**, under READ COMMITTED with no database backstop. A race doubles payments (SEC-05) and settlements (SEC-06). Cancelled sessions leave money editable forever (SEC-08).
3. **Owner visibility.** Voids and unpaid check-ins leave no trace that any centre screen shows (SEC-07).
4. **Environment drift.** The PostgREST lockdown exists only as hand-made state on the dev project (SEC-10).

### 1.1 Fix status after SEC-2c (updated at SYS)

**70 FIXED, 2 OPEN, 3 DEFERRED** (SEC-2a fixed 43, SEC-2b 19, SEC-2c 7, SYS 1 — SEC-62, on the user's decision for option (a)). "FIXED" means the change shipped and `npm run check:security` asserts it as `SEC-NN`. **OPEN** means a decision blocks it; **DEFERRED** means it is decided and scheduled — every one to **M20**, because it needs something only M20 brings (email delivery, Sentry, a person's dashboard action). The decisions SEC-2a, SEC-2b and SEC-2c used are in §6 (marked "decided"); none of the six remaining findings is a Critical or a High.

| ID | Status | What changed / why open |
|---|---|---|
| SEC-01 | FIXED | A sign-up never links to a staff-created person: a matching email opens a PENDING `AccountClaim` that staff approve in person on `/approvals`; the login has no app user meanwhile (`lib/auth/identity-link.ts`, `lib/db/account-claims.ts`). `REQUIRE_EMAIL_CONFIRMATION=true` adds a confirmed-email requirement to every email link; production refuses to start without it or while Supabase auto-confirms. Invitations link by token only (email-bound, single use, expiring, role from the row). Auth-confirm route and a "check your email" state added. Asserted with auto-confirm simulated ON. (D-01) |
| SEC-02 | FIXED | A phone is never an identity key: sign-up stores none and says no "phone in use"; staff link only through a person's global email (`isLinkableMatch`); a contact another person holds is never copied onto a new `User`. (D-02 (a)) |
| SEC-03 | FIXED (F3) | OD-6 decided: parent access needs a **one-time code** (from the student, or printed by the branch), never a phone. Sign-up originates nothing; a phone match writes nothing; codes are stored as sha256 only, single use (conditional accept), rate-limited 10/h per account and per IP; a student account can never accept one; the staff Verify stand-in is gone. Residual risk (a student handing a code to a non-student adult) recorded in 00 §5.1. *(SEC-2a: FIXED (stop-gap) — the Verify stand-in refused.)* |
| SEC-04 | FIXED (F3) | A link ends only by **explicit, audited revocation** — branch staff with a reason (`parent.link.manage`), the parent, or a platform admin; never the student. Reads stop on the next request (`activeChildLinks` reads ACTIVE only), and a deactivated profile or a suspended/archived centre still disappears (D-10). D-04 (a)'s automatic revocation on a parent-phone change is retired with the phone as key. *(SEC-2a: FIXED — automatic revocation.)* |
| SEC-05 | FIXED | Partial unique index `Payment_one_active_per_attendee` (`WHERE voided = false`; **since T5 `WHERE voided = false AND refunded = false`** — a refund frees the slot as a void does, swapped by creating the new index first, then dropping the old and renaming, so the guarantee never lapses; the invariant is unchanged in kind: at most one payment per attendee that is neither voided nor refunded); `lockAttendeeRow` takes the lock, then reads the payment fact in a fresh statement (same predicate); `recordPayment` inserts `ON CONFLICT … DO NOTHING` against the index, its `WHERE` matching the index predicate exactly (a mismatch makes Postgres reject the statement — asserted statically against the migration), so a lost race is `alreadyPaid`, never a second row. Asserted with two clients in parallel, and since T5 also after refund → re-check-in. |
| SEC-06 | FIXED | `SettlementClaim` (D-05 (c)): a settlement claims each payment it counts, in the same transaction; one live claim per payment is a partial unique index; creation is serialized per (centre, teacher) by an advisory lock; transitions are conditional on the status. Overlapping periods are allowed when they claim money no live settlement holds (OD-8 resolved). Asserted with parallel creates/approves/pays. |
| SEC-07 | FIXED | `/audit` (`audit.view`): voids, absent switches, refunds, settlement transitions, price/cut changes, and present-but-unpaid check-ins (D-06 (a)); the receipt counts and lists voids, refunds and unpaid attendees. Linked from Dashboard and Analytics, and since SEC-2c from the centre nav for whoever holds `audit.view` (OWNER/MANAGER by default; the `check:permissions` nav pin gained `"audit"`). |
| SEC-08 | FIXED | Cancel and reschedule are refused while the session holds an active payment (`hasPayments`); cancelled/rescheduled sessions close at the end of their day (status kept, no absences); void and refund refuse a terminal session (D-07 (c)). A refunded payment does not block (its money is back). |
| SEC-09 | FIXED | `roleForExperience` denies instead of falling back; a denied context grants nothing (`canInContext`/`ctxCan`); every `(center)` action reaches `ctxCan` (static sweep); the centre unblock refuses a CLASS-scope block. |
| SEC-10 | FIXED | Lockdown migration `20261017090100_sec2a_data_api_lockdown` (RLS on every public table, zero policies, no grants or default grants to anon/authenticated, private buckets); `npm run check:rls` in CI after `migrate deploy`. (D-19 (a)) |
| SEC-11 | FIXED | Postgres-backed limiter inside `resolveContact` covers all five disclosing paths (per staff member and per centre); a person known only outside the organisation is described without a name. (D-08 (b)) |
| SEC-12 | FIXED | Void and refund lock the payment row (`FOR UPDATE`, centre-scoped), re-read it and write conditionally; CHECK `Payment_not_voided_and_refunded`; a double refund is `alreadyRefunded`, never a thrown unique error. Asserted with parallel void ∥ refund. |
| SEC-13 | FIXED | `claimClassSeat` (lib/db/reservations.ts) is the one seat-taking function: it locks the class row and counts in a fresh statement; instant enrol, confirmation and the staff Enrol action all use it, and a profile is never made for a student who got no seat. Asserted with 6 parallel enrolments. |
| SEC-14 | FIXED | Reactivating a staff membership needs `membership.role.assign` (OWNER); managers may still deactivate; the UI hides reactivation from non-owners. (D-09 (a)) |
| SEC-15 | FIXED | Teacher block/unblock check `student.block`; the form is gated; teacher earnings (dashboard, session receipt) are gated on `analytics.own.view`. The broader "every permission has a call site" sweep is narrowed to the teacher portal: `center.branding.edit` and `platform.manage` still have none (`audit.view` got its page at SEC-2b and its nav entry at SEC-2c). |
| SEC-16 | FIXED | `reserveOrEnroll` refuses a suspended/archived centre and a deactivated profile; profile completion requires both; the parent read hides them. (D-10 (a)) |
| SEC-17 | FIXED | Profile completion is strictly one-time (`alreadyCompleted`); staff edits stay. (D-11 (a)) Since F3 the parent phone it writes is contact data only — it creates, matches and ends no family link, so the "feeding SEC-03" half of the finding no longer applies. |
| SEC-18 | FIXED | D-12: a non-OWNER cannot approve or pay a settlement they created (`ownSettlement`); an OWNER may, and the audit row says `selfApproved: true`. The seed now drafts as the manager and approves as the owner. |
| SEC-19 | FIXED | The receipt's "collected" and both shares are net of refunds, with "Refunded (n)" and a named refunds section, on screen, in print and for the teacher. |
| SEC-20 | FIXED | D-13: a status change that voids a payment needs a reason — zod, the Server Action and `changeAttendanceStatus` each refuse it without one (`reasonRequired`); a change that voids nothing keeps it optional. |
| SEC-21 | FIXED | D-14 (b): `Session.timezone` is the centre's timezone frozen at creation (a trigger fills it and keeps it); the write guard, Present/Late, the end-of-day close, "today" at reception and the teacher edit deadline read it. A centre timezone edit moves nothing already created. |
| SEC-22 | FIXED | D-15 (c): `centerCutError` (lib/money.ts, the one rule) refuses a FIXED cut above the price in every schema and in the data layer — class create and edit (so lowering a price below the cut is refused), one-time sessions and a session's override. The clamp stays as the backstop. |
| SEC-23 | FIXED | D-16 (c): a period is strict dates, `to` not in the future (`futureRange`), at most 366 days (`rangeTooLong`); a DRAFT can be cancelled, releasing its claims. |
| SEC-24 | FIXED | D-17 (b): every money aggregate is a raw `SUM(...)::bigint` (analytics, the receipt, the Sessions tile); a price is capped at 100,000 EGP (`MAX_PRICE_PIASTRES`, ~30× a realistic session price); a settlement total beyond `integer` is refused (`totalTooLarge`). |
| SEC-25 | FIXED | SEC-2c (D-18): `requestToTeachAction` refuses anyone who already teaches somewhere (`alreadyTeaching`), allows one PENDING request per (requester, centre) under a per-pair advisory lock (`alreadyRequested`), and is limited per account (10/day) and per IP (30/day); each Approvals queue loads one page of 50 (`APPROVALS_PAGE_SIZE`) and shows how many more wait. |
| SEC-26 | FIXED | SEC-2c (D-18): `reserveOrEnroll` holds an account to 30 PENDING reservations and 30 ACTIVE enrolments when instant-enrolling (`SELF_SERVICE_CAPS`; `reservationLimit`/`enrollmentLimit`), serialized per account so a race cannot pass the cap (asserted with two clients in parallel); the action is limited to 30/hour per account and 300/hour per IP. The lifecycle check was SEC-16. No verified-account requirement beyond production's email confirmation; CAPTCHA stays M20. |
| SEC-27 | FIXED | Sign-in, sign-up and confirmation resend are throttled per email and per client IP in the shared store, before Supabase is called. CAPTCHA and leaked-password protection are recorded for M20 (`00` §2.1-A). |
| SEC-28 | FIXED | Headers in `next.config.ts` on every route; CSP ships report-only — enforcing it is an M20 item (moved from backlog entry 22 at SEC-2c). |
| SEC-29 | OPEN (D-20 part fixed) | D-20: audit rows carry ids, amounts, counts, statuses and dates only (SEC-2b). **Retention and erasure stay OPEN on OD-2** — a legal decision (how long a deactivated minor's record is kept, how an erasure request is honoured while money/attendance history stays). The legal review is now an explicit M20 box (`00` §2.1-B); the anonymisation routine follows the rule, not before it. |
| SEC-30 | FIXED | `supabase/m10-rls-and-storage.sql` deleted; the lockdown migration covers every table; the grep gate is replaced by `check:rls`. |
| SEC-31 | FIXED | Deny-all, zero policies on `public` (D-19 (a)); `check:rls` fails on any policy. |
| SEC-32 | FIXED | SEC-2c: Discover loads at most 5 centres at a time (`mapWithConcurrency`, `lib/concurrency.ts`) instead of one `Promise.all` over every centre. A page-load rate limit and a cached centre list were not added: the bound already caps what one load holds, and the reservation it leads to is rate-limited (D-18). |
| SEC-33 | FIXED | Supabase auth cookies httpOnly, Secure in production, SameSite=Lax; `lib/supabase/client.ts` deleted. |
| SEC-34 | FIXED | next and eslint-config-next 16.3.8. |
| SEC-35 | FIXED | `shadcn` and `prisma` moved to devDependencies; `deepmerge-ts` pinned to 8.0.2 by an npm override (the advisory came in through `prisma`, a peer of `@prisma/client`); `npm audit --omit=dev` reports 0 and CI runs it at `--audit-level=high`. |
| SEC-36 | DEFERRED (M20) | Needs the 13 legacy auth users deleted on the shared dev project — destructive, so it is the person's action in the Supabase dashboard, not tooling's (`00` §2.1-A, M20). |
| SEC-37 | FIXED | A static import-closure gate (`check:security` SEC-37) proves no `"use client"` module reaches the service-role client, Prisma, the storage layer or the auth session. The `server-only` package was not installed (that install is the person's decision); the gate stands in for it. |
| SEC-38 | FIXED | `SEED_ADMIN_PASSWORD` (≥ 6, ≠ `SEED_PASSWORD`) for the platform admin; seed, preflight and `.env.example` updated. (D-21 (a)) |
| SEC-39 | FIXED | `npm run db:migrate` refuses and points at `prisma migrate deploy`; no script runs `migrate dev`/`reset`/`db push`. |
| SEC-40 | FIXED | No `phoneInUse`/`emailInUse`: a sign-up without a session always shows the same "check your email" state. (D-02) |
| SEC-41 | FIXED | Sign-up metadata is zod-parsed and capped; a metadata phone is ignored; `signUpAction` no longer overwrites the `User` row. |
| SEC-42 | FIXED | Acceptance claims the invitation conditionally inside its transaction; revoke is OWNER-only (D-22 (a)); an owner who stops being one has their pending invitations revoked, branch by branch. |
| SEC-43 | FIXED | `safeNextPath` refuses backslashes, control characters, over-long values and anything resolving to another origin. |
| SEC-44 | FIXED | Every `(teacher)` action resolves through `actionContext("teacher")` (an active TEACHER role at the active centre, else FORBIDDEN). |
| SEC-45 | FIXED | `can()` gives OWNER every non-platform action regardless of stored rows. |
| SEC-46 | FIXED | `createPeriodSettlementAction` refuses a teacher id that is not this centre's teacher before writing. |
| SEC-47 | FIXED | The student page counts relations at other branches of the same organisation only. (D-23 (a)) |
| SEC-48 | FIXED | The roll-up clamps each branch by its own visibility window and requires `analytics.center.view` at each branch; a branch without a range is never read unbounded. |
| SEC-49 | FIXED | SEC-2c: profile completion resolves the grade through the centre's own selection (`centerGradeById`), and the form offers only that centre's grades under its own names (`centerGrades`); an unselected grade is `notFound`. |
| SEC-50 | FIXED | Every typed date is the strict `dateOnlyField`/`dateKeyField` (reschedule, holiday, settlement period, expense, teacher session request); a stored request with an impossible date is refused on approval (`invalidDate`), never thrown. |
| SEC-51 | FIXED | Reschedule and NEW_SESSION approval refuse a past date (`pastDate`); D-24: an expense may be backdated within the visibility window only, never into the future; expenses are voided with a reason (who, when), never deleted; category changes are audited. |
| SEC-52 | FIXED | SEC-2c: all 12 raw-argument actions (type-aheads, phone lookups, reception session mode) parse a zod tuple first (`lib/validation/action-args.ts`, `parseActionArgs`): an object is refused, a search over 80 characters is refused (not truncated). The teacher type-aheads filter relationally (`taughtByTeacherWhere`) instead of loading the all-history roster per keystroke. |
| SEC-53 | FIXED | Logos are files in the private `logos` bucket (`Center.logoPath`), served by `/api/logos/[centerId]` as a signed URL; nothing fetches a remote URL any more. (D-25 (b)) **F5:** a guest (no sign-in) now gets a logo only for a branch on the public Explore pages — ACTIVE/GRACE with `publicListing` (`publicBranchLogo`); every other guest request is still a 404, and the bucket stays private. |
| SEC-54 | FIXED | Uploads are typed by magic bytes (PNG/JPEG/WebP; never SVG, never `File.type`). |
| SEC-55 | FIXED | Storage is private and service-role-only by design (no `storage.objects` policy); buckets and caps are in the migration; `check:rls` asserts it. |
| SEC-56 | FIXED | `docs/00` §2.1-B, `docs/01` §4, `docs/02` §5 and §10 rewritten to the real posture. |
| SEC-57 | FIXED | Docs corrected (the Prisma role is not a superuser but has BYPASSRLS); `check:rls` prints it; a non-bypass app role is backlog entry 23. |
| SEC-58 | FIXED | D-26 (b): a 0-priced one-time session needs an explicit "I understand this session is free" (`zeroPriceNeedsConfirmation`); the session header and its receipt are flagged; the `session.create` audit row says `zeroPrice`. |
| SEC-59 | FIXED | A rating needs a PRESENT/LATE attendance inside the 7-day window, by direct call; a skip for a session the student did not attend writes nothing. |
| SEC-60 | FIXED | A trigger makes `AuditLog` append-only (no UPDATE but the FKs' own SET NULL, no DELETE outside an opted-in maintenance transaction that only test cleanup uses); every money action writes its audit row on the money transaction, so an audit failure rolls the money back. |
| SEC-61 | FIXED | SEC-2c: Prisma's model queries cannot escape a LIKE pattern (a backslash escape matches through `$queryRaw` and nothing through a model query — probed), so search tokens drop `%`, `_` and `\` (`likeSearchToken`, `lib/like.ts`) and the payment-method, term, expense-category and room duplicate checks compare the branch's names in memory by the one name key (`nameClashes` → `catalogNameKey`: trimmed, spaces collapsed, lower-cased) instead of an insensitive `equals`. `%` finds nobody; `Cash_` can be created beside `Cash1`. |
| SEC-62 | FIXED (SYS, option (a)) | `scoped(ctx)` injects the window floor beside `centerId` into every session, attendee, attendance-change, payment and expense read, for the four centre-side roles (`centreReadFloor`, `lib/db/visibility.ts`); an out-of-window record by id is `null`, lists/counts/the absence streak stop at the floor. One named opt-out, `scopedIgnoringVisibilityWindow(ctx, "integrity" \| "settlement" \| "audit")` — delete blockers and the two carve-outs. The page-level reads that bypassed the helpers (session/payment reads in the session and conflict actions) moved onto them. Writes were already covered (SEC-08). `check:visibility` asserts it per role by direct call through the real helpers (`scopedWith`), plus two static sweeps. Visible effect listed in `00` §5.1 "Data visibility window". |
| SEC-63 | FIXED | `lockAttendeeRow` takes `centerId` and filters on it in SQL. |
| SEC-64 | FIXED | Photos capped at about 1 MB (under the Server Action body) and shrunk in the browser first. (D-27 (b)) |
| SEC-65 | FIXED | Photo upload and removal are audited (`student.photo.update`/`.remove`). No rate limit was added — D-28 asked for the audit. (D-28) |
| SEC-66 | DEFERRED (M20) | The auth-confirm route exists (`/[locale]/auth/confirm`); the password-reset flow needs real email delivery, which needs the domain (OD-1) — M20. |
| SEC-67 | FIXED | The in-process `Map` is replaced by the `RateLimitBucket` table, with pruning. |
| SEC-68 | FIXED | `poweredByHeader: false`. |
| SEC-69 | FIXED | `vercel.json` pins `fra1`. |
| SEC-70 | FIXED | Seed, wipe and preflight refuse the production deployment's environment and a committed `PRODUCTION_PROJECT_REFS` list — the production ref is added there at M20. |
| SEC-71 | FIXED | SEC-2c: `resolveCardLayout` normalises `background` like `accent` — the built-in surface or a hex colour, anything else falls back to the default. |
| SEC-72 | FIXED | The approval loaders select the requester's id and name only. |
| SEC-73 | OPEN | Page and action gates differ on `/settings/staff`, the block actions and the Add-teacher dialog. None is an escalation, but aligning them changes who may do what — permission semantics, which CLAUDE.md says to decide, not assume. Options: (a) `/settings/staff` asserts the union of its actions' permissions and each control hides itself; (b) split the page by permission; (c) document the difference as intended. The Add-teacher dialog giving an existing staff member a TEACHER role is part of the same question. |
| SEC-74 | FIXED | Auth half at SEC-2a; money half now: `parseEgpToPiastres` accepts plain decimal EGP only (no `1e3`, `0x10`, `0.001`), folds Arabic-Indic digits, and the client previews use it; the general-settings audit row includes `teacherEditDeadlineHours`. |
| SEC-75 | DEFERRED (M20; logging half fixed) | SEC-2c: Prisma uses `errorFormat: "minimal"` in production, so an error message no longer quotes the failed call's arguments (names, phones) into the server log. A root `global-error.tsx` is built with Sentry at M20: it renders outside next-intl's provider and Sentry's integration captures through it — building it twice gains nothing, and without it Next's own generic page leaks nothing. |

### 1.2 SEC-2c notes

**SEC-62 — decided (option (a)) and FIXED at SYS; the analysis below is kept as the record of the choice.** **What moving the window floor into the data layer would take.** Today the floor (`visibilityWindowFloor`) is applied per page: Sessions, Analytics, Expenses, session detail and its print clamp their own ranges; `refunds.list` is the one scoped helper that applies it; the student detail page (attendance history, absence streaks) and a few session-scoped loaders do not. The surface is about 24 `scoped(ctx).sessions/attendees/payments/expenses` call sites, 5 direct `prisma.session/payment/…` reads in 2 centre files, and the `lib/db` readers those pages call (receipt, analytics, student detail). Writes are already covered (every session older than its day is closed). Three ways to finish it:
- **(a) Floor in the scoped helpers** (★ the one CLAUDE.md rule 9 describes): `scoped(ctx).sessions|attendees|payments|expenses` add `date ≥ floor` (a payment and an attendee through their session's date) for centre-side roles, with a named `unbounded()` opt-out for the writers, closures and settlement, which must see everything; the 5 direct reads move behind the helpers; analytics keeps its range clamp. About a day of work plus a `check:visibility` extension. Visible effect: a student's older attendance and absence streaks disappear from the student page for non-admins, and a direct link to an old session shows "not found" — **that visible effect is the decision.**
- **(b) A per-request Prisma extension** that injects the floor into every read of those four models when the context is centre-side. It also catches direct `prisma.*` reads, but it is invisible at the call site, does not cover raw SQL, and has to be built per request.
- **(c) Keep per-page clamps** and add a static gate that every centre page or action reading those models clamps or is on an allowlist, closing the student detail page by hand. Cheapest; it leaves rule 9 as a convention rather than a data-layer guarantee.

**`check:people` now runs the real identity module, and one assertion fails.** Its own copy of the matching query (addition 1) was replaced by `resolveContact`/`describeMatch`/`seedLocalName`/`createPerson`, exactly as `createStudentAction` calls them. The assertion **"A contact that exists only on another center's local record still matches"** fails: the real module finds that person but returns them under `others` with kind `none`, because since SEC-2a (D-01/D-02) a person is only ever linked through their **global** email, never another centre's local record. The gate's copy still linked on it, so the assertion could not fail. Not edited, per instruction — **needs a decision:** either the assertion is re-stated to the SEC-2a rule ("found, never linkable"), or the rule changes. Every other `check:people` assertion passes against the real module.

**The 11-minute `check:one-off-sessions` hang (addition 4) — not reproduced.** Run alone it takes about 2 m 20 s and passes. What was established: the server's `statement_timeout` is 120 s for this role, so one stalled statement cannot wait 11 minutes — but a stall of that length fits the gate's main flow and then each statement of its cleanup each waiting ~2 minutes behind one lock held by an **idle-in-transaction** backend (the database has no `idle_in_transaction_session_timeout`). No app or `lib/db` transaction awaits anything but the database (a static scan of every `$transaction` callback), every interactive transaction has a Prisma timeout of 5–60 s, and a process killed mid-transaction has its transaction released by Supavisor (checked live). So the holder was most likely another process still alive at the time — a second gate run, the dev server, or a seed. Supavisor drops a connection-level `options=-c lock_timeout=…` (probed: the server still reported `0`), so the gates now set `lock_timeout` 15 s and `statement_timeout` 60 s **per transaction**, and a watchdog fails any query pending over 45 s with the blocker's pid, state, transaction age and last query (`scripts/lib/gate-db.ts`, verified with a deliberately held row lock: the in-transaction wait failed at 15 s, the out-of-transaction one at 48 s naming the idle-in-transaction holder). A role- or database-level `idle_in_transaction_session_timeout` on the dev project would remove the class of problem; that changes shared database settings, so it is the person's call.

**Test-user leak (addition 2).** 56 `User` rows with no email, phone, login or relation were on the dev database before SEC-2c — fixtures earlier gate runs created without a contact and never deleted. Every gate now cleans up the users it created (the gate client deletes, on disconnect, the rows created during its run — or through it by id — that have no login and no relation left), and the full run asserts the `User` count does not grow. That check earned its place on its first run: it caught `check:analytics`, whose student fixtures have no email and a **backdated** `createdAt`, so a time-window sweep alone missed them; the client now also remembers the ids it created. The 56 existing rows were left in place: deleting them is a destructive cleanup on the shared database, for the person to approve.

**Dependencies.** Patch/minor bumps applied, every gate green after them: `next` and `eslint-config-next` 16.3.8 → 16.4.1, `react`/`react-dom` 19.2.8 → 19.3.1, `@base-ui/react` 1.7 → 1.9, `@supabase/ssr` 0.12.5 → 0.12.7, `@supabase/supabase-js` 2.112 → 2.117, `lucide-react` 1.38 → 1.57, `next-intl` 4.14.1 → 4.14.9, `tailwind-merge` 3.6 → 3.7, `zod` 4.5 → 4.6, `@types/react(-dom)` 19.3, `shadcn` 4.21.5 (dev). `npm audit --omit=dev`: **0**. Full `npm audit`: 9 high, all dev-only through one advisory — `braces` ≤ 3.0.3 (GHSA-vfj7-8cjw-p6xm) via `shadcn` → `fast-glob` → `micromatch`; no patched `braces` exists and npm's "fix" is a downgrade of `shadcn`/`eslint-config-next` to old majors, so it is accepted as dev-only (the CLI globs only developer-supplied patterns). **Major bumps not taken — for a decision:** `prisma`/`@prisma/client` 6 → 7 (8 is in RC), `eslint` 9 → 10, `typescript` 5 → 7, `@types/node` 20 → 26.

### Top 10 (fix order, highest risk first)
| # | ID | Sev | One line |
|---|---|---|---|
| 1 | SEC-01 | Critical | Signing up with the email of a staff-created student or teacher takes over that record. Email confirmation is off, and `syncUserFromAuth` links by email without checking `email_confirmed_at`. |
| 2 | SEC-10 | High | No migration enables RLS or revokes grants. A fresh Supabase project (production, CI) would expose every table to the public anon key. |
| 3 | SEC-05 | High | Two concurrent payments for the same student both succeed (6/6 in the repro). The "row-locked" guard reads a stale snapshot, and no database index backs it. |
| 4 | SEC-06 | High | One teacher share can be claimed by two settlements: session plus period (OD-8), or two concurrent creates. Both can reach PAID. |
| 5 | SEC-02 | High | An unverified sign-up phone acts as an identity key. Staff "Use this person" then links a child's record or a teacher membership to a stranger. |
| 6 | SEC-03 | High | Parent links come from an unverified sign-up phone across every centre. The staff Verify screen can't tell an impostor from the real parent, and the real parent is then locked out of their own number. |
| 7 | SEC-07 | High | Voids and unpaid check-ins are invisible to the owner. No centre screen reads AuditLog or voided payments, and the receipt doesn't flag unpaid attendees. |
| 8 | SEC-08 | High | Cancelling or rescheduling a paid session leaves its payments voidable forever (the repro voided a March payment in October), and no settlement can ever include them. |
| 9 | SEC-09 | High | A TEACHER-only member can call centre actions gated on any permission TEACHER holds. Today that means full-roster search and other teachers' block lists. |
| 10 | SEC-04 | High | A VERIFIED parent link is never revoked, even after the parent phone changes or the student is deactivated, and no revoke action exists. |

SEC-11 (a cross-centre contact-to-name lookup whose rate limit can be bypassed) is the remaining High.

---
## 2. Attack-surface inventory

### 2.1 Server Actions (125 exports in 24 `"use server"` files)
Paths are relative to `app/[locale]/`. In the "lib/db calls" column, `scoped.<model>.<fn>` means `lib/db/scoped.ts`.

| # | File:line | Export | Context resolution | Permission checked | zod schema | lib/db calls |
|---|---|---|---|---|---|---|
| 1 | `(admin)/admin/catalog/actions.ts:59` | `createCatalogEntryAction` | requirePlatformAdmin() | NONE | catalogEntryCreateSchema | catalog-admin.createCatalogEntry |
| 2 | `(admin)/admin/catalog/actions.ts:76` | `updateCatalogEntryAction` | requirePlatformAdmin() | NONE | catalogEntryUpdateSchema | catalog-admin.updateCatalogEntry |
| 3 | `(admin)/admin/catalog/actions.ts:94` | `toggleCatalogEntryAction` | requirePlatformAdmin() | NONE | catalogEntryToggleSchema | catalog-admin.setCatalogEntryActive |
| 4 | `(admin)/admin/catalog/actions.ts:111` | `deleteCatalogEntryAction` | requirePlatformAdmin() | NONE | catalogEntryDeleteSchema | catalog-admin.deleteCatalogEntry |
| 5 | `(admin)/admin/centers/actions.ts:44` | `createCenterAction` (F1: two modes — new organization, or add to an existing one within its limit) | requirePlatformAdmin() | NONE | createCenterSchema | audit.writeAuditLog, platform.createCenterWithSettings, platform.addBranchToOrganization |
| 6 | `(admin)/admin/centers/actions.ts:88` | `transitionCenterLifecycleAction` | requirePlatformAdmin() | NONE | centerLifecycleTransitionSchema | audit.writeAuditLog, platform.transitionCenterLifecycle, prisma.center.findUnique |
| 7 | `(admin)/admin/centers/actions.ts:125` | `updateCenterVisibilityWindowAction` | requirePlatformAdmin() | NONE | centerVisibilityWindowSchema | audit.writeAuditLog, prisma.centerSettings.findUnique, prisma.centerSettings.update |
| 8 | `(auth)/actions.ts:65` | `signInAction` | NONE | NONE | signInSchema | - |
| 9 | `(auth)/actions.ts:92` | `signUpAction` | NONE | NONE | signUpSchema | parents.originateParentLinks, prisma.user.findUnique, prisma.user.update |
| 10 | `(auth)/actions.ts:161` | `signOutAction` | NONE | NONE | localeSchema | - |
| 11 | `(auth)/actions.ts:171` | `selectCenterAction` | getCurrentUser() + getUserCenterRelations()/getOwnerOrgGroups() (selection validated against own relations) | NONE | selectCenterSchema, localeSchema | - |
| 12 | `(auth)/actions.ts:219` | `acceptInvitationAction` | getCurrentUser() | NONE | acceptInvitationSchema | audit.writeAuditLog, platform.ACCESSIBLE_LIFECYCLE_STATES, prisma.invitation.findUnique, prisma.invitation.update, prisma.membership.findFirst, prisma.membership.update, prisma.membership.create |
| 13 | `(center)/approvals/actions.ts:43` | `approveChangeRequestAction` | getTenantContext("center") | approvals.manage | approvalIdSchema | approvals.resolveChangeRequest, audit.writeAuditLog |
| 14 | `(center)/approvals/actions.ts:71` | `declineChangeRequestAction` | getTenantContext("center") | approvals.manage | approvalIdSchema | approvals.resolveChangeRequest, audit.writeAuditLog |
| 15 | `(center)/approvals/actions.ts:99` | `approveReservationAction` | getTenantContext("center") | approvals.manage | approvalIdSchema | audit.writeAuditLog, reservations.confirmReservation |
| 16 | `(center)/approvals/actions.ts:129` | `declineReservationAction` | getTenantContext("center") | approvals.manage | approvalIdSchema | audit.writeAuditLog, reservations.rejectReservation |
| 17 | `(center)/approvals/actions.ts:163` | `approveSessionRequestAction` | getTenantContext("center") | approvals.manage | approveSessionRequestSchema | approvals.resolveSessionRequest, audit.writeAuditLog, slot-conflicts.describeConflicts |
| 18 | `(center)/approvals/actions.ts:212` | `declineSessionRequestAction` | getTenantContext("center") | approvals.manage | approvalIdSchema | approvals.resolveSessionRequest, audit.writeAuditLog |
| 19 | `(center)/classes/actions.ts:152` | `searchEnrollCandidatesAction` | getTenantContext("center") | class.manage | NONE (raw string args; trimmed/sliced only) | scoped.enrollments.listForClass, scoped.students.search |
| 20 | `(center)/classes/actions.ts:267` | `createClassAction` | getTenantContext("center") | class.manage | classGroupSchema, classSlotsSchema | class-sessions.createClassWithSessions, slot-conflicts.describeConflicts, scoped.teachers.findByUserId, scoped.subjects.findById, scoped.grades.findById, scoped.educationSystems.findById |
| 21 | `(center)/classes/actions.ts:350` | `createClassWithNewTeacherAction` | getTenantContext("center") | teacher.manage, class.manage | teacherCreateSchema, classGroupSchema, classSlotsSchema | class-sessions.createClassWithNewTeacher, slot-conflicts.describeConflicts, scoped.subjects.findById, scoped.grades.findById, scoped.educationSystems.findById |
| 22 | `(center)/classes/actions.ts:428` | `updateClassAction` | getTenantContext("center") | class.manage | classGroupUpdateSchema | class-sessions.updateClassWithSessions, slot-conflicts.describeConflicts, scoped.classGroups.findById, scoped.teachers.findByUserId, scoped.subjects.findById, scoped.grades.findById, scoped.educationSystems.findById |
| 23 | `(center)/classes/actions.ts:515` | `setClassActiveAction` | getTenantContext("center") | class.manage | classActiveSchema | class-sessions.deactivateClass, class-sessions.reactivateClass, slot-conflicts.describeConflicts, scoped.classGroups.findById |
| 24 | `(center)/classes/actions.ts:566` | `deleteClassAction` | getTenantContext("center") | class.manage | classRecordSchema | class-sessions.deleteClass |
| 25 | `(center)/classes/actions.ts:617` | `createScheduleAction` | getTenantContext("center") | class.manage | classScheduleSchema, slotConfirmationSchema | class-sessions.writeClassSlot, slot-conflicts.describeConflicts, scoped.classGroups.findById |
| 26 | `(center)/classes/actions.ts:642` | `updateScheduleAction` | getTenantContext("center") | class.manage | classScheduleUpdateSchema, slotConfirmationSchema | class-sessions.writeClassSlot, slot-conflicts.describeConflicts |
| 27 | `(center)/classes/actions.ts:665` | `removeScheduleAction` | getTenantContext("center") | class.manage | classScheduleDeleteSchema | class-sessions.writeClassSlot, slot-conflicts.describeConflicts, scoped.classSchedules.findById |
| 28 | `(center)/classes/actions.ts:690` | `enrollStudentAction` | getTenantContext("center") | class.manage | enrollmentCreateSchema | room-sets.loadClassRoomSet, scoped.classGroups.findById, scoped.students.findById, scoped.studentBlocks.isBlocked, scoped.enrollments.findExisting, scoped.enrollments.countActive, scoped.enrollments.findAny, scoped.enrollments.reactivate, scoped.enrollments.create |
| 29 | `(center)/classes/actions.ts:752` | `removeEnrollmentAction` | getTenantContext("center") | class.manage | enrollmentActionSchema | scoped.enrollments.findById, scoped.enrollments.setStatus |
| 30 | `(center)/classes/actions.ts:773` | `blockEnrollmentAction` | getTenantContext("center") | class.manage | classBlockCreateSchema | audit.writeAuditLog, scoped.classGroups.findById, scoped.students.findById, scoped.studentBlocks.isBlocked, scoped.studentBlocks.create, scoped.enrollments.findExisting, scoped.enrollments.setStatus |
| 31 | `(center)/classes/actions.ts:828` | `unblockEnrollmentAction` | getTenantContext("center") | class.manage | blockRemoveSchema | audit.writeAuditLog, scoped.studentBlocks.findById, scoped.studentBlocks.remove, scoped.students.findByUserId, scoped.enrollments.findExisting, scoped.enrollments.setStatus |
| 32 | `(center)/classes/actions.ts:871` | `createHolidayAction` | getTenantContext("center") | class.manage | holidaySchema | class-sessions.removeSessionsOnHoliday, prisma.holiday.create |
| 33 | `(center)/classes/actions.ts:910` | `removeHolidayAction` | getTenantContext("center") | class.manage | holidayDeleteSchema | scoped.holidays.findById, scoped.holidays.remove |
| 34 | `(center)/conflicts/actions.ts:121` | `checkSlotConflictsAction` | getTenantContext("center") | (dynamic: session.manage|class.manage) | inputSchema | class-sessions.previewClassSessions, class-sessions.previewManualSession, class-sessions.previewNewClassSessions, room-sets.resolveRoomSet, slot-conflicts.describeConflicts, slot-conflicts.loadSessionOccupancy, prisma.session.findFirst |
| 35 | `(center)/expenses/actions.ts:53` | `createExpenseCategoryAction` | getTenantContext("center") | expense.manage | expenseCategorySchema | scoped.expenseCategories.create, scoped.expenseCategories.count |
| 36 | `(center)/expenses/actions.ts:73` | `updateExpenseCategoryAction` | getTenantContext("center") | expense.manage | expenseCategoryUpdateSchema | scoped.expenseCategories.findById, scoped.expenseCategories.update, scoped.expenseCategories.count |
| 37 | `(center)/expenses/actions.ts:94` | `toggleExpenseCategoryAction` | getTenantContext("center") | expense.manage | expenseCategoryToggleSchema | scoped.expenseCategories.findById, scoped.expenseCategories.update |
| 38 | `(center)/expenses/actions.ts:112` | `deleteExpenseCategoryAction` | getTenantContext("center") | expense.manage | expenseCategoryDeleteSchema | scoped.expenseCategories.findById, scoped.expenses.count, scoped.expenseCategories.remove |
| 39 | `(center)/expenses/actions.ts:143` | `createExpenseAction` | getTenantContext("center") | expense.manage | expenseCreateSchema | audit.writeAuditLog, scoped.expenseCategories.findById, scoped.expenses.create |
| 40 | `(center)/expenses/actions.ts:182` | `deleteExpenseAction` | getTenantContext("center") | expense.manage | expenseDeleteSchema | audit.writeAuditLog, scoped.expenses.findById, scoped.expenses.remove |
| 41 | `(center)/reception/actions.ts:91` | `searchStudentsForReceptionAction` | getTenantContext("center") | reception.use | NONE (raw string args; trimmed/sliced only) | scoped.students.search |
| 42 | `(center)/reception/actions.ts:194` | `resolveReceptionInputAction` | getTenantContext("center") | reception.use, attendance.record | NONE (raw string args; trimmed/sliced only) | reception.resolveStudentInput, reception.studentSessionState, reception.validateReceptionSession, storage.signedUrlFor |
| 43 | `(center)/reception/actions.ts:224` | `resolveReceptionStudentAction` | getTenantContext("center") | reception.use, attendance.record | NONE (raw string args; trimmed/sliced only) | reception.studentSessionState, reception.validateReceptionSession, storage.signedUrlFor, prisma.studentProfile.findFirst |
| 44 | `(center)/reception/actions.ts:252` | `checkInAction` | getTenantContext("center") | reception.use, attendance.record, payment.record | receptionCheckInSchema | attendance.createAttendance, attendance.findAttendee, attendance.isStudentBlockedFromSession, audit.writeAuditLog, payments.recordPayment, reception.validateReceptionSession, scoped.students.findById, scoped.enrollments.findExisting |
| 45 | `(center)/sessions/actions.ts:108` | `searchAddAttendeeCandidatesAction` | getTenantContext("center") | attendance.record | NONE (raw string args; trimmed/sliced only) | scoped.sessions.findDetailById, scoped.enrollments.listForClass, scoped.students.search |
| 46 | `(center)/sessions/actions.ts:222` | `checkInRosterAction` | getTenantContext("center") | attendance.record | checkInRosterSchema | attendance.createAttendance, attendance.findAttendee, scoped.sessions.findById, scoped.students.findById, scoped.enrollments.findExisting |
| 47 | `(center)/sessions/actions.ts:277` | `setAttendanceAction` | getTenantContext("center") | attendance.correct, payment.void | setAttendanceSchema | attendance.changeAttendanceStatus, attendance.findAttendee, scoped.sessions.findById, prisma.payment.findFirst |
| 48 | `(center)/sessions/actions.ts:328` | `addExistingAttendeeAction` | getTenantContext("center") | attendance.record | addExistingAttendeeSchema | attendance.createAttendance, attendance.isStudentBlockedFromSession, scoped.sessions.findById, scoped.students.findById, scoped.attendees.findExisting, scoped.enrollments.findExisting |
| 49 | `(center)/sessions/actions.ts:382` | `addNewAttendeeAction` | getTenantContext("center") | attendance.record, student.manage | addNewAttendeeSchema | attendance.createAttendance, attendance.isStudentBlockedFromSession, audit.writeAuditLog, identity.createPerson, identity.describeMatch, identity.resolveContact, identity.seedLocalName, students.claimStudentCode, scoped.sessions.findById, scoped.attendees.findExisting, scoped.students.findById, prisma.studentProfile.findFirst, prisma.studentProfile.create |
| 50 | `(center)/sessions/actions.ts:501` | `recordPaymentAction` | getTenantContext("center") | payment.record | recordPaymentSchema | audit.writeAuditLog, payments.recordPayment |
| 51 | `(center)/sessions/actions.ts:541` | `voidPaymentAction` | getTenantContext("center") | payment.void | voidPaymentSchema | audit.writeAuditLog, payments.voidPayment |
| 52 | `(center)/sessions/actions.ts:586` | `refundPaymentAction` | getTenantContext("center") | payment.refund | refundPaymentSchema | audit.writeAuditLog, refunds.refundPayment |
| 53 | `(center)/sessions/actions.ts:632` | `cancelSessionAction` | getTenantContext("center") | session.cancel | cancelSessionSchema | audit.writeAuditLog, sessions.cancelSession |
| 54 | `(center)/sessions/actions.ts:670` | `endSessionAction` | getTenantContext("center") | session.close | endSessionSchema | audit.writeAuditLog, session-lifecycle.closeSession |
| 55 | `(center)/sessions/actions.ts:742` | `rescheduleSessionAction` | getTenantContext("center") | session.manage | rescheduleSessionSchema | audit.writeAuditLog, sessions.rescheduleSession, slot-conflicts.describeConflicts, prisma.session.findFirst |
| 56 | `(center)/sessions/actions.ts:816` | `updateSessionRoomsAction` | getTenantContext("center") | session.manage | sessionRoomsSchema | audit.writeAuditLog, sessions.updateSessionRooms, slot-conflicts.describeConflicts, prisma.session.findFirst |
| 57 | `(center)/sessions/actions.ts:886` | `updateSessionShareOverrideAction` | getTenantContext("center") | session.manage | sessionShareOverrideSchema | audit.writeAuditLog, sessions.updateSessionShareOverride, prisma.session.findFirst |
| 58 | `(center)/sessions/actions.ts:952` | `createSessionAction` | getTenantContext("center") | session.manage | newOneOffSessionSchema, newClassSessionSchema | class-sessions.createManualSession, class-sessions.createOneOffSession, slot-conflicts.describeConflicts |
| 59 | `(center)/sessions/actions.ts:1043` | `deleteSessionAction` | getTenantContext("center") | session.manage | deleteSessionSchema | class-sessions.deleteManualSession |
| 60 | `(center)/settings/actions.ts:182` | `selectCatalogEntryAction` | getTenantContext("center") | center.settings.edit | catalogSelectSchema | catalog.selectCatalogEntry |
| 61 | `(center)/settings/actions.ts:211` | `updateCatalogSelectionAction` | getTenantContext("center") | center.settings.edit | catalogSelectionUpdateSchema | audit.writeAuditLog, catalog.findSelectionById, catalog.updateCatalogSelection |
| 62 | `(center)/settings/actions.ts:259` | `toggleCatalogSelectionAction` | getTenantContext("center") | center.settings.edit | catalogSelectionToggleSchema | catalog.findSelectionById, catalog.setCatalogSelectionActive |
| 63 | `(center)/settings/actions.ts:278` | `deselectCatalogEntryAction` | getTenantContext("center") | center.settings.edit | catalogDeselectSchema | catalog.countCenterGradeSelectionsUnderSystem, catalog.countCenterSubjectSelectionsUnderGrade, catalog.findSelectionById, catalog.removeCatalogSelection, scoped.classGroups.count, scoped.students.count |
| 64 | `(center)/settings/actions.ts:320` | `createRoomAction` | getTenantContext("center") | center.settings.edit | roomSchema | scoped.rooms.list, audit.writeAuditLog, room-sets.saveRoomWithLinks (T3: room + links, one transaction) |
| 65 | `(center)/settings/actions.ts:341` | `updateRoomAction` | getTenantContext("center") | center.settings.edit | roomUpdateSchema | scoped.rooms.findById, scoped.rooms.list, audit.writeAuditLog, room-sets.saveRoomWithLinks (T3: room + links, one transaction) |
| 66 | `(center)/settings/actions.ts:365` | `toggleRoomAction` | getTenantContext("center") | center.settings.edit | recordToggleSchema | room-sets.roomCombinationUsage, scoped.rooms.findById, scoped.rooms.update |
| 67 | `(center)/settings/actions.ts:372` | `deleteRoomAction` | getTenantContext("center") | center.settings.edit | recordDeleteSchema | room-sets.roomCombinationUsage, scoped.rooms.findById, scoped.classGroups.count, scoped.sessions.count, scoped.rooms.remove, prisma.classGroupRoom.count, prisma.sessionRoom.count |
| 68 | `(center)/settings/actions.ts:386` | `setRoomLinksAction` (removed in T3 — folded into rows 64/65; the link set rides on the Add/Edit room save) | — | — | — | — |
| 69 | `(center)/settings/actions.ts:441` | `createPaymentMethodAction` | getTenantContext("center") | center.settings.edit | paymentMethodSchema | audit.writeAuditLog, payment-methods.createPaymentMethod |
| 70 | `(center)/settings/actions.ts:468` | `updatePaymentMethodAction` | getTenantContext("center") | center.settings.edit | paymentMethodUpdateSchema | audit.writeAuditLog, payment-methods.renamePaymentMethod |
| 71 | `(center)/settings/actions.ts:502` | `togglePaymentMethodAction` | getTenantContext("center") | center.settings.edit | recordToggleSchema | audit.writeAuditLog, payment-methods.setPaymentMethodActive |
| 72 | `(center)/settings/actions.ts:532` | `deletePaymentMethodAction` | getTenantContext("center") | center.settings.edit | recordDeleteSchema | audit.writeAuditLog, payment-methods.deletePaymentMethod |
| 73 | `(center)/settings/actions.ts:582` | `createTermAction` | getTenantContext("center") | center.settings.edit | termSchema | audit.writeAuditLog, terms.createTerm |
| 74 | `(center)/settings/actions.ts:611` | `updateTermAction` | getTenantContext("center") | center.settings.edit | termUpdateSchema | audit.writeAuditLog, terms.updateTerm |
| 75 | `(center)/settings/actions.ts:642` | `toggleTermAction` | getTenantContext("center") | center.settings.edit | recordToggleSchema | audit.writeAuditLog, terms.setTermActive |
| 76 | `(center)/settings/actions.ts:672` | `deleteTermAction` | getTenantContext("center") | center.settings.edit | recordDeleteSchema | audit.writeAuditLog, terms.deleteTerm |
| 77 | `(center)/settings/actions.ts:701` | `saveGeneralSettingsAction` | getTenantContext("center") | center.settings.edit | generalSettingsSchema | audit.writeAuditLog, scoped.settings.get, scoped.settings.save |
| 78 | `(center)/settings/actions.ts:772` | `saveCardLayoutAction` | getTenantContext("center") | center.settings.edit | cardLayoutSchema | scoped.settings.save |
| 79 | `(center)/settings/actions.ts:805` | `savePermissionMatrixAction` | getTenantContext("center") | permission.manage | permissionMatrixSchema | audit.writeAuditLog, permissions.listPermissionGrants, permissions.savePermissionGrants |
| 80 | `(center)/settings/staff/actions.ts:37` | `createInvitationAction` (F1: an optional `branchId` is re-resolved with `getTenantContextForBranch` and `membership.role.assign` checked there too; writes through `scoped(target)`) | getTenantContext("center") | membership.role.assign | createInvitationSchema | audit.writeAuditLog, scoped.memberships.list, scoped.invitations.updateMany, scoped.invitations.create |
| 81 | `(center)/settings/staff/actions.ts:92` | `revokeInvitationAction` | getTenantContext("center") | staff.invite | invitationIdSchema | audit.writeAuditLog, scoped.invitations.findById, scoped.invitations.update |
| 82 | `(center)/settings/staff/member-actions.ts:79` | `changeMemberRoleAction` | getTenantContext("center") | membership.role.assign, staff.manage, center.ownership.manage | memberRoleSchema | audit.writeAuditLog, scoped.memberships.findById, scoped.memberships.list, scoped.memberships.update, scoped.memberships.count |
| 83 | `(center)/settings/staff/member-actions.ts:138` | `setMemberActiveAction` | getTenantContext("center") | staff.manage, center.ownership.manage | memberActiveSchema | audit.writeAuditLog, scoped.memberships.findById, scoped.memberships.update, scoped.memberships.count |
| 84 | `(center)/settings/staff/member-actions.ts:185` | `grantMembershipBranchAction` | getTenantContext("center") | membership.branch.grant | membershipBranchGrantSchema | audit.writeAuditLog, organizations.organizationBranches, permissions.grantMembershipBranch, scoped.memberships.findById |
| 85 | `(center)/settings/staff/member-actions.ts:218` | `revokeMembershipBranchAction` | getTenantContext("center") | membership.branch.grant | membershipBranchGrantSchema | audit.writeAuditLog, permissions.revokeMembershipBranch, scoped.memberships.findById |
| 86 | `(center)/settlements/actions.ts:46` | `createSessionSettlementAction` | getTenantContext("center") | settlement.manage | createSessionSettlementSchema | audit.writeAuditLog, settlements.createSessionSettlement |
| 87 | `(center)/settlements/actions.ts:82` | `createPeriodSettlementAction` | getTenantContext("center") | settlement.manage | createPeriodSettlementSchema | audit.writeAuditLog, settlements.createPeriodSettlement |
| 88 | `(center)/settlements/actions.ts:120` | `approveSettlementAction` | getTenantContext("center") | settlement.manage | settlementIdSchema | audit.writeAuditLog, settlements.approveSettlement |
| 89 | `(center)/settlements/actions.ts:151` | `paySettlementAction` | getTenantContext("center") | settlement.manage | settlementIdSchema | audit.writeAuditLog, settlements.paySettlement |
| 90 | `(center)/students/actions.ts:129` | `searchStudentsTypeAheadAction` | getTenantContext("center") | student.manage | NONE (raw string args; trimmed/sliced only) | scoped.students.search |
| 91 | `(center)/students/actions.ts:157` | `lookupPersonByPhoneAction` | getTenantContext("center") | student.manage | NONE (raw string args; trimmed/sliced only) | identity.describeMatch, identity.resolveContact |
| 92 | `(center)/students/actions.ts:181` | `createStudentAction` | getTenantContext("center") | student.manage | studentCreateSchema | audit.writeAuditLog, identity.createPerson, identity.describeMatch, identity.resolveContact, identity.seedLocalName, students.claimStudentCode, scoped.grades.findById, prisma.studentProfile.create |
| 93 | `(center)/students/actions.ts:306` | `updateStudentAction` | getTenantContext("center") | student.manage | studentUpdateSchema | scoped.students.findDetailById, scoped.students.update, scoped.grades.findById |
| 94 | `(center)/students/actions.ts:359` | `setStudentActiveAction` | getTenantContext("center") | student.manage | studentActiveSchema | scoped.students.findById, scoped.students.update |
| 95 | `(center)/students/actions.ts:384` | `deleteStudentAction` | getTenantContext("center") | student.delete | studentActionSchema | audit.writeAuditLog, identity.deletePersonIfOrphaned, students.studentDeleteBlockers, storage.removeStoredObject, scoped.students.findDetailById, scoped.students.remove, scoped.studentBlocks.list, scoped.studentBlocks.remove |
| 96 | `(center)/students/actions.ts:455` | `promoteGradeAction` | getTenantContext("center") | student.promote | gradePromotionSchema | audit.writeAuditLog, scoped.grades.findById, scoped.students.promoteGrade |
| 97 | `(center)/students/actions.ts:496` | `setStudentGradeAction` | getTenantContext("center") | student.promote | studentGradeSchema | audit.writeAuditLog, scoped.students.findById, scoped.students.update, scoped.grades.findById |
| 98 | `(center)/students/actions.ts:534` | `uploadStudentPhotoAction` | getTenantContext("center") | student.manage | studentPhotoSchema | storage.removeStoredObject, storage.uploadStudentPhoto, scoped.students.findById, scoped.students.update |
| 99 | `(center)/students/actions.ts:572` | `removeStudentPhotoAction` | getTenantContext("center") | student.manage | studentActionSchema | storage.removeStoredObject, scoped.students.findById, scoped.students.update |
| 100 | `(center)/students/actions.ts:604` | `generateIdCardAction` | getTenantContext("center") | student.manage | studentActionSchema | id-cards.studentCardSvg, storage.signedUrlFor, storage.uploadIdCard, scoped.students.findDetailById |
| 101 | `(center)/students/actions.ts:651` | `verifyParentLinkAction` | getTenantContext("center") | parent.link.manage | verifyParentLinkSchema | audit.writeAuditLog, parents.verifyParentLinkPlaceholder |
| 102 | `(center)/teachers/actions.ts:74` | `searchTeachersTypeAheadAction` | getTenantContext("center") | teacher.manage | NONE (raw string args; trimmed/sliced only) | scoped.teachers.search |
| 103 | `(center)/teachers/actions.ts:104` | `searchBlockCandidatesAction` | getTenantContext("center") | student.block | NONE (raw string args; trimmed/sliced only) | scoped.teachers.findById, scoped.studentBlocks.list, scoped.students.search |
| 104 | `(center)/teachers/actions.ts:141` | `lookupPersonByPhoneAction` | getTenantContext("center") | teacher.manage | NONE (raw string args; trimmed/sliced only) | identity.describeMatch, identity.resolveContact |
| 105 | `(center)/teachers/actions.ts:165` | `createTeacherAction` (F1: an optional `branchId` is re-resolved with `getTenantContextForBranch` and `teacher.manage` checked there; the lookup `lookupPersonByPhoneAction` takes the same branch) | getTenantContext("center") | teacher.manage | teacherCreateSchema | teacher-membership.createTeacherMembership |
| 106 | `(center)/teachers/actions.ts:208` | `updateTeacherAction` | getTenantContext("center") | teacher.manage | teacherUpdateSchema | scoped.teachers.findById, scoped.teachers.update |
| 107 | `(center)/teachers/actions.ts:248` | `setTeacherActiveAction` | getTenantContext("center") | teacher.manage | membershipActiveSchema | audit.writeAuditLog, scoped.teachers.findById, scoped.teachers.update |
| 108 | `(center)/teachers/actions.ts:286` | `deleteTeacherAction` | getTenantContext("center") | teacher.delete | membershipActionSchema | audit.writeAuditLog, identity.deletePersonIfOrphaned, students.teacherDeleteBlockers, scoped.teachers.findById, scoped.teachers.remove, scoped.studentBlocks.list, scoped.studentBlocks.remove |
| 109 | `(center)/teachers/actions.ts:342` | `blockStudentAction` | getTenantContext("center") | student.block | blockCreateSchema | audit.writeAuditLog, scoped.teachers.findByUserId, scoped.students.findById, scoped.studentBlocks.isBlocked, scoped.studentBlocks.create |
| 110 | `(center)/teachers/actions.ts:394` | `unblockStudentAction` | getTenantContext("center") | student.block | blockRemoveSchema | audit.writeAuditLog, scoped.studentBlocks.findById, scoped.studentBlocks.remove, scoped.teachers.findByUserId |
| 111 | `(student)/actions.ts:23` | `submitSessionRatingAction` | getCurrentUser() | NONE | submitSessionRatingSchema | ratings.submitSessionRating |
| 112 | `(student)/actions.ts:51` | `skipSessionRatingAction` | getCurrentUser() | NONE | skipSessionRatingSchema | ratings.skipSessionRating |
| 113 | `(student)/student/discover/actions.ts:27` | `reserveClassAction` | getCurrentUser() | NONE | reserveClassSchema | reservations.reserveOrEnroll |
| 114 | `(student)/student/profile/actions.ts:27` | `completeStudentProfileAction` | getCurrentUser() | NONE | completeStudentProfileSchema | prisma.studentProfile.findFirst, prisma.catalogGrade.findUnique, prisma.studentProfile.update |
| 115 | `(student)/student/reservations/actions.ts:17` | `cancelReservationAction` | getCurrentUser() | NONE | cancelReservationSchema | reservations.cancelReservation |
| 116 | `(teacher)/teacher/approvals/actions.ts:39` | `approveOwnReservationAction` | getTenantContext("teacher") | reservation.manage.own | approvalIdSchema | reservations.confirmReservation, audit.writeAuditLog, prisma.reservation.findFirst |
| 117 | `(teacher)/teacher/approvals/actions.ts:71` | `declineOwnReservationAction` | getTenantContext("teacher") | reservation.manage.own | approvalIdSchema | reservations.rejectReservation, audit.writeAuditLog, prisma.reservation.findFirst |
| 118 | `(teacher)/teacher/centers/actions.ts:30` | `requestToTeachAction` | getCurrentUser() | NONE | teachAtCenterRequestSchema | platform.ACCESSIBLE_LIFECYCLE_STATES, prisma.center.findFirst, prisma.catalogSubject.findFirst, prisma.catalogGrade.findFirst, prisma.changeRequest.create |
| 119 | `(teacher)/teacher/classes/actions.ts:24` | `createClassRequestAction` | getTenantContext("teacher") | changeRequest.create | classRequestSchema | scoped.subjects.findById, scoped.grades.findById, scoped.changeRequests.create |
| 120 | `(teacher)/teacher/sessions/actions.ts:36` | `searchOwnSessionStudentsTypeAheadAction` | getTenantContext("teacher") | NONE | NONE (raw string args; trimmed/sliced only) | teacher-portal.teacherStudentProfileIds, scoped.students.search |
| 121 | `(teacher)/teacher/sessions/actions.ts:65` | `updateSessionDescriptionAction` | getTenantContext("teacher") | NONE | teacherSessionDescriptionSchema | scoped.sessions.findById, scoped.sessions.updateDescription |
| 122 | `(teacher)/teacher/sessions/actions.ts:111` | `createSessionRequestAction` | getTenantContext("teacher") | changeRequest.create | sessionRequestSchema | scoped.classGroups.findById, scoped.changeRequests.create |
| 123 | `(teacher)/teacher/students/actions.ts:36` | `searchTaughtStudentsTypeAheadAction` | getTenantContext("teacher") | NONE | NONE (raw string args; trimmed/sliced only) | teacher-portal.teacherStudentProfileIds, scoped.students.search |
| 124 | `(teacher)/teacher/students/actions.ts:59` | `teacherBlockStudentAction` | getTenantContext("teacher") | NONE | teacherBlockStudentSchema | audit.writeAuditLog, teacher-portal.teacherStudentProfileIds, scoped.students.findById, scoped.studentBlocks.isBlocked, scoped.studentBlocks.create |
| 125 | `(teacher)/teacher/students/actions.ts:102` | `teacherUnblockStudentAction` | getTenantContext("teacher") | NONE | teacherUnblockStudentSchema | audit.writeAuditLog, scoped.studentBlocks.findById, scoped.studentBlocks.remove, scoped.students.list |
| 126 | `(admin)/admin/organizations/actions.ts` | `updateOrganizationBranchLimitAction` (F1) | requirePlatformAdmin() | NONE | organizationBranchLimitSchema | platform.updateOrganizationBranchLimit (audits `platform.organization.limit.update` on its transaction) |
| 127 | `(center)/settings/branches/actions.ts` | `addBranchAction` (F1) | getTenantContext("center") | organization.branch.create (OWNER-only ceiling) | addBranchSchema | branches.addBranchAsOwner (re-resolves the actor; audits `organization.branch.create` on its transaction) |

**Facts that apply to the whole table:**
- 24 `"use server"` files, **125 exported Server Actions** (all under `app/`; none in `lib/` or `components/`).
- **No action calls `getTenantContext()` without an experience argument.** All 98 centre actions call `getTenantContext("center")`, all 10 tenant-context teacher actions call `getTenantContext("teacher")`. (The page-level `(print)/layout.tsx` and `analytics/page.tsx` call it bare; those are pages, not actions.)
- **No action calls `requireExperience()` or `hasExperience()`.** Only `(center)/layout.tsx` (`requireExperience("center")`) and `(print)/layout.tsx` (`hasExperience`) do, and layouts do not protect Server Actions.
- `roleForExperience(relation, exp)` (`lib/auth/relations.ts:197-210`): when the requested experience's role is missing it falls back to `staff ?? teacher ?? student`. So inside a centre action:
  - TEACHER + RECEPTIONIST at the same centre: the centre action acts as RECEPTIONIST, the teacher action as TEACHER. Correct.
  - **TEACHER only:** the centre action acts as **TEACHER** with the TEACHER grant row. Its only gate is `ctxCan`, so every centre action whose permission the centre grants TEACHER is open to the teacher (SEC-09).
  - STUDENT only at the active centre: the centre action acts as STUDENT and `can()` denies everything. Teacher actions with no permission check fall through to their userId-keyed ownership checks, which find nothing.
  - STUDENT at centre X, staff at centre Y: the role follows the `kayedu_center` cookie, so there is no cross-role mixing. Student-portal actions never use a tenant context; they key on the signed-in `User` only.
  - Parent with no centre relation: `getTenantContext` redirects. Parents have no Server Actions at all.
- Every centre/teacher tenant-context action goes through `resolveCenterRelations`, which checks `Membership.active`, `StudentProfile.active` and centre `lifecycleState IN ACCESSIBLE_LIFECYCLE_STATES` (`lib/auth/relations.ts:72-108`). `getTeacherContexts`/`getStudentContexts` (`lib/auth/tenant.ts:271-322`) reuse `getUserCenterRelations`, so they are lifecycle-safe. **Not covered:** the 6 `getCurrentUser()`-only actions (#111-#115, #118), `acceptInvitationAction` (does its own lifecycle check), and the parent portal's read path (`verifiedChildLinks`). See SEC-16.

### 2.2 Route handlers
**None.** There is no `route.ts` anywhere under `app/`. The middleware is `proxy.ts`, with matcher `/((?!api|_next|_vercel|.*\..*).*)`; it runs next-intl and a Supabase session refresh (`auth.getUser()`) and gates nothing. Auth is enforced in layouts, pages and actions.

### 2.3 Pages that read an id from params or searchParams
| File | Param | Validation |
|---|---|---|
| (center)/classes/[id]/page.tsx | id, q | `classGroups.findDetailById` (scoped) → notFound |
| (center)/sessions/[id]/page.tsx | id, q | `sessions.findDetailById` scoped + visibility window (page:86-92) |
| (center)/students/[id]/page.tsx | id | `students.findDetailById` scoped; shows cross-centre count (SEC-47) |
| (center)/teachers/[id]/page.tsx | id, q | `teachers.findById` scoped (role pinned) |
| (center)/classes/page.tsx | teacherId, subjectId, gradeId | only inside scoped `classGroups.search` where |
| (center)/sessions/page.tsx | teacherId, subjectId, classGroupId, dates | zod + scoped where; dates clamped to window |
| (center)/expenses/page.tsx | categoryId, dates | zod + scoped |
| (center)/analytics/page.tsx | teacherId, dates (+cookie org id) | aggregates always `{centerId}`; rollup branches from `getOwnerOrgGroups` (SEC-48) |
| (center)/reception/page.tsx | studentId, session, receipt, q | studentId scoped findDetailById; session via `validateReceptionSession` + today's card list; receipt must be a today card |
| (print)/sessions/[id]/print | id | scoped + session.view + visibility window |
| (print)/students/[id]/card, /paper | id | scoped findDetailById + student.manage |
| (print)/teacher/sessions/[id]/print | id | scoped + `teacherId === user.id` |
| (teacher)/teacher/sessions/[id] | id | scoped + `teacherId === user.id` (page:67-72) |
| (teacher)/teacher/students/[id] | id | scoped + must have sessions with this teacher (page:48-52) |
| (teacher)/teacher/sessions, students | page, q, gradeId | teacherId-pinned queries |
| (parent)/parent | child, date | child must be in `verifiedChildLinks` (else first child) |
| (student)/student/discover, schedule | subject, grade, day, date, page | filters only; per-centre scoped reads |
| (admin)/admin/centers/[id] | id | platform admin only |
| (auth)/invite/[token] | token | unguessable |
| (auth)/login, register | next, email | open-redirect is auth area (safeNextPath) |

### 2.4 Nested-id handling per Server Action file
| File | Id inputs | Validation |
|---|---|---|
| (center)/classes/actions.ts | classGroupId, id, teacherId(User), subjectId/gradeId/educationSystemId, roomId/extraRoomIds, scheduleId, enrollmentId, studentProfileId, blockId, holiday id; bound `classGroupId` in type-ahead | all scoped: `classGroups.findById`, `teachers.findByUserId`, `resolveRef`→catalog selection, `resolveRoomSet` (room-sets.ts:288 scopedWhere), `writeClassSlot` checks schedule∈centre AND ∈classGroupId (class-sessions.ts:1093-1100), enrollments/blocks scoped |
| (center)/sessions/actions.ts | sessionId, studentProfileId, sessionAttendeeId, paymentMethodId, paymentId, roomId(s), classGroupId, teacherId, subjectId/gradeId; bound sessionId | `sessions.findById`, `students.findById`, `loadGateSessionForAttendee` (a.centerId AND s.centerId, session-lifecycle.ts:218), `findActivePaymentMethod` (centerId+active), void/refund `findFirst {centerId,id}`, `checkManualSlot` teacher scoped+active (class-sessions.ts:1609) |
| (center)/reception/actions.ts | sessionId (bound), studentProfileId, paymentMethodId, raw scan | `validateReceptionSession` {id,centerId}; `studentProfile.findFirst {id,centerId}`; QR payload centre compared only (reception.ts:319) |
| (center)/students/actions.ts | studentProfileId, gradeId, from/toGradeId, parentLinkId, linkUserId | scoped findById/findDetailById; grades via selection; `verifyParentLinkPlaceholder` {id,centerId}; linkUserId must equal the server-resolved match |
| (center)/teachers/actions.ts | membershipId, teacherUserId, studentProfileId, blockId, bound teacherMembershipId, linkUserId | scoped (`teachers.findById/findByUserId`, role pinned) |
| (center)/settings/actions.ts | room id, roomId/linkedRoomIds, selectionId, catalogId, payment method id, term id | scoped finds then update by id (`findSelectionById {id,centerId}`, payment-methods.ts:133-201, terms.ts) |
| (center)/settings/staff/*.ts | membershipId, invitationId, centerId(target branch) | scoped; target ∈ own org |
| (center)/settlements/actions.ts | sessionId, settlement id, **teacherId** | session/settlement `{centerId,id}`; teacherId **not** checked (SEC-46) |
| (center)/expenses/actions.ts | categoryId, id | scoped |
| (center)/approvals/actions.ts | change request / reservation id | `scopedWhere(centerId,{id})` (approvals.ts:60,125; reservations.ts:242,305); payload classGroupId re-scoped (approvals.ts:140) |
| (center)/conflicts/actions.ts | classGroupId, scheduleId, sessionId, teacherId, roomIds | previews only read this centre's occupancy; `describeConflicts` scoped (slot-conflicts.ts:131,137) |
| (teacher)/teacher/*/actions.ts | sessionId, classGroupId, reservationId, studentProfileId, blockId, centerId (centers) | pinned to `teacherId = ctx.user.id` (scoped.ts:855, classes `teacherId !==` check, `ownReservation`, `teacherStudentProfileIds`); requestToTeach: centre must be accessible |
| (student)/… | centerId+classGroupId (reserve), centerId+reservationId (cancel), centerId+studentProfileId+gradeId (profile), sessionId (rating) | reserve: class scoped+active; cancel pinned to studentId; profile pinned to userId; rating requires an attendee row of that user |
| (auth)/actions.ts | selectionId (cookie), invite token | see above; token is 32 random bytes |
| (admin)/… | center id, catalog ids | `requirePlatformAdmin()` first in every action |

### 2.5 Raw SQL sites
*(Refreshed at SYS against the current code; the SEC-1 list it replaces had drifted — line numbers move, so sites are named by function.)* Every site is a Prisma **tagged template** (`$queryRaw\`…\`` / `$executeRaw\`…\``) or a `Prisma.sql` fragment: every value is a bound parameter, and the only interpolated SQL text is a **static** fragment defined in the same file (never built from input). No `$queryRawUnsafe`/`$executeRawUnsafe` exists in `app/` or `lib/`.

| Site | Kind | Interpolations | User-influenced? |
|---|---|---|---|
| `lib/db/analytics.ts` — `revenueTotals`, `refundTotals`, `revenueByTeacher`, `expenseTotals` (`dayRangeSql`) | `$queryRaw` + `Prisma.sql`/`Prisma.join` | centerId, teacherId, date keys (bound); the column fragments `SESSION_DATE` / `e."date"` are constants | bound — safe |
| `lib/db/attendance.ts` — `createAttendance` | `$queryRaw` INSERT … SELECT … FOR SHARE | ids, status, flags (bound); `openOnly` static | bound — safe |
| `lib/db/class-sessions.ts` — `repriceClassSessions` (SYS), `deleteClass`, `deleteManualSession` | `$queryRaw` … FOR UPDATE | centerId, classGroupId/sessionId, today, price (bound) | bound — safe |
| `lib/db/payment-methods.ts` — the last-active lock | `$queryRaw` FOR UPDATE | centerId | bound — safe |
| `lib/db/platform.ts` — `lockOrganizationBranches`, `updateOrganizationBranchLimit` (F1) | `$queryRaw` FOR UPDATE on `Organization` | organizationId (bound) | bound — safe |
| `lib/db/payments.ts` — `recordPayment` (INSERT … ON CONFLICT), `lockPaymentRow`, `sessionReceiptTotals` | `$queryRaw` | ids, amounts (bound) | bound — safe |
| `lib/db/reservations.ts` — `lockClassRow`; the per-account advisory lock | `$queryRaw` / `$executeRaw` | ids; the lock key string (bound) | bound — safe |
| `lib/db/session-lifecycle.ts` — `loadGateSession*`, the session lock, `lockAttendeeRow` | `$queryRaw` + static `GATE_COLUMNS`/`GATE_FROM` | ids, centerId (bound) | bound — safe |
| `lib/db/settlements.ts` — the per-(centre, teacher) advisory lock | `$executeRaw` | the key string (bound) | bound — safe |
| `lib/db/students.ts` — `claimStudentCode` | `$queryRaw` INSERT … ON CONFLICT | centerId, constant | bound — safe |
| `lib/db/terms.ts` — the centre lock | `$queryRaw` FOR UPDATE | centerId | bound — safe |
| `lib/rate-limit.ts` — `checkRateLimit` | `$queryRaw` upsert | key, window start (bound) | bound — safe |
| `app/[locale]/(teacher)/teacher/centers/actions.ts` — `requestToTeachAction` | `$executeRaw` advisory lock | the key string (bound) | bound — safe |
| scripts (gates, seed, wipe) | as in the SEC-1 list | constants, script-created ids; the wipe's TRUNCATE uses `pg_class` names regex-checked `^[A-Za-z0-9_]+$` | no |

**LIKE/ILIKE sites fed by user input:**

| Site | Shape | Input |
|---|---|---|
| `lib/db/students.ts:116` (`studentSearchWhere`) | `contains` insensitive → `ILIKE '%'‖$1‖'%'` | reception / students / classes / sessions search (`q`, server-action `query`) |
| `lib/db/students.ts:148` (`teacherSearchWhere`) | same | teacher search |
| `lib/db/teacher-portal.ts:152` | same | teacher portal `studentQuery` |
| `lib/db/payment-methods.ts:106`, `lib/db/terms.ts:56`, `app/[locale]/(center)/expenses/actions.ts:45`, `app/[locale]/(center)/settings/actions.ts:332,355` | `equals` + `mode:"insensitive"` → **`ILIKE $1`** | duplicate-name checks (payment method, term, expense category, room) |

No dynamic `orderBy`/field names from input anywhere: the only variable `orderBy` is `lib/db/scoped.ts:87` (`args?.orderBy`, typed, callers pass literals); no page reads a `sort`/`order` search param (searchParams used: `q, page, next, email, studentId, session, receipt, notice, switch, teacherId, subjectId, gradeId`).

### 2.6 Cookie and header reads/writes
| Location | Op | Cookie / header | Purpose / attributes |
|---|---|---|---|
| `lib/auth/active-center.ts:26` | read | `kayedu_center` | `getActiveCenterId()` returns the raw value (a Center id or an Organization id). Interpreted and checked against relations in `lib/auth/tenant.ts:216`. Also read directly by `app/[locale]/page.tsx:28` and `app/[locale]/(auth)/select-center/page.tsx:38` |
| `lib/auth/active-center.ts:32-39` | write | `kayedu_center` | httpOnly, sameSite=lax, secure only in prod, path=/, 30 days. Not signed, so it is untrusted input that the server re-validates on every request. Called from `app/[locale]/(auth)/actions.ts:54,196,210,312` |
| `lib/auth/active-center.ts:43` | delete | `kayedu_center` | sign-out, `(auth)/actions.ts:166` |
| `lib/supabase/server.ts:14-24` | read+write | `sb-<ref>-auth-token(.N)` | Supabase session client for RSC and actions. Writes are swallowed in RSC. Uses the @supabase/ssr default options, which are **httpOnly:false**, lax, 400-day maxAge (`node_modules/@supabase/ssr/dist/main/utils/constants.js`) |
| `lib/supabase/proxy.ts:20-25` | read (request.cookies) + write (response.cookies) | `sb-*` auth cookies | Token refresh in `proxy.ts` on every page request. Same default options as above |
| `proxy.ts:13` (next-intl middleware) | read/write | `NEXT_LOCALE`, `accept-language` | locale negotiation |
| `app/[locale]/(admin\|center\|parent\|student\|teacher)/layout.tsx` (lines 21, 36, 29, 107, 35) | read | `kayedu_sidebar_collapsed` | UI only |
| `components/shell/app-shell.tsx:266` | write (document.cookie) | `kayedu_sidebar_collapsed` | UI only. No Secure/SameSite set, and none is needed |
| `lib/db/storage.ts:113` | read (fetch response header) | `content-type` | server-side fetch of `center.logoUrl` for the ID card (`lib/db/id-cards.ts:39`) |
| — | — | `headers()` | **never used anywhere** in app/lib. Nothing keys on IP, and no Origin checks beyond Next's built-in Server Action origin check (`serverActions.allowedOrigins` unset) |

### 2.7 Supabase client creation
| Client | File | Key | Where it runs | Used by |
|---|---|---|---|---|
| `createSupabaseAdminClient()` (cached singleton) | `lib/supabase/admin.ts:17-32` | **service role** (`SUPABASE_SERVICE_ROLE_KEY`, not `NEXT_PUBLIC_`) | server | only `lib/db/storage.ts` (all Storage I/O) |
| `createSupabaseServerClient()` | `lib/supabase/server.ts:12-16` | anon + request cookies | server | `lib/auth/session.ts:11`, `app/[locale]/(auth)/actions.ts:75,114,164` (auth only, no storage) |
| `createServerClient` (proxy) | `lib/supabase/proxy.ts:18` | anon | middleware (`proxy.ts`) | session refresh |
| `createSupabaseBrowserClient()` | `lib/supabase/client.ts:5-7` | anon | browser | **no importers** (dead code; no client-side Storage access) |
| seed `createClient` | `prisma/seed-data/auth.ts:71` | service role | CLI seed only | auth user provisioning |

`lib/supabase/admin.ts` and `lib/db/storage.ts` do not `import "server-only"` (only `lib/ui/sidebar-cookie.ts` does). No key leak results today because the key is not `NEXT_PUBLIC_*`, and no client component imports either module.

### 2.8 File uploads and storage operations (all in `lib/db/storage.ts`, using the service role)
| Operation | Caller (Server Action / page) | Permission | Bucket | Path builder |
|---|---|---|---|---|
| `uploadStudentPhoto` (`:28-55`) | `uploadStudentPhotoAction` `app/[locale]/(center)/students/actions.ts:534-569` | `student.manage` (`studentScope`, `:79-83`) | `avatars` | `studentPhotoPath(ctx.center.id, student.id, ext, Date.now().toString(36))` |
| `uploadIdCard` (`:57-73`) | `generateIdCardAction` `students/actions.ts:606-636` | `student.manage` | `id-cards` | `studentIdCardPath(ctx.center.id, student.id)` |
| `signedUrlFor` (`:75-86`, TTL 600 s) | student detail page `students/[id]/page.tsx:153-155`; reception page `reception/page.tsx:204-223`; reception action `reception/actions.ts:161-163`; `generateIdCardAction` `:627` | page/`reception.use`+`attendance.record`/`student.manage` | `avatars`, `id-cards` | path from DB, `assertPathInCenter` first |
| `objectAsDataUri` (`:93-105`) | `studentCardSvg` `lib/db/id-cards.ts:41-44` | caller's | `avatars` | path from DB, `assertPathInCenter` first |
| `remoteImageAsDataUri` (`:108-121`) | `studentCardSvg` `lib/db/id-cards.ts:38-40` | — | n/a — **server-side `fetch(ctx.center.logoUrl)`** | arbitrary URL |
| `removeStoredObject` (`:123-131`) | delete student `:408-418`, photo replace `:560-566`, photo remove `:586-591` | `student.delete` / `student.manage` | `avatars`, `id-cards` | `assertPathInCenter` first |
| `idCardGeneratedAt` (`:134-146`) | `students/[id]/page.tsx:77` | page | `id-cards` | `list(centerId, {search: "<profileId>.svg"})` |

The only `<input type="file">` in the app: `app/[locale]/(center)/students/[id]/photo-form.tsx:61-62` (`accept="image/png,image/jpeg,image/webp"`). No code writes to `logos` or `session-uploads`. `Center.logoUrl` is a raw URL string set only by platform admin at centre creation (`app/[locale]/(admin)/admin/centers/actions.ts:44-50` → `lib/validation/admin.ts:53` `optionalText(500)` → `lib/db/platform.ts:161`); `StudentProfile.photoUrl` stores a storage **path** (not a URL), and is written only by the upload/remove actions (not part of `studentFields`, `lib/validation/people.ts:129-140`).

### 2.9 `dangerouslySetInnerHTML` and string-built HTML/SVG
| Site | What flows in |
|---|---|
| `components/center/id-card-preview.tsx:21` | `studentCardSvg()` output (`lib/db/id-cards.ts:26-61` → `renderIdCardSvg`) — used by `students/[id]/page.tsx:336`, `(print)/students/[id]/card/page.tsx:50`, `(print)/students/[id]/paper/page.tsx:155` |
| `app/[locale]/(center)/settings/card/card-form.tsx:383` | `renderIdCardSvg` with editor state (centre name prop, i18n sample strings, layout from server `resolveCardLayout`) |

### String-built HTML/SVG
- `lib/id-card.ts:445-644` `renderIdCardSvg` — the only string-built markup. Output goes to (a) inline HTML via the two `dangerouslySetInnerHTML` above, (b) Supabase Storage `id-cards/{centerId}/{id}.svg` as `image/svg+xml` (`lib/db/storage.ts:57-71`), downloaded via a signed URL `<a href>` (`students/[id]/id-card-panel.tsx:73`).
- `lib/qr.ts` produces only a path `d` string from the QR matrix (no text).
- No other HTML strings: no `innerHTML`, `srcDoc`, `document.write`, `eval`, `new Function`, `<script>` (the four `<style>` tags in print pages are static `@page` rules). Emails are sent by Supabase Auth templates, not built in-app.

**Inputs into the ID card, and who controls them:**

| Input | Controller | Sink handling |
|---|---|---|
| `Center.name` | platform admin (create) | `escapeXml` in `text()` (`id-card.ts:425`) and initial tile (`:516`) |
| `Center.themeColor` (brand) | platform admin; zod `^#[0-9a-fA-F]{6}$` (`lib/validation/admin.ts:32-35`) | re-checked `^#[0-9a-fA-F]{3,8}$` (`id-card.ts:448`) |
| `Center.logoUrl` | platform admin; free text ≤500 (`lib/validation/admin.ts:53`) | server-fetched → `data:` URI (`lib/db/storage.ts:109-121`), `escapeXml` into `<image href>` (`id-card.ts:501`); `<img src>` in `components/shared/brand-avatar.tsx:35` |
| `CenterSettings.cardLayout` (branch text, colours, family, align, numbers) | centre staff with card-settings permission; strict zod document (`lib/validation/settings.ts:331-381`, ≤20 000 chars) | `resolveCardLayout` keeps only finite numbers (`id-card.ts:80-82`), `normalizeHex` colours (`card-layout.ts:173-181`), allow-listed `align`/`family`, text trimmed ≤`CARD_BRANCH_TEXT_MAX`; renderer `paint()` re-normalizes every colour (`id-card.ts:430-432`) |
| Student local name (`firstName`/`lastName`) | centre staff (and user default name) | `escapeXml` (`id-card.ts:558,568,639`) |
| Grade label | catalog / centre override | `escapeXml` |
| Student photo | centre staff upload; MIME allow-list png/jpeg/webp (`lib/storage-paths.ts:85-93`, `lib/db/storage.ts:35-36`) | `data:` URI escaped into `<image href>` (`id-card.ts:547`) |
| `labels.code` | i18n | `escapeXml` |

### 2.10 Rate limiting
| Call site | Key | Limit / window | Keyed by |
|---|---|---|---|
| `app/[locale]/(center)/students/actions.ts:166` `lookupPersonByPhoneAction` | `people.phoneLookup:${ctx.user.id}` | 20 / 60 s | user id (shared across centres and across the student and teacher screens) |
| `app/[locale]/(center)/teachers/actions.ts:150` `lookupPersonByPhoneAction` | same key | 20 / 60 s | user id |

`lib/rate-limit.ts` is a module-level `Map<string, number[]>`: in-process, per instance, reset on every cold start. The app never reads `headers()` or `x-forwarded-for` anywhere (grep), so it cannot key anything by IP today.

Sensitive endpoints with no app-level limit:

| Endpoint | Auth needed | What it costs or leaks |
|---|---|---|
| `(auth)/actions.ts:65` `signInAction` | none | password guessing. Relies only on Supabase Auth limits, see SEC-27 |
| `(auth)/actions.ts:93` `signUpAction` | none | creates accounts. Also a `phoneInUse` oracle (SEC-40). Note that the anon key lets anyone call Supabase `auth.signUp` directly, which skips this action |
| `(auth)/actions.ts:224` `acceptInvitationAction` | logged in | token is `randomBytes(32)` and bound to an email, so brute force is not feasible (safe) |
| `students/actions.ts:182` `createStudentAction` (`matchFound` branch) | `student.manage` | the same phone/email to name disclosure as the rate-limited lookup (SEC-11) |
| `sessions/actions.ts:383` `addNewAttendeeAction` (`matchFound`) | `attendance.record` + `student.manage` | same (SEC-11) |
| `teachers/actions.ts` `createTeacherAction` and class "new teacher" → `lib/db/teacher-membership.ts:89` `addTeacherMembership` | `teacher.manage` | same (SEC-11) |
| `student/discover/actions.ts:27` `reserveClassAction` | any logged-in user | creates a reservation or an enrollment plus a StudentProfile in any centre (SEC-26) |
| `teacher/centers/actions.ts:29` `requestToTeachAction` | any logged-in user | unlimited ChangeRequest rows in any centre (SEC-25) |
| Type-ahead searches (`searchStudentsTypeAheadAction`, `searchStudentsForReceptionAction`, `searchEnrollCandidatesAction`, `searchAddAttendeeCandidatesAction`, `searchTeachersTypeAheadAction`, `searchBlockCandidatesAction`, teacher `searchOwnSessionStudentsTypeAheadAction`, `searchTaughtStudentsTypeAheadAction`) | centre or teacher ctx | scoped to the tenant, minimum 2 characters, `take: 8`. Query string not validated with zod and has no length cap (SEC-52) |
| Discover page `student/discover/page.tsx` | any logged-in user | 2 queries per centre per page load (SEC-32) |
| Parent-link origination (`originateParentLinks`, only from `signUpAction`) | none (at signup) | PENDING links on every student whose parent phone matches an *unverified* signup phone. Volume is bounded by one phone per account. Identity and verification belong to another area |

---

## 3. Findings

Each finding carries the same fields:
- **Severity**, with a one-line reason.
- **Area**.
- **Evidence**, as `file:line`.
- **Exploit**: who does it, how, and what they gain.
- **Fix**: the proposed change.
- **Behaviour change?** If the fix changes product behaviour, the finding is marked **NEEDS-DECISION** and lists the options; §6 collects all of them.
- **Gate**: the assertion that proves the fix.
- **Repro**: the script under `scripts/security-repro/`, where one exists. §4 has the last output of each.

Line numbers refer to `977f9cf`.

### 3.1 Critical

#### SEC-01 — Signing up with a staff-created person's email takes over their record
- **Status (SEC-2a): FIXED.** A sign-up never links to a staff-created person: a matching email opens a PENDING `AccountClaim` that staff approve in person on `/approvals`; the login has no app user meanwhile (`lib/auth/identity-link.ts`, `lib/db/account-claims.ts`). `REQUIRE_EMAIL_CONFIRMATION=true` adds a confirmed-email requirement to every email link; production refuses to start without it or while Supabase auto-confirms. Invitations link by token only (email-bound, single use, expiring, role from the row). Auth-confirm route and a "check your email" state added. Asserted with auto-confirm simulated ON. (D-01)
- **Severity:** Critical. An unauthenticated outsider takes over a minor's record, or a teacher's membership, at every centre that person belongs to. It works against the live dev configuration today.
- **Area:** AuthN / identity linking.
- **Evidence:**
  - `lib/auth/session.ts:51-62`: an unlinked `User` (`authId = null`) is linked to whichever auth identity presents the same email. `prisma.user.findUnique({ where: { email } })` is followed by `update({ data: { authId: authUser.id } })`. `authUser.email_confirmed_at` is never checked.
  - `lib/db/identity.ts:216-230` (`createPerson`): every student a receptionist creates (`(center)/students/actions.ts:247`, `(center)/sessions/actions.ts:424`), and every teacher a centre creates (`lib/db/teacher-membership.ts:109`), becomes a `User` with the typed email and `authId = null`. The dev DB holds 109 such rows, 107 of them with a `StudentProfile`.
  - `app/[locale]/(auth)/actions.ts:115-141`: `signUp` returns a session immediately when confirmation is off, and `syncUserFromAuth` then runs. It also runs on every `getCurrentUser()` (`lib/auth/session.ts:81-85`), so signing up directly at GoTrue with the public anon key works too.
  - Live GoTrue settings: `mailer_autoconfirm=true`, `disable_signup=false`.
  - Aggravation: `(auth)/actions.ts:142-145` then overwrites the victim `User`'s global name and phone with the attacker's values. `lib/auth/session.ts:45-47` also syncs `User.email` to any later auth-email change without checking confirmation.
- **Exploit:** an outsider knows a student's email (a classmate, the child's social media, or a parent's email typed as the child's). They register with it and any password. They land in the student portal holding that person's profiles at every centre: schedule (where and when a minor will be), attendance, payments, ID-card QR, grade and parent contact. They can also reserve and cancel classes. The same works for a centre-created teacher, giving rosters of minors and earnings. The real person is then locked out: their own sign-up returns `emailInUse`.
- **Fix:**
  1. Turn on *Confirm email* in Supabase (§2.1-A).
  2. **And** in code, refuse the email link at `session.ts:51`, and the email-change sync at `:45`, unless `email_confirmed_at` is set. Treat an unconfirmed auth user as having no app `User` yet.
  3. Add an auth-confirm route (`verifyOtp`/`exchangeCodeForSession`) so confirmation links land somewhere (SEC-66).
  4. Stop overwriting a linked row's global fields in `signUpAction` (SEC-41).
- **Behaviour change?** **NEEDS-DECISION (D-01).** Even with confirmation on, whoever controls the email a receptionist typed (often a parent's address, or a typo) inherits the child's identity.
  - (a) Auto-link only confirmed emails. This is the minimum.
  - (b) Auto-link only rows created by an invitation. Receptionist-created student and teacher rows need a centre-issued claim code or staff approval.
  - (c) Never auto-link. A self-registered account is always a new `User`, and merging is the audited admin action `docs/02` §3 already describes.
- **Gate:**
  - `syncUserFromAuth` given an auth user with `email_confirmed_at = null` and the email of an unlinked staff-created `User` leaves that row's `authId` null.
  - The production GoTrue settings report `mailer_autoconfirm=false`.
- **Repro:** `SEC-01.ts`. It imports the real `createPerson`, replicates `syncUserFromAuth` lines 40-62 query for query (the module imports `react`/`@/`), and reads the live GoTrue settings.

### 3.2 High

#### SEC-02 — An unverified phone acts as an identity key, so staff link a child or teacher record to a stranger
- **Status (SEC-2a): FIXED.** A phone is never an identity key: sign-up stores none and says no "phone in use"; staff link only through a person's global email (`isLinkableMatch`); a contact another person holds is never copied onto a new `User`. (D-02 (a))
- **Severity:** High. A child's record or a TEACHER membership is exposed to an outsider. Spec §5 requires matching "keyed on verified phone/email", but no phone in the system is ever verified.
- **Area:** Identity / duplicate matching (cross-tenant).
- **Evidence:**
  - `app/[locale]/(auth)/actions.ts:107-112,142`: sign-up only refuses a phone that another `User` already holds, then writes the typed phone to `User.phone`. There is no OTP. Direct GoTrue sign-up also works: `lib/auth/session.ts:65-70` copies raw `user_metadata.phone`.
  - `app/[locale]/(student)/student/profile/actions.ts:68-83`: a student can also set their own centre-local phone and email freely (see SEC-17).
  - `lib/db/identity.ts:60-76` (`findPeopleByContact`) matches the global `User.phone`/`email` **and** every centre's `StudentProfile`/`Membership` phone and email, with no verification flag. `resolveContact` (`:170`) returns `matched`.
  - `lib/db/identity.ts:188-198` (`seedLocalName`) seeds the new centre record with the matched name, which the attacker chose.
  - `(center)/students/actions.ts:217-229` and `lib/db/teacher-membership.ts:97-125`: one "link" submit attaches the new `StudentProfile` or TEACHER `Membership` to the attacker's `User`. The match panel (`identity.ts:125-153`) gives staff no hint that the matched account registered itself and never verified its phone.
  - Side effect: the real owner can no longer register their own phone (`phoneInUse`, `(auth)/actions.ts:109`).
- **Exploit:** an outsider (an estranged parent, a classmate, or worse) knows a child's or teacher's mobile number and name. They register with that phone and name. When any centre later adds the real person, staff see "this person already exists: <name>, matched on phone" and click link. The attacker then reads that centre's schedule, attendance, payments and ID card for the child in the student portal, or holds a TEACHER membership.
- **Fix:**
  - Don't write a self-typed phone to `User.phone` until it is verified, and don't copy `user_metadata.phone` in `syncUserFromAuth`.
  - Add `User.phoneVerifiedAt`/`emailVerifiedAt`; `findPeopleByContact` ignores unverified global contacts.
  - Show local-record matches as "possible match, not linkable", or require a second factor before linking.
  - Until then, the panel says "self-registered, phone not verified".
- **Behaviour change?** **NEEDS-DECISION (D-02).**
  - (a) Phone stops being a match key for self-registered accounts until OTP exists (Twilio is already the configured `sms_provider`; OTP is backlog entry 12).
  - (b) Keep matching, but require staff to verify with the person present, plus a UI warning.
  - (c) Accept the risk and record it in §5.1.
- **Gate:** a `User` created through the sign-up path with phone P (unverified) is not returned by `resolveContact({ phone: P })`, or is returned flagged unverified, and `linkUserId` to it is refused without the extra check.
- **Repro:**
  - `SEC-02.ts`: the student path, using the real `resolveContact` and `seedLocalName`.
  - `SEC-02-teacher.ts`: the teacher path, using the real `addTeacherMembership`. A new centre's TEACHER membership ends up on the attacker's login.

#### SEC-03 — Parent links come from an unverified sign-up phone, and "Verify" can't tell impostor from parent
- **Status (F3): FIXED.** OD-6 decided — parent access needs a one-time code, never a phone; see the §1.1 row and `00-master-product-spec.md` §5.1 "Parent role & portal". *(SEC-2a status, kept for the record: FIXED (stop-gap). `verifyParentLinkPlaceholder` refuses and its button is disabled (D-03 (d)); the real parent is no longer locked out of their number (no phone is stored at sign-up). Origination still writes inert PENDING rows. The real mechanism stays OD-6.)*
- **Severity:** High. A minor's schedule (location and time), attendance and payments go to a stranger after one staff click on evidence the stranger controls. OD-6 records that the mechanism is open; this finding shows why the shipped stand-in is unsafe.
- **Area:** Parent origination / privacy of minors.
- **Evidence:**
  - `app/[locale]/(auth)/actions.ts:153`: `originateParentLinks` runs with the registrant's typed, unverified phone.
  - `lib/db/parents.ts:87-102`: creates PENDING links for **every** `StudentProfile` platform-wide whose `parentPhone`/`parentAltPhone` matches.
  - `app/[locale]/(center)/students/[id]/page.tsx:372-393`: staff see the self-chosen account name, `matchedPhone` (by construction always equal to the phone on file) and a Verify button.
  - `lib/db/parents.ts:159-174`: `verifyParentLinkPlaceholder` flips the link to VERIFIED unconditionally.
  - `parents.ts:121-130` (`verifiedChildLinks`) feeds the parent portal (`lib/auth/tenant.ts:406-437`).
  - Once the impostor holds `User.phone`, the real parent's sign-up fails with `phoneInUse` (`(auth)/actions.ts:107-111`).
  - PENDING links reveal nothing, and a parent cannot verify their own link (both verified).
- **Exploit:** a parent's mobile number circulates in a class WhatsApp group. A stranger registers as "<parent name>" with it and calls the centre: "I registered, please approve me." Staff see a name and phone that match the record and click Verify. The stranger now sees the child's class times and rooms. PENDING links are also waiting at every other centre the child attends, and the real parent can't register with their own number.
- **Fix:** don't originate from an unverified phone. Alternatively, make the stand-in require proof the parent holds, for example a one-time code the centre hands the parent in person, which needs no SMS. Label the staff card "phone NOT verified". Keep the sign-up phone separate until it is verified, so an unverified claim can't block the real owner.
- **Behaviour change?** **NEEDS-DECISION (D-03, = OD-6, blocked on OD-2).**
  - (a) A centre-issued claim code.
  - (b) An OTP to the parent phone.
  - (c) Keep staff approval, but require the parent in person plus a visible "unverified" warning.
  - (d) Disable origination until OD-6 is decided.
- **Gate:** a `User` created by sign-up with phone P and no OTP or code reaches zero VERIFIED links through any single staff action that doesn't also consume a secret the parent holds. A second sign-up with the same unverified phone is not refused with `phoneInUse`.
- **Repro:**
  - `SEC-03.ts`: the real `originateParentLinks`, `verifyParentLinkPlaceholder` and `verifiedChildLinks`.
  - `SEC-03-squat.ts`: cross-centre fan-out, and the real parent locked out.

#### SEC-04 — A VERIFIED parent link is never revoked
- **Status (F3): FIXED.** Only explicit, audited revocation ends a link (branch with a reason, parent, platform admin — never the student); see the §1.1 row. *(SEC-2a status, kept for the record: FIXED. `verifiedChildLinks` re-checks active profile, centre lifecycle and the matched phone on every read; a parent-phone change revokes stale links (`REVOKED`, audited `parentLink.revoke`). No manual "remove link" button — D-04 (a) chose automatic revocation.)*
- **Severity:** High. An adult the centre has removed from the record (after a custody change, a corrected number or a reassigned SIM) keeps seeing a minor's upcoming locations and attendance.
- **Area:** Privacy of minors / parent portal.
- **Evidence:**
  - `lib/db/parents.ts:121-130` (`verifiedChildLinks`) filters `where: { parentUserId, status: VERIFIED }` only. It never re-checks `matchedPhone` against the current parent phones, `studentProfile.active`, or the centre's lifecycle.
  - `prisma/schema.prisma:133-136`: `ParentLinkStatus` is `PENDING | VERIFIED`, with no REVOKED state.
  - No ParentLink revoke, update or delete path exists. The only `parentLink.update` is the verify stand-in (`parents.ts:169`).
  - `(center)/students/actions.ts:339-350` (`updateStudentAction`) rewrites `parentPhone` without touching links, and writes no audit row.
- **Exploit:** a mother is verified as the parent. After a custody ruling, the centre replaces the parent phone and deactivates the child. She (or whoever now holds her old SIM) keeps seeing every upcoming class time and room. Staff have no button to stop it.
- **Fix:**
  - In `verifiedChildLinks`, require `studentProfile.active`, an accessible centre lifecycle, and `matchedPhone ∈ {parentPhone, parentAltPhone}`.
  - When a parent phone changes, auto-revoke links that no longer match, with an AuditLog row.
  - Add an audited staff "remove link" action under `parent.link.manage`.
- **Behaviour change?** **NEEDS-DECISION (D-04).**
  - (a) Auto-revoke on phone change (recommended).
  - (b) Flag the link for staff review instead.
  - (c) Decide whether a deactivated student hides the parent portal entirely or only the future schedule.

  This ties to OD-2 and OD-6.
- **Gate:** after `parentPhone` changes away from `matchedPhone`, or after `active=false`, `verifiedChildLinks` returns 0 rows and an AuditLog `parentLink.revoke` row exists.
- **Repro:** `SEC-04.ts`.

#### SEC-05 — Two concurrent payments for the same student both succeed
- **Status (SEC-2b): FIXED.** Partial unique index `Payment_one_active_per_attendee` (`WHERE voided = false`); `lockAttendeeRow` takes the lock, then reads the payment fact in a fresh statement; `recordPayment` inserts `ON CONFLICT … DO NOTHING` against the index, so a lost race is `alreadyPaid`, never a second row. Asserted with two clients in parallel.
- **Severity:** High. Revenue and the teacher share get double-counted in normal use (two desks, a double tap, a retried submit), and an insider can trigger it deliberately. The docs claim this race is closed.
- **Area:** Concurrency / money integrity.
- **Evidence:**
  - `lib/db/session-lifecycle.ts:285-298`: `lockAttendeeRow` runs `SELECT … EXISTS (SELECT 1 FROM "Payment" … voided = false) … FOR UPDATE OF a`. Under READ COMMITTED, the statement's snapshot is taken **before** it blocks on the lock. The first transaction only INSERTs a Payment and never updates the attendee row, so no EvalPlanQual re-read happens. The waiter's EXISTS therefore reports the state from before the commit.
  - `lib/db/payments.ts:126-131` trusts that flag. `payments.ts:76-80` states this is the only enforcement ("deliberately not database-unique").
  - `prisma/migrations/20260901210619_m5_payment_history_and_void_fields/migration.sql:2` drops `Payment_sessionAttendeeId_key`. No partial unique index replaces it.
  - No money path sets `isolationLevel`, and the live `default_transaction_isolation` is `read committed`.
  - `docs/03-build-order.md:186` says R2 closed the "second active payment" race (see §9).
- **Exploit:**
  - Two receptionists scan the same card. Both get `ok`, so the receipt, analytics and the teacher's settlement all count the fee twice.
  - A dishonest receptionist records a duplicate "payment" that was never collected, either to inflate a colluding teacher's payout or to void it later. Afterwards it looks like an ordinary race.
- **Fix:**
  1. Add a raw-SQL migration: `CREATE UNIQUE INDEX "Payment_one_active_per_attendee" ON "Payment"("sessionAttendeeId") WHERE "voided" = false;` and map P2002 to `alreadyPaid`.
  2. Compute `hasActivePayment` in a separate statement after the lock is taken.
  3. Correct `docs/03` R2.
- **Behaviour change?** No. A refunded payment stays `voided=false`, so it still blocks a re-payment, exactly as today.
- **Gate:** N rounds of two concurrent `$transaction(recordPayment)` calls on separate PrismaClients for the same attendee produce exactly one `ok` and one `alreadyPaid`, and at most 1 non-voided payment per attendee.
- **Repro:** `SEC-05.ts` imports the real `recordPayment`; 6/6 attendees got doubled. `SEC-05-mechanism.ts` shows the lock waits but the same-statement EXISTS is stale, while a fresh statement after the lock sees the payment.

#### SEC-06 — One teacher share can be claimed by two settlements, and both can be paid
- **Status (SEC-2b): FIXED.** `SettlementClaim` (D-05 (c)): a settlement claims each payment it counts, in the same transaction; one live claim per payment is a partial unique index; creation is serialized per (centre, teacher) by an advisory lock; transitions are conditional on the status. Overlapping periods are allowed when they claim money no live settlement holds (OD-8 resolved). Asserted with parallel creates/approves/pays.
- **Severity:** High. A teacher gets paid twice for the same payments. There is no race needed in one variant (session plus period), it's trivially racy in the others, and both settlements look legitimate through to PAID, which is irreversible.
- **Area:** Settlements / concurrency.
- **Evidence:**
  - `lib/db/settlements.ts:153`: a session settlement checks only `findFirst({ where: { centerId, sessionId } })`.
  - `lib/db/settlements.ts:190-198`: the period overlap check only matches other **period** rows (`periodFrom: { not: null, lte: to }, periodTo: { not: null, gte: from }`).
  - `sumTeacherShare` (`:105-116,214-216`) never excludes a session already covered by a session settlement. This cross-shape gap is already recorded as **OD-8**.
  - Both creates are a plain `findFirst` followed by `create` under READ COMMITTED. For an already-closed session the gate takes only `FOR SHARE` (`session-lifecycle.ts:340-352`), so two creators never serialize.
  - `approveSettlement`/`paySettlement` (`settlements.ts:256-292`) read the status, then run `update where {id}` with no status predicate, so a double call writes two audit rows.
  - `scripts/settlements-check.ts:418,441-447` only tests duplicates of the same shape.
- **Exploit:**
  - A MANAGER pays a teacher in cash from the session page's "settle" button, then creates the monthly period settlement, which includes that session again. They approve and pay it; this works in either order.
  - An accountant double-clicks "Create settlement", producing two DRAFTs that each carry the full share.
  - A period of 2000–2099 sweeps all history into one payout. Because settlements can't be deleted, it also blocks every future period for that teacher (SEC-23).
- **Fix:**
  1. Serialize settlement creation per (centre, teacher) with `pg_advisory_xact_lock(hashtext(centerId||teacherId))` or a row lock, then run the checks as fresh statements.
  2. Add DB backstops: a partial unique index on `Settlement(sessionId) WHERE sessionId IS NOT NULL`, plus a `btree_gist` exclusion constraint on (`centerId`, `teacherId`, `tsrange(periodFrom, periodTo)`).
  3. Make transitions conditional: `updateMany({ where: { id, centerId, status: 'DRAFT' } })` and check `count === 1`.
  4. Resolve OD-8.
- **Behaviour change?** The race fixes and conditional transitions: no. The cross-shape rule: **NEEDS-DECISION (D-05, = OD-8).**
  - (a) A period refuses if any session in its range is already settled individually, or excludes those sessions from its sum.
  - (b) A session settlement refuses when a period settlement covers its date.
  - (c) A per-payment claim table (`SettlementPayment`, with unique `paymentId`) becomes the single source of truth for "claimed". This is the most robust option.
- **Gate:**
  - Concurrent period ×2 → one `ok`, one `overlappingSettlement`.
  - Concurrent session ×2 → one `ok`, one `sessionAlreadySettled`.
  - Session settlement then a period over the same session → combined total ≤ the ledger teacher share.
  - Double `paySettlement` → one `ok`, one `notApproved`.
- **Repro:** `SEC-06.ts` (session plus period, both orders, paid out twice) and `SEC-06-race.ts` (period ×2, session ×2, approve and pay ×2).

#### SEC-07 — Voids and unpaid check-ins are invisible to the owner
- **Status (SEC-2b): FIXED.** `/audit` (`audit.view`): voids, absent switches, refunds, settlement transitions, price/cut changes, and present-but-unpaid check-ins (D-06 (a)); the receipt counts and lists voids, refunds and unpaid attendees. Linked from Dashboard and Analytics; a nav entry would edit a pinned `check:permissions` list (left for a decision).
- **Severity:** High. An insider can skim cash undetected. The only trace of a void is an AuditLog row that no centre screen reads, and a present-but-unpaid student is flagged nowhere.
- **Area:** Fraud / audit / receipts / analytics.
- **Evidence:**
  - `lib/db/payments.ts:296-312` (`sessionReceiptTotals`) sums `voided: false` only. `(center)/sessions/[id]/session-receipt.tsx:49-61` renders collected plus the present/late/absent counts, never a paid count or a void count.
  - `(center)/sessions/[id]/page.tsx:140`: after a void, the roster row just reverts to "Record payment". On a closed session it shows nothing (`session-roster.tsx:295-303`).
  - `lib/db/analytics.ts:91-100,125-140`: revenue filters `voided:false`, and there is no void metric anywhere.
  - `audit.view` is granted to OWNER and MANAGER (`lib/auth/permissions.ts:245`) but no page checks it. `scoped.auditLogs.list` (`lib/db/scoped.ts:977`) is never called from `app/`. The only AuditLog reader is the platform-admin page `(admin)/admin/centers/[id]/page.tsx:52`.
  - Unpaid check-in is a sanctioned path: `lib/validation/sessions.ts:395`, where `paymentMethodId` is optional ("No method = check in without recording a payment"). RECEPTIONIST holds `attendance.record` by default.
- **Exploit:**
  1. A MANAGER takes 100 EGP, records it, and later voids it with any reason. The payment vanishes from the roster, receipt, analytics and settlements, and the books now match the reduced cash.
  2. A RECEPTIONIST takes cash and checks the student in with no payment method. Nothing flags the student as present and unpaid.

  Detecting either needs the owner to compute `(present+late) × price − collected` by hand for every session.
- **Fix:**
  - Add a centre audit-log screen gated on `audit.view`.
  - Add "Unpaid attendees: N" and "Voided: N (amount, actor, reason)" lines to the receipt and the print view.
  - Add void totals and unpaid counts to analytics and the dashboard.
- **Behaviour change?** **NEEDS-DECISION (D-06).**
  - (a) Visibility only: the audit screen plus the receipt lines.
  - (b) Also require a reason for a check-in without payment.
  - (c) Also require OWNER approval for voids.
- **Gate:** a `(center)` route reads `auditLogs.list` behind `requirePermission(ctx, "audit.view")`. `sessionReceiptTotals` returns `voidedCount`, `voidedAmount` and `unpaidAttendeeCount`, and the receipt renders them.
- **Repro:** `SEC-07.ts`.

#### SEC-08 — Cancelling or rescheduling a paid session leaves its money editable forever and unsettleable
- **Status (SEC-2b): FIXED.** Cancel and reschedule are refused while the session holds an active payment (`hasPayments`); cancelled/rescheduled sessions close at the end of their day (status kept, no absences); void and refund refuse a terminal session (D-07 (c)). A refunded payment does not block (its money is back).
- **Severity:** High. An insider can retroactively change days whose cash was already counted (and SEC-07 makes the later void invisible). The teacher's share for those payments can never be paid.
- **Area:** Session lifecycle / void / settlements.
- **Evidence:**
  - `lib/db/sessions.ts:118-135` (`cancelSession`) has no "has payments" refusal. `rescheduleSession` (`:247-271`) is the same.
  - Terminal sessions never close: `isSessionClosed` is false for CANCELLED and rescheduled sessions, and `closeEndedSessions` filters `status: { not: CANCELLED }, rescheduledToId: null` (`lib/db/session-lifecycle.ts`).
  - Void and refund pass `allowTerminal: true` (`lib/db/payments.ts:225`, `lib/db/refunds.ts:93`). The actions don't apply the visibility window, so a direct call works on a session older than the window.
  - Revenue still counts these payments (`analytics.ts:91-100`). But `createSessionSettlement` refuses a session that isn't closed (`settlements.ts:146-149`), and `createPeriodSettlement` sums only `closedAt: { not: null }` (`:214-216`).
- **Exploit:** a MANAGER cancels a live session after students paid ("the teacher left early"). Months later they void those payments with any reason and pocket the equivalent; that month's revenue silently drops. Until the void, the teacher's share shows in "earnings" but can never be settled.
- **Fix:** do one or both of:
  - Refuse cancel or reschedule while active payments exist, so staff void or refund first.
  - Close terminal sessions at day end like any other session (stamp `closedAt`), so void and refund lock with the day.

  Also include closed-and-cancelled sessions' remaining payments in settlements, and apply the visibility window to money write actions.
- **Behaviour change?** **NEEDS-DECISION (D-07).**
  - (a) Refuse cancel/reschedule while active payments exist.
  - (b) Auto-close terminal sessions at day end.
  - (c) Both.
- **Gate:**
  - (a): cancelling a paid live session is refused.
  - (b): after its day, `voidPayment` with the real clock returns `sessionClosed`.
  - Revenue and settlement totals reconcile in both cases.
- **Repro:** `SEC-08.ts`. A payment from 2026-03-10 was voided on 2026-10-13.

#### SEC-09 — A TEACHER-only member can call staff-only centre actions
- **Status (SEC-2a): FIXED.** `roleForExperience` denies instead of falling back; a denied context grants nothing (`canInContext`/`ctxCan`); every `(center)` action reaches `ctxCan` (static sweep); the centre unblock refuses a CLASS-scope block.
- **Severity:** High. This is a role bypass. Today it gives a teacher full-roster search (minors' names and codes) and lets them rewrite other teachers' block lists and staff-placed class blocks, at every centre (TEACHER holds `student.block` at 5/5 dev centres).
- **Area:** AuthZ / role resolution.
- **Evidence:**
  - `lib/auth/relations.ts:197-210`: `roleForExperience("center")` falls back to `staff ?? teacher ?? student`, so a TEACHER-only user acts as TEACHER inside centre actions.
  - No Server Action calls `requireExperience` or `hasExperience`; only `(center)/layout.tsx:27` does, and layouts don't protect actions.
  - `(center)/teachers/actions.ts:104-130` (`searchBlockCandidatesAction`): its only gate is `ctxCan(ctx,"student.block")`, after which it searches the whole active roster.
  - `:342-373` (`blockStudentAction`): `teacherUserId` comes from the form.
  - `:394-408` (`unblockStudentAction`): deletes **any** `StudentBlock` in the centre, with no scope check.
  - More generally, any permission a centre grants TEACHER in the matrix opens every centre action gated on it. Granting `payment.record`, for example, opens `recordPaymentAction`.
- **Exploit:** a teacher takes the action ID from the public client chunk of `/teachers/[id]` and posts it with their own session cookie. They:
  - enumerate every student at the centre, two letters at a time;
  - block a rival teacher's students from that teacher;
  - remove a block a manager placed for safety reasons.

  Every write is audited under the teacher's id, but nothing is refused.
- **Fix:**
  - Add an action-safe experience guard to every `(center)` action, returning FORBIDDEN rather than redirecting, and the `"teacher"` equivalent to every `(teacher)` action (SEC-44).
  - Make `roleForExperience` deny instead of falling back when the requested experience is absent.
  - In `unblockStudentAction`, require `block.scope === "TEACHER"`.
- **Behaviour change?** No. Teachers are already bounced from every `(center)` page.
- **Gate:**
  - A context resolved for a TEACHER-only member with experience `"center"` is denied by the action guard.
  - A static sweep confirms every export in `app/[locale]/(center)/**/actions.ts` reaches the guard.
  - `unblockStudentAction` refuses a CLASS-scope block.
- **Repro:** `SEC-09.ts`. It uses the real `resolveCenterRelations`, `roleForExperience`, `loadPermissionGrants` and `can`, and replicates the action query shapes.

#### SEC-10 — The PostgREST lockdown exists only as hand-made state on the dev project
- **Status (SEC-2a): FIXED.** Lockdown migration `20261017090100_sec2a_data_api_lockdown` (RLS on every public table, zero policies, no grants or default grants to anon/authenticated, private buckets); `npm run check:rls` in CI after `migrate deploy`. (D-19 (a))
- **Severity:** High (latent Critical). On any fresh Supabase project (the M20 production project, or the CI project `ci.yml` points at), every table would very likely be readable and writable with the public anon key. That includes minors' PII and the money and membership tables.
- **Area:** Supabase RLS / grants.
- **Evidence:**
  - No migration contains `ENABLE ROW LEVEL SECURITY`, `REVOKE`, `GRANT` or `CREATE POLICY`. The lead's grep of `prisma/migrations` found only enum values.
  - The live dev state that keeps PostgREST shut appears nowhere in the repo: RLS is on for 39/39 app tables, schema `public` has a NULL ACL (anon and authenticated have no USAGE), there are no default privileges and no table grants.
  - `supabase/m10-rls-and-storage.sql` is applied by no command, fails as written (SEC-30), and contains no REVOKE.
  - `.github/workflows/ci.yml:56-57` runs only `prisma migrate deploy`.
  - Stock Supabase projects grant USAGE and default ALL on `public` to anon and authenticated. Those defaults are still visible on this project for `storage`, `graphql` and `graphql_public`.
- **Exploit:** an anonymous visitor copies `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the JS bundle and can then:
  - read `GET /rest/v1/StudentProfile?select=*`;
  - rewrite frozen money snapshots with `PATCH /rest/v1/Payment?id=eq.…`;
  - make themselves OWNER with `PATCH /rest/v1/Membership`;
  - erase the audit trail with `DELETE /rest/v1/AuditLog`.

  It is cross-tenant, needs no login, and involves no app code.
- **Fix:** add a checked-in Prisma migration that:
  - enables RLS on every table, including `_prisma_migrations`;
  - runs `REVOKE ALL ON SCHEMA public FROM anon, authenticated`;
  - runs `REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon, authenticated`;
  - runs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL … FROM anon, authenticated`.

  Optionally, also remove `public` from the Data API's exposed schemas in the dashboard. Decide the posture first (D-19).
- **Behaviour change?** No. The app never uses the Data API for tables.
- **Gate:** a new live, read-only `check:rls` asserts:
  - every `public` table has `relrowsecurity`;
  - anon and authenticated have no schema USAGE and no table privileges;
  - `pg_default_acl` has no grant to them on `public`;
  - no `public` function is executable by them.

  Run it in CI after `migrate deploy` against a **fresh** project, where `SEC-10.ts` must print NOT REPRODUCED.
- **Repro:** `SEC-10.ts`. It prints **NOT REPRODUCED against dev**, because the hand-made lockdown holds there. It is the probe to rerun against every newly provisioned project. The finding is about the repo gap, which the grep above confirms.

#### SEC-11 — A cross-centre "phone/email → name" lookup whose rate limit is bypassable and unaudited
- **Status (SEC-2a): FIXED.** Postgres-backed limiter inside `resolveContact` covers all five disclosing paths (per staff member and per centre); a person known only outside the organisation is described without a name. (D-08 (b))
- **Severity:** High (borderline Medium). Any staff member with `student.manage` at any centre can turn phone numbers or emails into the global names of minors registered at **other** tenants, at volume. Spec §5.1 accepts the disclosure only with a rate limit, and that control doesn't hold.
- **Area:** Abuse / enumeration / privacy of minors.
- **Evidence:**
  - `lib/db/identity.ts:47-98` searches the global `User` and every centre's local contacts. `describeMatch` (`:125-153`) returns `name: fullName(user)` plus `userId`.
  - The only `checkRateLimit` call sites in the app are `(center)/students/actions.ts:166` and `(center)/teachers/actions.ts:150` (the `lookupPersonByPhoneAction` pair; confirmed by grep).
  - `createStudentAction` returns `{ status: "matchFound", match }` before any write and with no limit (`students/actions.ts:211-224`, which also accepts email). `addNewAttendeeAction` (`sessions/actions.ts:402-409`) and `addTeacherMembership` (`lib/db/teacher-membership.ts:97`) do the same.
  - `lib/rate-limit.ts:12` keeps its counters in a per-process `Map`, so on Vercel the real limit is 20 × instances, reset on every cold start.
  - No AuditLog row is written for lookups.
- **Exploit:** a receptionist at centre A posts `createStudentAction` with junk names and a list of phone numbers (a school class's WhatsApp group). Each reply returns the real name of anyone known anywhere on the platform, children included. It also reveals whether each person is already at A. Nothing is written and nothing is audited.
- **Fix:**
  - Route all four paths through one guarded lookup, keyed per user and per centre.
  - Move the limiter to a shared store (a Postgres table or Upstash).
  - Audit match disclosures.
  - Return only "a person with this contact exists" when the match comes solely from another organisation's local record.
- **Behaviour change?** **NEEDS-DECISION (D-08).**
  - (a) Enforce the limit on every path with a shared store, and change nothing in the UX.
  - (b) Also mask the name when the match is outside the organisation.
  - (c) Also audit every disclosure.
- **Gate:** the 21st call within a minute on **each** of the four entry points returns `rateLimited`, with the count shared across two simulated instances. A match outside the organisation carries no `name`.
- **Repro:** `SEC-11.ts`. Two simulated instances allowed 40 calls instead of 20. Centre A resolved a phone known only to centre B to the victim's name in 100/100 calls, with 0 rows and 0 audit rows written.

---
### 3.3 Medium

#### SEC-12 — A refund racing a void leaves a payment both voided and refunded; a double void succeeds
- **Status (SEC-2b): FIXED.** Void and refund lock the payment row (`FOR UPDATE`, centre-scoped), re-read it and write conditionally; CHECK `Payment_not_voided_and_refunded`; a double refund is `alreadyRefunded`, never a thrown unique error. Asserted with parallel void ∥ refund.
- **Severity:** Medium. The ledger becomes inconsistent: the payment contributes −amount to revenue and both shares, which breaks "void ≠ refund". It needs two concurrent actors and leaves audit rows.
- **Area:** Concurrency / money.
- **Evidence:**
  - `lib/db/refunds.ts:100-123` and `lib/db/payments.ts:240-257` each run a plain `findFirst` check, then a blind `update where {id}`. Neither locks the Payment row.
  - No `CHECK (NOT (voided AND refunded))` exists.
  - The void-on-absent path shares `voidPaymentRow` (`lib/db/attendance.ts:254-268`).
  - Analytics computes Σ non-voided − Σ Refund (`analytics.ts:95-106`).
  - A double refund is blocked by `Refund_paymentId_key`, but the second call **throws** P2002 (a 500) instead of returning `alreadyRefunded`.
- **Exploit:** a manager voids a payment while an accountant refunds the same payment. Both succeed, so the day's revenue drops by twice the fee.
- **Fix:**
  - `SELECT … FROM "Payment" WHERE id=$1 AND "centerId"=$2 FOR UPDATE`, then re-read in a new statement. Alternatively, use a conditional `updateMany` with `voided:false, refunded:false` and check `count === 1`.
  - Add the CHECK constraint.
  - Map P2002 to `alreadyRefunded`.
- **Behaviour change?** No.
- **Gate:**
  - `Promise.all([refund, void])` gives exactly one `ok`, at most one of the two flags set, and a revenue contribution of 0.
  - Void ×2 gives one `alreadyVoided`.
  - Refund ×2 gives one `alreadyRefunded` without throwing.
- **Repro:** `SEC-12.ts`.

#### SEC-13 — Concurrent enrolments overbook a class past its room-set capacity
- **Status (SEC-2b): FIXED.** `claimClassSeat` (lib/db/reservations.ts) is the one seat-taking function: it locks the class row and counts in a fresh statement; instant enrol, confirmation and the staff Enrol action all use it, and a profile is never made for a student who got no seat. Asserted with 6 parallel enrolments.
- **Severity:** Medium. This breaks a hard rule (spec §5.1 "Capacity"). Ordinary students can trigger it through instant-enrol. No money is involved, and the overbooking is visible afterwards.
- **Area:** Concurrency / enrolment.
- **Evidence:** all three paths count, then create, with no lock on `ClassGroup`:
  - instant-enrol: `lib/db/reservations.ts:183-198`;
  - `confirmReservation`: `:263-282`;
  - `(center)/classes/actions.ts:727-747` (`enrollStudentAction`), which is not even in a transaction.
- **Exploit:** parallel enrol requests when a popular class opens leave more ACTIVE enrolments than there are seats.
- **Fix:** `SELECT id FROM "ClassGroup" WHERE id=$1 AND "centerId"=$2 FOR UPDATE`, then count in a new statement. Merge the three paths into one `lib/db` function.
- **Behaviour change?** No.
- **Gate:** 6 concurrent `reserveOrEnroll` calls on a cap-2 class give 2 `enrolled`, 4 `classFull`, and an ACTIVE count of 2.
- **Repro:** `SEC-13.ts` (6 ACTIVE enrolments on a cap-2 class).

#### SEC-14 — A MANAGER can reactivate a staff membership the OWNER deactivated
- **Severity:** Medium. A non-OWNER can effectively re-grant a role (spec §3: only OWNER grants roles). It needs an insider and leaves an audit row.
- **Area:** AuthZ.
- **Evidence:**
  - `(center)/settings/staff/member-actions.ts:138-182` (`setMemberActiveAction`) is gated only by `staff.manage`, which is in the MANAGER baseline (`:42-45`).
  - `ownerGuard` escalates only when an OWNER membership is touched (`:58-61`).
  - `changeMemberRoleAction`, by contrast, requires `membership.role.assign` (`:89`).
- **Exploit:** the OWNER suspends a suspected fraudster. A colleague MANAGER reactivates them, and their full role and grants return on the next request.
- **Fix:** require `membership.role.assign` (OWNER-only) for `active=true`.
- **Behaviour change?** **NEEDS-DECISION (D-09).**
  - (a) Reactivation becomes OWNER-only; deactivation stays with MANAGER.
  - (b) Both directions become OWNER-only.
  - (c) Keep it as is and record that in §5.1.
- **Gate:** a MANAGER calling the action with `active=on` on an inactive MANAGER gets `forbidden`, and the row stays inactive.
- **Repro:** none (traced in code).

#### SEC-15 — The TEACHER `student.block` and `analytics.own.view` matrix cells are never enforced
- **Severity:** Medium. A configured denial in the "server-side authoritative" matrix is silently ignored.
- **Area:** AuthZ / matrix.
- **Evidence:**
  - `(teacher)/teacher/students/actions.ts:59-133`: block and unblock make no `ctxCan` check.
  - `(teacher)/teacher/students/[id]/page.tsx:133-137` renders the block form unconditionally.
  - `analytics.own.view` has no call site outside `lib/auth/permissions.ts`.
  - Yet the matrix offers both cells (`editableActionsFor("TEACHER")`).
- **Exploit:** the OWNER revokes TEACHER `student.block`, and teachers keep blocking students.
- **Fix:** add `ctxCan` checks to both actions and gate the form. Gate the teacher money widgets on `analytics.own.view`, or remove those cells from `editableActionsFor`.
- **Behaviour change?** No. The matrix will then mean what it says.
- **Gate:**
  - With TEACHER `student.block=false`, `teacherBlockStudentAction` returns `forbidden`.
  - A static check confirms every `PERMISSIONS` entry has a call site.
- **Repro:** none.

#### SEC-16 — Student-portal writes and the parent read path ignore suspended centres and deactivated profiles
- **Severity:** Medium. A direct call bypasses a platform suspension and a centre's deactivation of a student.
- **Area:** AuthZ / lifecycle.
- **Evidence:**
  - `lib/db/reservations.ts:131-210` (`reserveOrEnroll`) checks neither `center.lifecycleState` nor `existingProfile.active` (`:150-153,197`). Only the Discover page filters lifecycle (`discover/page.tsx:81`).
  - `(student)/student/profile/actions.ts:62-84` has the same gap.
  - `lib/db/parents.ts:121-130` (`verifiedChildLinks`) does too.
  - `requestToTeachAction` and `acceptInvitationAction` do check lifecycle.
- **Exploit:**
  - An expelled (deactivated) student self-enrols in an instant-enrol class and shows ACTIVE on the roster.
  - Anyone creates profiles and enrolments at a SUSPENDED centre.
  - A parent of a deactivated child keeps reading the child's data.
- **Fix:** add an `accessibleCenterWhere()` helper next to `ACCESSIBLE_LIFECYCLE_STATES`, plus `active: true` filters, on all three paths.
- **Behaviour change?** The student write paths: no. The parent read: **NEEDS-DECISION (D-10).**
  - (a) Hide the child entirely.
  - (b) Allow read-only history.
- **Gate:**
  - `reserveOrEnroll` at a SUSPENDED centre returns `notFound`; for an inactive profile it is refused.
  - `verifiedChildLinks` returns 0 rows for a suspended centre or an inactive profile.
- **Repro:** none.

#### SEC-17 — The "one-time" student profile completion can be repeated, and it overwrites the parent phone with no audit row
- **Severity:** Medium. A student, usually a minor, can silently rewrite staff-entered contacts, including the parent phone that drives parent-link origination (feeding SEC-03).
- **Area:** AuthZ / page vs action.
- **Evidence:**
  - `(student)/layout.tsx:119-121` shows the form only while `profileCompletedAt` is null.
  - `(student)/student/profile/actions.ts:27-87` has no such check. It updates name, phone, email, grade and all four parent fields, and writes no AuditLog row.
  - `lib/db/parents.ts:87-89` matches on `parentPhone`.
- **Exploit:** a student replaces the parent phone with a friend's number. Whoever registers with that number gets PENDING links, which one staff click then turns into access.
- **Fix:** refuse when `profileCompletedAt` is set. If later edits are wanted, exclude the parent fields and audit the change.
- **Behaviour change?** **NEEDS-DECISION (D-11).**
  - (a) Strictly one-time, as documented.
  - (b) Later edits allowed, but not to the parent fields, and audited.
- **Gate:** a call on a completed profile returns `alreadyCompleted`, and `parentPhone` is unchanged.
- **Repro:** none.

#### SEC-18 — No separation of duties on money
- **Status (SEC-2b): FIXED.** D-12: a non-OWNER cannot approve or pay a settlement they created (`ownSettlement`); an OWNER may, and the audit row says `selfApproved: true`. The seed now drafts as the manager and approves as the owner.
- **Severity:** Medium. One MANAGER can record, void, refund, edit the cut, and create, approve and pay settlements, including their own. It is all audited, but there is no maker-checker.
- **Area:** AuthZ / money workflow.
- **Evidence:**
  - All four settlement transitions gate on `settlement.manage` (`(center)/settlements/actions.ts:46-180`). `lib/db/settlements.ts` never compares `approvedBy` or `paidBy` with `createdBy` or `teacherId`.
  - `voidPayment` never compares `voidedBy` with `recordedBy`.
  - The MANAGER baseline holds all of these (`lib/auth/permissions.ts:217-251`).
  - A MANAGER can add themselves as a TEACHER (`teachers/actions.ts:185-194`, `refusePrivileged:false`).
- **Exploit:** a manager makes themselves a teacher with a low centre cut, then creates, approves and pays their own settlement in one sitting. The SEC-06 repro shows a single actor taking a settlement all the way to PAID.
- **Fix:** split `settlement.approve` and `settlement.pay` into separate matrix actions. Refuse approve or pay by the creator or the beneficiary, configurably. Optionally make voids above a threshold OWNER-only.
- **Behaviour change?** **NEEDS-DECISION (D-12).**
  - (a) Block self-approval only (`teacherId ≠ actor`).
  - (b) Require approver ≠ creator. This is a problem for one-person centres.
  - (c) Split the permissions only.
  - (d) Allow it, but flag it in analytics.
- **Gate:** approve or pay of a settlement whose `teacherId` is the actor (or whose `createdBy` is the actor, under (b)) is refused.
- **Repro:** covered by `SEC-06.ts` (a single actor through to PAID).

#### SEC-19 — The session receipt doesn't subtract refunds
- **Status (SEC-2b): FIXED.** The receipt's "collected" and both shares are net of refunds, with "Refunded (n)" and a named refunds section, on screen, in print and for the teacher.
- **Severity:** Medium. All three receipts (on screen, staff print, teacher print) overstate the money collected and the teacher share after a refund, and hide that the refund happened.
- **Area:** Receipts.
- **Evidence:** `lib/db/payments.ts:306` aggregates `voided: false` only. Analytics subtracts `Refund` rows (`analytics.ts:46-66`); the receipt (`(center)/sessions/[id]/receipt-data.ts`) does not.
- **Exploit:** a manager refunds a payment and keeps the cash. The receipt the owner or teacher reviews still shows the full amount.
- **Fix:** subtract refunds in `sessionReceiptTotals` and render a "Refunded: N (amount)" line.
- **Behaviour change?** No. It aligns the receipt with the documented refund rule.
- **Gate:** after a refund, `sessionReceiptTotals.collected` equals paid − refunded.
- **Repro:** none.

#### SEC-20 — Void-by-Absent needs no reason, and Absent→Present re-entry leaves the student present and unpaid
- **Status (SEC-2b): FIXED.** D-13: a status change that voids a payment needs a reason — zod, the Server Action and `changeAttendanceStatus` each refuse it without one (`reasonRequired`); a change that voids nothing keeps it optional.
- **Severity:** Medium. It is a void path with no reason; the only trace is the receipt's change log.
- **Area:** Attendance correction / void.
- **Evidence:**
  - `lib/validation/sessions.ts:117`: the reason is optional for `setAttendanceSchema`, while a direct void requires one (`:169`).
  - `lib/db/attendance.ts` (`changeAttendanceStatus`) voids with `reason` possibly null.
- **Exploit:** a manager toggles a paid student PRESENT → ABSENT (which voids the payment, with no reason), then ABSENT → PRESENT. The student is present and unpaid, and the cash is gone.
- **Fix:** require a reason whenever the change voids a payment, and flag present-unpaid rows (SEC-07).
- **Behaviour change?** **NEEDS-DECISION (D-13).** This contradicts a recorded decision: §5.1 says "the reason is optional".
  - (a) Require the reason only when a payment is voided.
  - (b) Keep it optional.
- **Gate:** PRESENT → ABSENT on a paid attendee without a reason returns `reasonRequired`.
- **Repro:** none.

#### SEC-21 — A manager can reopen unclosed past sessions by changing the centre timezone
- **Status (SEC-2b): FIXED.** D-14 (b): `Session.timezone` is the centre's timezone frozen at creation (a trigger fills it and keeps it); the write guard, Present/Late, the end-of-day close, "today" at reception and the teacher edit deadline read it. A centre timezone edit moves nothing already created.
- **Severity:** Medium (likely). This bypasses closed-session immutability for sessions not yet lazily closed.
- **Area:** Settings / session lifecycle.
- **Evidence:**
  - Closure is lazy: `isSessionDayOver(date, now, tz)` reads the timezone from `CenterSettings` at every write (`lib/db/session-lifecycle.ts`).
  - `saveGeneralSettingsAction` lets anyone with `center.settings.edit` (MANAGER by default) set any IANA zone (`lib/validation/settings.ts`).
- **Exploit:** early in the morning, before anything sweeps `closeEndedSessions`, a manager sets the zone to `Etc/GMT+12`. Yesterday's sessions accept attendance, payments and voids again. The manager then sets it back.
- **Fix:** freeze the timezone on each session at creation, or make the timezone OWNER-only, or close sessions eagerly with a scheduled job.
- **Behaviour change?** **NEEDS-DECISION (D-14).**
  - (a) OWNER-only timezone.
  - (b) A per-session frozen timezone.
  - (c) An eager close job.
- **Gate:** a timezone change never makes writable a session whose day ended under the old zone.
- **Repro:** none (timing-dependent; logic traced).

#### SEC-22 — A FIXED centre cut above the price silently zeroes the teacher's share
- **Status (SEC-2b): FIXED.** D-15 (c): `centerCutError` (lib/money.ts, the one rule) refuses a FIXED cut above the price in every schema and in the data layer — class create and edit (so lowering a price below the cut is refused), one-time sessions and a session's override. The clamp stays as the backstop.
- **Severity:** Medium. An insider can zero a teacher's share through configuration that looks valid. It is audited and visible.
- **Area:** Input validation / money.
- **Evidence:**
  - `lib/validation/classes.ts:94-115` (`resolveShareValue`) checks FIXED only against `MAX_PIASTRES`. The one-off schema, the override schema and `generalSettingsSchema` do the same, and so does the data layer (`lib/db/class-sessions.ts:1813-1818`).
  - `lib/money.ts:67` clamps silently: `Math.min(Math.max(raw,0), amount)`.
  - A probe of the real schemas accepted a 100 EGP class with FIXED 500 EGP, giving `teacherShare = 0`.
- **Exploit:** a manager sets FIXED above the price, so every payment freezes `teacherShareSnapshot = 0`. Lowering a class's price later causes the same thing by accident.
- **Fix:** refuse FIXED > price in every schema and writer, against the stored price; for an override, against `priceSnapshot`. Keep the clamp as a backstop.
- **Behaviour change?** **NEEDS-DECISION (D-15).**
  - (a) Refuse it everywhere.
  - (b) Allow it with a warning, and record "FIXED ≥ price means the centre keeps all" in §5.1.
  - (c) Refuse it, and also re-check when a price is lowered.
- **Gate:** `classGroupSchema` with price 100 and FIXED 500 fails (likewise the one-off and the override). Lowering a price below FIXED is refused.
- **Repro:** none (a pure probe exists in the audit scratchpad).

#### SEC-23 — A period settlement accepts any date range, so one bad range blocks a teacher's period settlements permanently
- **Status (SEC-2b): FIXED.** D-16 (c): a period is strict dates, `to` not in the future (`futureRange`), at most 366 days (`rangeTooLong`); a DRAFT can be cancelled, releasing its claims.
- **Severity:** Medium. It is an insider (or typo) denial of service on teacher payouts, with no in-app recovery.
- **Area:** Input validation / settlements.
- **Evidence:**
  - `lib/validation/settlements.ts:22-33` validates dates with `Date.parse` plus a slice only.
  - `lib/db/settlements.ts:187` checks only `from > to`, and `:190-198` refuses any later overlapping period.
  - No delete or cancel path exists.
  - The probe accepted `0001-01-01..9999-12-31`.
- **Exploit:** a range like 2026-10-01..9999-12-31 makes every later period settlement for that teacher return `overlappingSettlement`.
- **Fix:** use strict `dateOnlyField`, require `to ≤ today` in the centre's timezone, and cap the span (for example 366 days).
- **Behaviour change?** **NEEDS-DECISION (D-16, tied to OD-8).**
  - (a) Bounds only.
  - (b) Add a "cancel DRAFT settlement" transition.
  - (c) Both.
- **Gate:** `to = 9999-12-31` is refused, and `to > today` returns `invalidRange`.
- **Repro:** none.

#### SEC-24 — Money sums over int4 columns overflow above about 21.47M EGP
- **Status (SEC-2b): FIXED.** D-17 (b): every money aggregate is a raw `SUM(...)::bigint` (analytics, the receipt, the Sessions tile); a price is capped at 100,000 EGP (`MAX_PRICE_PIASTRES`, ~30× a realistic session price); a settlement total beyond `integer` is refused (`totalTooLarge`).
- **Severity:** Medium (likely). Analytics and settlements crash for a large centre over a long window. It is a denial of service, not corruption.
- **Area:** Numeric bounds.
- **Evidence:**
  - Every money column is `Int` (`prisma/schema.prisma:934-946,997-999,1048,1156`), including `Settlement.totalAmount`.
  - `_sum` aggregates run at `analytics.ts:63,96,138,147,179`, `payments.ts:307` and `settlements.ts:105-109`.
  - The Prisma 6.19.3 engine raises P2023 when an Int aggregate exceeds i32.
- **Exploit:** a centre collecting about 3M EGP a month views a yearly range, and the page errors. A manager setting the price to `MAX_PIASTRES` (10M EGP) breaks it in 3 payments.
- **Fix:** sum via `$queryRaw … ::bigint`, or migrate the money columns and `totalAmount` to `BigInt`. Lower `MAX_PIASTRES` to a realistic cap.
- **Behaviour change?** **NEEDS-DECISION (D-17).**
  - (a) A BigInt migration.
  - (b) A raw bigint sum plus a lower cap.
  - (c) Cap only.
- **Gate:** on a throwaway local DB, three payments of 1e9 piastres sum to 3e9 in `periodRevenue` and `createPeriodSettlement` without throwing.
- **Repro:** none. The probe needs writes that the shared dev DB must not receive; run it on the local throwaway cluster.

#### SEC-25 — Any signed-in account can flood any centre's Approvals queue
- **Status (SEC-2c): FIXED.** One PENDING request per (requester, centre) (`alreadyRequested`), zero-centres enforced on the server (`alreadyTeaching`), per-account and per-IP limits, one page of 50 per Approvals queue (D-18).
- **Severity:** Medium. A remote, low-privilege actor can deny service to every centre's approvals screen and put spoofable text in front of staff.
- **Area:** Abuse.
- **Evidence:**
  - `(teacher)/teacher/centers/actions.ts:30-74` (`requestToTeachAction`) needs only `getCurrentUser()`. It has no zero-centres check (that exists on the page only, `page.tsx:28`), no dedupe and no limit.
  - `(center)/approvals/page.tsx:72-80` loads `changeRequests.list` and `reservations.listPending` (`lib/db/scoped.ts:995,1027`) with no `take`.
- **Exploit:** a script loops over every centre id (listed on `/teacher/centers`) thousands of times. Approvals pages bloat, real requests get buried, and the requester name and note can carry phishing text.
- **Fix:** allow one PENDING request per (requester, centre), enforce zero-centres on the server, rate-limit the action, and paginate approvals.
- **Behaviour change?** No.
- **Gate:** a second request while one is PENDING returns `alreadyRequested`, and the approvals loader returns at most one page.
- **Repro:** none.

#### SEC-26 — Any account can reserve every class everywhere and take instant-enrol seats
- **Status (SEC-2c): FIXED.** D-18: 30 open reservations and 30 active self-enrolments per account (`SELF_SERVICE_CAPS`), serialized per account; 30/hour per account and 300/hour per IP on the action. No verified-account requirement beyond production email confirmation; CAPTCHA at M20.
- **Severity:** Medium. Blocks real students' enrolment and floods queues. The rows trace back to the accounts.
- **Area:** Abuse.
- **Evidence:**
  - `(student)/student/discover/actions.ts:31-41` needs only a signed-in user.
  - `lib/db/reservations.ts:142-247`: instant-enrol creates a profile and an ACTIVE enrolment that counts against the cap. Cancel-then-request repeats without limit (`:316-341`), and there is no lifecycle check (SEC-16).
- **Exploit:** a few free accounts take every seat in every instant-enrol class, so real students see `classFull`.
- **Fix:** per-user caps on open reservations and self-service enrolments in the data layer, a shared-store rate limit, and a lifecycle check. Optionally require a verified email before instant-enrol.
- **Behaviour change?** **NEEDS-DECISION (D-18):** the cap values, and whether instant-enrol requires a verified account.
- **Gate:** one user's 31st reservation is refused, and reserving at a SUSPENDED centre returns `notFound`.
- **Repro:** none.

#### SEC-27 — Sign-in and sign-up have no app-level throttling
- **Severity:** Medium (likely). Credential stuffing is bounded only by GoTrue, whose per-IP limits see Vercel's egress IP. That lets one client trip a lockout shared by everyone.
- **Area:** AuthN / abuse.
- **Evidence:**
  - `(auth)/actions.ts:65-90,92-159` contain no `checkRateLimit`.
  - `lib/supabase/server.ts` forwards no client IP, and `headers()` is never read anywhere.
  - There is no `supabase/config.toml`, so the auth limits and CAPTCHA setting exist only in the dashboard.
  - Leaked-password protection is off (§2.1-A).
- **Exploit:** password spraying against staff emails, or flooding the action to lock everyone out of login during a rush.
- **Fix:**
  - A per-email plus per-IP throttle in a shared store.
  - Supabase CAPTCHA (Turnstile) on sign-up and sign-in.
  - Record the auth limits in the docs.
  - Turn on leaked-password protection.
- **Behaviour change?** CAPTCHA changes the UX: part of **D-18**.
- **Gate:** the N+1th failed `signInAction` for the same email within the window returns `rateLimited` without calling Supabase.
- **Repro:** none (would mean hammering live auth).

#### SEC-28 — No security response headers anywhere
- **Severity:** Medium. This is missing defence-in-depth on an app holding minors' PII. Any future XSS would run unconstrained and could take the JS-readable refresh token (SEC-33). It is not on the §2.1 checklist.
- **Area:** Platform.
- **Evidence:** the app sends no CSP, `frame-ancestors`/X-Frame-Options, nosniff, Referrer-Policy or Permissions-Policy:
  - `next.config.ts:4-6` is an empty config;
  - `proxy.ts` sets no headers;
  - there is no `vercel.json`.

  Clickjacking is largely mitigated today, because every auth cookie is `SameSite=Lax`. That stops holding if subdomain-per-centre branding (OD-1) puts other content on the same site.
- **Exploit:** this amplifies any XSS, and becomes clickjacking on print pages and money buttons if same-site content appears.
- **Fix:** add `headers()` in `next.config.ts` with:
  - a CSP: `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, plus `img-src`/`connect-src` for the Supabase host, and a nonce for `script-src` later;
  - `X-Frame-Options: DENY`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - a Permissions-Policy.

  Add a §2.1 checklist item for it.
- **Behaviour change?** No. Test the CSP against next-intl and inline styles.
- **Gate:** `check:headers` imports `next.config.ts`, calls `headers()`, and asserts those headers on `/:path*`.
- **Repro:** none (no server may be run).

#### SEC-29 — No retention or erasure path for minors' data; AuditLog keeps names and free-text block reasons forever
- **Status (SEC-2c): OPEN.** Unchanged: retention and erasure wait on OD-2, now an explicit M20 legal-review box.
- **Status (SEC-2b): OPEN (D-20 part fixed).** D-20: audit rows now carry ids, amounts, counts, statuses and dates only — `lib/db/audit-row.ts` refuses a name, contact or free-text key, every writer goes through it, and the reason lives on the record (platform catalog rows exempt, their names being platform reference data). Existing rows are kept, unchanged. **Retention and erasure stay OPEN** — that is OD-2 (legal review).
- **Severity:** Medium. Every record belongs to a minor, OD-2 is open and gates production, and AuditLog is carved out of the visibility window.
- **Area:** Privacy of minors.
- **Evidence:**
  - Nothing in the code anonymises or erases data.
  - Students with history can't be deleted (`lib/db/students.ts:169-178`).
  - `student.delete` writes the name into `AuditLog.before` (`(center)/students/actions.ts:425-439`).
  - Block reasons are copied into AuditLog (`teachers/actions.ts:376-388,410-420`, `teacher/students/actions.ts:89-96`, `classes/actions.ts:814-820`).
- **Exploit:** a parent's deletion request can't be honoured. A breach exposes names and behavioural notes indefinitely.
- **Fix:**
  - Record a retention rule under OD-2.
  - Keep ids, not names or free text, in AuditLog.
  - Add an anonymisation routine for deactivated students past retention: null the contact fields, photo and parent contact, and keep the money and attendance rows.
- **Behaviour change?** **NEEDS-DECISION (D-20, = OD-2).**
- **Gate:** a static sweep finds no `name`/`reason` keys in `writeAuditLog` payloads, and anonymisation nulls PII on a fixture student.
- **Repro:** none.

#### SEC-30 — The documented M20 RLS script fails on missing tables and omits 14 current ones
- **Severity:** Medium. The one prescribed hardening step can't complete, so M20 gets ticked on a partial or no-op run.
- **Area:** Supabase RLS.
- **Evidence:**
  - `supabase/m10-rls-and-storage.sql:113-122` loops over `Branch`, `EducationSystem`, `Grade` and `Subject`, none of which exist. It aborts on the first iteration (42P01).
  - It omits `User`, `Organization`, `PermissionGrant`, `MembershipBranchGrant`, the `Catalog*` tables, `CenterCatalogSelection`, `Refund`, `Settlement`, `ParentLink`, `SessionRating(Skip)` and `StudentCodeCounter`.
  - It has no `avatars`/`id-cards` storage policies (`:168-205`).
  - `:21` wrongly says Prisma uses the service-role key.
  - The only gate is a text grep (`scripts/class-periods-check.ts:226-229`).
- **Exploit:** none directly. It is operational: production goes live believing policies exist.
- **Fix:** replace the file with SEC-10's lockdown migration (if D-19 picks (a)), or generate the table list from the catalog. Then replace the grep gate with `check:rls`.
- **Behaviour change?** No.
- **Gate:** `check:rls` runs live.
- **Repro:** none (running the SQL would modify dev).

#### SEC-31 — The drafted M10 policies, if ever granted, would let a RECEPTIONIST rewrite money or become OWNER, and a TEACHER read the whole centre
- **Severity:** Medium (latent High). It is harmless only because anon and authenticated currently hold no grants.
- **Area:** Supabase RLS design.
- **Evidence:**
  - `supabase/m10-rls-and-storage.sql:131-134`: a `FOR ALL` write policy on every listed table, including `Membership`, `Payment`, `SessionAttendee` and `CenterSettings`.
  - `:49-60`: a hardcoded role list, `OWNER, MANAGER, RECEPTIONIST`. That breaks CLAUDE.md rule 6, and it ignores `PermissionGrant` and the OWNER-only ceiling.
  - `:34-46,127-131,146-149`: read for **any** active membership, TEACHER included, covering `StudentProfile` (parent phones) and `AuditLog`.
  - There is no visibility-window filter (rule 9) and no lifecycle or branch-grant awareness.
- **Exploit:** if grants are ever added, a RECEPTIONIST could send `PATCH /rest/v1/Membership {"role":"OWNER"}` or rewrite `Payment.centerShareSnapshot` with no void and no audit. A TEACHER could dump every parent phone.
- **Fix and behaviour:** **NEEDS-DECISION (D-19).**
  - (a) Deny-all: no grants and zero policies on `public`, enforced by SEC-10, with the policy section dropped and `docs/02` §5 and §10 updated. **Recommended.**
  - (b) SELECT-only policies, never on money, membership, permission or audit tables.
  - (c) A JWT-per-query design (Phase 2).
- **Gate:** under (a), `check:rls` asserts zero `public` policies and zero privileges; under (b), every `pg_policies` row has `cmd = 'SELECT'`.
- **Repro:** none (latent).

---
### 3.4 Low

Low findings use a compact form. Every field is still present.

**SEC-32 — Discover runs 2 queries per centre on every load, then paginates in memory.**
- Status (SEC-2c): **FIXED.** At most 5 centres in flight per page load (`mapWithConcurrency`).
- Sev: Low. A cheap DB-pool amplification by any account, which grows with the number of centres.
- Area: availability.
- Evidence: `(student)/student/discover/page.tsx:80-110`. `center.findMany` has no `take`, then `Promise.all` runs `discoverClassesForCenter` (`take: 200`) plus `teacherDisplayNames` for each centre, and the result is sliced at `:174`.
- Exploit: refreshing Discover holds pool connections for everyone.
- Fix: bounded concurrency (batches of 5), cache the centre list, rate-limit.
- Behaviour: no.
- Gate: the loader issues ≤ K concurrent queries for N=50 centres.
- Repro: none.

**SEC-33 — Supabase auth cookies (including the refresh token) are JS-readable and have no Secure flag.**
- Sev: Low. Hardening; any XSS would become theft of a 400-day refresh token.
- Area: cookies.
- Evidence: `lib/supabase/server.ts:16` and `lib/supabase/proxy.ts:18` pass no `cookieOptions`, so the @supabase/ssr defaults apply (`httpOnly:false`, no `secure`, 400 days). The browser client `lib/supabase/client.ts` has no importers, so nothing needs JS access.
- Exploit: XSS reads `document.cookie` and replays the refresh token offline.
- Fix: `cookieOptions: { httpOnly: true, secure: prod, sameSite: "lax", path: "/" }` on both clients; delete `lib/supabase/client.ts`.
- Behaviour: no.
- Gate: a static check that both calls pass `httpOnly: true`.
- Repro: none.

**SEC-34 — `next@16.3.4` has 7 advisories, none reachable today.**
- Sev: Low. Upgrade hygiene.
- Area: dependencies.
- Evidence:
  - GHSA-vcvr-r3jv-pc5j (Critical, `next/og`): not used.
  - GHSA-cjq9-62q9-8jv4 (High, image-optimizer SSRF): no `images.remotePatterns`.
  - Five Moderate/Low: their preconditions (catch-all routes, Pages Router, `use cache`, metadata image routes, dev MCP) are absent.
- Exploit: none today. One becomes live as soon as someone adds `remotePatterns` or an OG image.
- Fix: bump `next` and `eslint-config-next` to ≥16.3.8.
- Behaviour: no.
- Gate: installed `next` ≥ 16.3.8.
- Repro: none.

**SEC-35 — `shadcn` and `prisma` CLIs are production dependencies (21 audit hits, 2 critical); CI has no audit step.**
- Sev: Low. None of these packages is imported at runtime, but the noise hides a real advisory.
- Area: dependencies.
- Evidence:
  - `package.json` dependencies. `npm audit --omit=dev`: proxy-addr, hono, undici, fast-uri and others, all via `shadcn`; deepmerge-ts via `prisma`.
  - The only runtime touch is the CSS `@import "shadcn/tailwind.css"`.
  - `.github/workflows/ci.yml` has no audit step.
- Exploit: none directly.
- Fix: move `shadcn` (and `prisma`, if the build allows) to devDependencies, and add `npm audit --omit=dev --audit-level=high` to CI. Do **not** accept npm's suggested `prisma@6.12.0` downgrade.
- Behaviour: no.
- Gate: `npm audit --omit=dev` reports 0 critical and 0 high.
- Repro: none.

**SEC-36 — The historical default seed password (in git history) still works on 13 legacy dev auth accounts.**
- Status (SEC-2c): **DEFERRED to M20** — deleting the auth users is the person's action.
- Sev: Low. None of the 13 is linked to an app `User`, so a login gets no more than open sign-up. But combined with SEC-01, any future `User` created with one of those emails would be claimable.
- Area: secrets.
- Evidence:
  - The password was committed in `.env.example` at d557870 and was the `prisma/seed.ts` default from 3b61378 to ea5f645. It was removed at 977f9cf.
  - A count-only in-DB bcrypt compare found 13 of 37 `auth.users` still accept it.
  - The value is deliberately not reproduced here.
- Exploit: anyone with repo history signs in as those accounts.
- Fix: delete or rotate those 13 auth users, and treat the old password as burned.
- Behaviour: no.
- Gate: the count-only compare returns 0.
- Repro: none (it needs the secret as input).

**SEC-37 — No `server-only` guard on the service-role client, Prisma or the data layer.**
- Sev: Low. Nothing leaks today: an import-closure scan of all 125 client modules found 0 reaches. But nothing stops a future import.
- Area: secrets.
- Evidence: `grep server-only` finds only `lib/ui/sidebar-cookie.ts`. `lib/supabase/admin.ts`, `lib/db/client.ts`, `lib/db/storage.ts` and `lib/auth/*` have no guard.
- Exploit: a future `"use client"` import bundles server code.
- Fix: add `import "server-only"` to those files (the package install is a user decision). Gate scripts must keep importing only pure modules.
- Behaviour: no.
- Gate: a static check that each listed file starts with the guard.
- Repro: none.

**SEC-38 — All 23 seed accounts, including the platform admin, share one `SEED_PASSWORD`.**
- Sev: Low (dev data). It is already an unticked §2.1 item.
- Area: secrets.
- Evidence: `prisma/seed-data/auth.ts:112`. The count-only check shows 23/23 match, including 1 platform admin.
- Exploit: a tester given a demo student login knows the admin password.
- Fix: a separate `SEED_ADMIN_PASSWORD`; never point a shared preview deployment at the seeded project.
- Behaviour: **NEEDS-DECISION (D-21)**:
  - (a) a separate admin secret;
  - (b) per-account random passwords;
  - (c) accept it for dev.
- Gate: `seed:preflight` fails when the admin password equals `SEED_PASSWORD`.
- Repro: none.

**SEC-39 — `npm run db:migrate` runs `prisma migrate dev` against the `.env` (shared dev) URL.**
- Sev: Low (operational). `migrate dev` uses a shadow database and offers a **reset** when it detects drift, which is exactly what CLAUDE.md rule 7 forbids.
- Area: config.
- Evidence: `package.json:11`.
- Exploit: an accidental reset of the shared DB.
- Fix: remove the script or point it at a local-only URL; document `migrate deploy` as the only path to the dev DB.
- Behaviour: no.
- Gate: no package script runs `migrate dev`, `reset` or `db push` without a local-URL guard.
- Repro: none.

**SEC-40 — The public register form tells anyone whether a phone or email belongs to an account.**
- Sev: Low. It confirms existence without revealing data. It runs before the Supabase call and has no limit.
- Area: enumeration.
- Evidence: `(auth)/actions.ts:107-111` returns `phoneInUse` and `:131-133` returns `emailInUse`. Many of those phones belong to reception-created minors. Sign-in itself returns a uniform error.
- Exploit: an anonymous user scripts phone lists to find targets for SEC-02 and SEC-03.
- Fix: a generic response, handle the clash after verification, and an IP rate limit.
- Behaviour: the message wording changes, so it is part of **D-02**.
- Gate: a taken phone and a free phone produce indistinguishable states.
- Repro: none.

**SEC-41 — `syncUserFromAuth` trusts raw `user_metadata`; `signUpAction` overwrites a linked user's global fields.**
- Sev: Low. It breaks rule 10 (one phone normalizer) and enables SEC-02 without the app's form.
- Area: AuthN input.
- Evidence:
  - `lib/auth/session.ts:65-70` stores the raw phone with no `normalizePhone`. `:17-31` takes names with no length cap.
  - `(auth)/actions.ts:142-145` overwrites a pre-existing (linked) `User`'s name and phone, and nulls the phone when the field is blank.
- Exploit: direct GoTrue sign-up stores an un-normalised phone or a 10k-character name.
- Fix: zod-validate the metadata and normalise it, or drop the phone (SEC-02); don't overwrite linked rows.
- Behaviour: no.
- Gate: metadata phone `+20 10 1234 5678` is stored as `+201012345678` (E.164 since U4; `01012345678` before) or null.
- Repro: none.

**SEC-42 — Invitation acceptance is check-then-act; invitations outlive the inviter's authority; revoke is gated more loosely than create.**
- Sev: Low. Narrow races and a stale-authority window, all audited.
- Area: invitations.
- Evidence:
  - `(auth)/actions.ts:238-258` checks status and expiry outside the transaction, and `:290-293` updates unconditionally.
  - Nothing revokes a demoted owner's pending invitations.
  - Create needs `membership.role.assign`, but revoke needs only `staff.invite` (`settings/staff/actions.ts:47,97`).
- Exploit: a revoke that lands mid-accept is overwritten. A departing owner mints a 7-day OWNER invitation (visible in the pending list).
- Fix: `updateMany where status PENDING and not expired` inside the transaction; revoke a user's invitations when they lose OWNER; gate revoke on `membership.role.assign`.
- Behaviour: the revoke-gate change is **NEEDS-DECISION (D-22)**:
  - (a) OWNER-only revoke;
  - (b) keep it and document it.
- Gate: an invitation flipped to REVOKED after the pre-checks creates no membership.
- Repro: none.

**SEC-43 — `safeNextPath` accepts backslash paths.**
- Sev: Low. Safe only because `localePrefix: "always"` turns `/\evil.com` into `/en/\evil.com`.
- Area: redirects.
- Evidence: `lib/routes.ts:87-91`.
- Exploit: none today. It becomes an open redirect if the locale prefix becomes `as-needed`.
- Fix: also reject `\` and control characters, or parse with `new URL` and compare the origin.
- Behaviour: no.
- Gate: `safeNextPath("/\\evil.com") === null`.
- Repro: none.

**SEC-44 — Teacher pages and actions don't require the TEACHER role.**
- Sev: Low. It needs an ex-teacher who still holds another relation at the centre, and is limited to their own former classes.
- Area: AuthZ.
- Evidence: `(teacher)/layout.tsx:34-50` (`requireTeacherUser` accepts TEACHER anywhere). `teacher/sessions/actions.ts:36,65` and `teacher/students/actions.ts:36,59,102` have no role check, and ownership is keyed on the historical `teacherId`.
- Exploit: a deactivated teacher who is still a student or receptionist at the centre keeps blocking students and editing descriptions.
- Fix: the same guard as SEC-09, requiring an active TEACHER membership at `ctx.center`.
- Behaviour: no.
- Gate: with an inactive TEACHER and an active RECEPTIONIST membership, `updateSessionDescriptionAction` returns `forbidden`.
- Repro: none.

**SEC-45 — OWNER's ordinary permissions live only in grant rows that no UI can repair.**
- Sev: Low. Not exploitable today (0/5 centres have gaps); a latent lock-out.
- Area: AuthZ.
- Evidence: `can()` forces only the four owner-only actions (`lib/auth/permissions.ts:150-152`). `MATRIX_ROLES` excludes OWNER (`:213-218`), and only `provisionCenterBaseline` or migrations write OWNER rows.
- Exploit: a new permission shipped without a backfill locks every OWNER out of it.
- Fix: treat OWNER as allow-all for every non-platform permission, or gate that OWNER holds every baseline action.
- Behaviour: no.
- Gate: delete one OWNER grant on a fixture, and `can("OWNER", …)` is still true.
- Repro: none.

**SEC-46 — A period settlement accepts any `teacherId`.**
- Sev: Low. It writes a junk 0-total row, and a nonexistent id 500s, which reveals whether a `User` id exists.
- Area: IDOR.
- Evidence: `(center)/settlements/actions.ts:91-98` passes it into `lib/db/settlements.ts:178-233` with no TEACHER-membership check.
- Exploit: noise and integrity problems; holds overlap slots for a foreign id.
- Fix: `scoped(ctx).teachers.findByUserId(teacherId)` first.
- Behaviour: no.
- Gate: a non-teacher id returns `notFound`, and no row is created.
- Repro: none.

**SEC-47 — The student detail page shows how many relations the person holds at other tenants.**
- Sev: Low. Cross-tenant metadata.
- Area: existence leak.
- Evidence: `(center)/students/[id]/page.tsx:76,359` → `lib/db/identity.ts:108-117`. It counts every `membership`/`studentProfile` with `NOT: { centerId }`, with no organisation or active filter.
- Exploit: staff learn that a student studies or works at a competitor.
- Fix: same-organisation only, or drop the field.
- Behaviour: **NEEDS-DECISION (D-23)**:
  - (a) same organisation only;
  - (b) remove it.
- Gate: a profile at an unrelated organisation counts 0.
- Repro: none.

**SEC-48 — The "Whole Management" roll-up applies the representative branch's visibility window and grants to every branch.**
- Sev: Low.
- Area: org widening.
- Evidence: `(center)/analytics/page.tsx:65,83-86,113-133`.
- Exploit: an owner sees branch B's totals beyond B's stricter window.
- Fix: clamp each branch with its own settings, and require the permission at each branch summed.
- Behaviour: no.
- Gate: the roll-up equals the sum of each branch's own clamped figure.
- Repro: none.

**SEC-49 — Student profile completion accepts any catalog grade, not just one the centre selected.**
- Status (SEC-2c): **FIXED.** Resolved through `centerGradeById`; the form offers the centre's grades only.
- Sev: Low (integrity).
- Area: validation.
- Evidence: `(student)/student/profile/actions.ts:58-66` uses `prisma.catalogGrade.findUnique`, while the centre side uses selection-bound `scoped.grades.findById`.
- Exploit: a student sets an unoffered grade.
- Fix: resolve through `centerGradeById`.
- Behaviour: no.
- Gate: an unselected grade returns `fieldErrors.gradeId`.
- Repro: none.

**SEC-50 — Some dates pass validation but become Invalid Date, causing 500s and an un-approvable request.**
- Status (SEC-2b): **FIXED.** Every typed date is the strict `dateOnlyField`/`dateKeyField` (reschedule, holiday, settlement period, expense, teacher session request); a stored request with an impossible date is refused on approval (`invalidDate`), never thrown.
- Sev: Low.
- Area: validation.
- Evidence:
  - `Date.parse` plus `slice(0,10)` in `lib/validation/sessions.ts` (`sessionDate`), `classes.ts` (`holidayDate`) and `settlements.ts` (`isoDate`). Probe: "March 5 2026" becomes "March 5 20".
  - The teacher `sessionRequestSchema` stores the raw slice, so `lib/db/approvals.ts:149` throws on every approve.
  - The expense date `2026-01-01T10:00` becomes an Invalid Date at `expenses/actions.ts:160`.
- Exploit: a teacher posts a malformed date directly, and every Approve 500s.
- Fix: use strict `dateOnlyField` (`lib/validation/class-period.ts:16`) everywhere.
- Behaviour: no.
- Gate: those schemas refuse "March 5 2026", "2026-02-30" and "2026-01-01T10:00".
- Repro: none.

**SEC-51 — Backdating: reschedule and NEW_SESSION approval accept past dates; expenses accept any date and are hard-deleted.**
- Status (SEC-2b): **FIXED.** Reschedule and NEW_SESSION approval refuse a past date (`pastDate`); D-24: an expense may be backdated within the visibility window only, never into the future; expenses are voided with a reason (who, when), never deleted; category changes are audited.
- Sev: Low. Insider actions, audited.
- Area: validation / fraud.
- Evidence:
  - The create paths refuse past dates (`lib/db/class-sessions.ts:1520,1607`). `rescheduleSession` (`lib/db/sessions.ts:247-330`) and `resolveSessionRequest` (`approvals.ts:149`) don't.
  - Expense `date` is unbounded (`expenses/actions.ts:161`).
  - Deleting an expense is a hard `deleteMany` (`lib/db/scoped.ts:955`).
  - Expense category create, update and toggle are not audited.
- Exploit: rescheduling into the past marks every enrolled student ABSENT on a backdated session. An expense backdated into a closed month changes its profit, or an owner's expense is deleted (audited, but unreadable: SEC-07).
- Fix: refuse past dates on reschedule and approval; bound expense dates; soft-delete expenses (void with a reason); audit category changes.
- Behaviour: **NEEDS-DECISION (D-24)**:
  - (a) whether a late-entered, backdated expense is legitimate;
  - (b) whether expenses should be void-style rather than deletable.
- Gate: reschedule to yesterday returns `pastDate`; an expense delete leaves a voided row.
- Repro: none.

**SEC-52 — Raw-argument actions skip zod; type confusion; unbounded search strings.**
- Status (SEC-2c): **FIXED.** `parseActionArgs` + zod tuples on all 12; relational teacher filter.
- Sev: Low. Limited to the caller's own centre, because `scopedWhere` appends `centerId` last.
- Area: validation.
- Evidence:
  - `reception/actions.ts:91,194,224`, the bound ids in `sessions/actions.ts:108`, `classes/actions.ts:152` and `teachers/actions.ts:104`, and the type-ahead actions in `students`/`teachers`/`teacher/*`.
  - A `{"not":""}` object as `sessionId` reaches `where:{id, centerId}` (`lib/db/reception.ts:199`).
  - No max length, so each of up to 5 tokens fans out into about 10 ILIKEs.
  - `teacherStudentProfileIds` (`lib/db/teacher-portal.ts:184-198`) loads all-history ids on every keystroke.
- Exploit: expensive scans; resolving a session in the caller's own centre that they didn't pick.
- Fix: `z.tuple([recordId, z.string().trim().max(80)])` on each; use a relational filter instead of the id preload.
- Behaviour: no.
- Gate: `searchStudentsTypeAheadAction({})` returns `[]` without throwing; a 10k-character query never hits the DB.
- Repro: none.

**SEC-53 — The server fetches `Center.logoUrl`, an unvalidated URL (SSRF / unbounded download, no timeout).**
- Sev: Low. Only a platform admin can set it.
- Area: SSRF.
- Evidence:
  - `lib/validation/admin.ts:53` (`optionalText(500)`).
  - `lib/db/storage.ts:109-121` calls `fetch(url)` with no allowlist, no timeout and redirects followed, and reads the whole body before checking size. It runs on every card render (`lib/db/id-cards.ts:38-40`).
  - The value is also rendered as a raw `<img src>` to every viewer (a tracking pixel).
- Exploit: a compromised admin points it at an internal or slow host.
- Fix: an `https:` URL on an allowlisted host, `AbortSignal.timeout`, `redirect:"error"`, and a streamed size cap.
- Behaviour: **NEEDS-DECISION (D-25)**:
  - (a) Supabase-host URLs only;
  - (b) move logos into the `logos` bucket and sign them like avatars;
  - (c) keep free URLs, with limits only.
- Gate: `createCenterSchema` refuses `http://169.254.169.254/x`; an oversized response aborts without buffering.
- Repro: none.

**SEC-54 — The photo MIME type is trusted from the client's `File.type`, with no magic-byte check.**
- Sev: Low. Not rendered as HTML anywhere found.
- Area: files.
- Evidence: `lib/db/storage.ts:35,51`. A live probe uploaded an HTML body declared as `image/png`; it was accepted and served as `image/png` with no nosniff.
- Exploit: a staff member stores arbitrary bytes as a "photo".
- Fix: sniff the PNG, JPEG and WebP signatures and derive the content type from them.
- Behaviour: no.
- Gate: HTML bytes declared `image/png` return `photoType`.
- Repro: none.

**SEC-55 — The Storage RLS backstop is absent on the live project and can't be rebuilt from the repo.**
- Sev: Low. It fails closed: RLS is on with 0 policies, which means deny.
- Area: storage.
- Evidence: the live `storage` schema has 0 policies and the `public.kayedu_*` helpers are missing. The repo SQL has no `avatars`/`id-cards` policies (`supabase/m10-rls-and-storage.sql:168-205`), contrary to `docs/02` §10.
- Exploit: none today. The risk is a future permissive "fix" made with no reference to the intended policy.
- Fix: decide D-19. Under (a), document that Storage is service-role-only and deny-all.
- Behaviour: no.
- Gate: `check:rls` asserts every bucket has `public=false` and the expected policy state.
- Repro: none.

**SEC-56 — Docs describe RLS and storage protections that don't exist.**
- Sev: Low. Docs drift on a security control (working rule 3).
- Area: docs.
- Evidence: §9 lists them (`docs/02` §10, `docs/00` §2.1-B lines 69 and 71, `docs/01:58,130`).
- Exploit: misleads the M20 reviewer.
- Fix: rewrite the passages to the actual state when the SEC-10 / SEC-30 fix lands.
- Behaviour: no.
- Gate: n/a (`check:rls` makes the real state assertable).
- Repro: none.

**SEC-57 — Prisma connects as `postgres` with BYPASSRLS and broad role memberships.**
- Sev: Low. RLS can never back up the app's own connection, and the "non-superuser" checklist item gives false comfort.
- Area: DB role.
- Evidence: live, `postgres` has `rolsuper=false` and `rolbypassrls=true`, and is a member of `service_role`, `authenticator` and `pg_read_all_data`. `docs/00:68` and `docs/02:326-328` imply otherwise.
- Exploit: n/a directly.
- Fix: correct the docs; a dedicated non-BYPASSRLS `kayedu_app` role could go to the Phase-2 backlog.
- Behaviour: no.
- Gate: the docs are updated; `check:rls` prints `rolbypassrls`.
- Repro: none.

**SEC-58 — One-off sessions can be priced at 0.**
- Status (SEC-2b): **FIXED.** D-26 (b): a 0-priced one-time session needs an explicit "I understand this session is free" (`zeroPriceNeedsConfirmation`); the session header and its receipt are flagged; the `session.create` audit row says `zeroPrice`.
- Sev: Low. Audited and visible.
- Area: pricing.
- Evidence: `newOneOffSessionSchema` accepts a price ≥ 0 via `parseEgpToPiastres`, and `recordPayment` uses `priceSnapshot` (`lib/db/payments.ts:146`).
- Exploit: a manager runs a 0-priced session while charging cash.
- Fix: a minimum price or a warning, and surface zero-price sessions in analytics.
- Behaviour: **NEEDS-DECISION (D-26)**:
  - (a) refuse 0;
  - (b) warn and flag.
- Gate: a 0-price one-off is refused or flagged.
- Repro: none.

**SEC-59 — Students can rate sessions they missed, outside the 7-day window; `skipSessionRating` is unchecked.**
- Status (SEC-2b): **FIXED.** A rating needs a PRESENT/LATE attendance inside the 7-day window, by direct call; a skip for a session the student did not attend writes nothing.
- Sev: Low. Rating manipulation.
- Area: ratings.
- Evidence:
  - `lib/db/ratings.ts:145-178` accepts any attendee row, including ABSENT rows materialised at close, with no date window (the window is applied only in the list at `:95-103`).
  - `skipSessionRating` (`:184-195`) writes for any `sessionId`; an FK error 500s, which reveals whether a session id exists.
- Exploit: a disgruntled no-show posts 1-star ratings for past sessions.
- Fix: require PRESENT/LATE and the 7-day window; validate the session in `skipSessionRating`.
- Behaviour: no.
- Gate: rating an ABSENT or 8-day-old session returns `notAttended`.
- Repro: none.

**SEC-60 — AuditLog is append-only by convention only; money audit rows are written after the commit.**
- Status (SEC-2b): **FIXED.** A trigger makes `AuditLog` append-only (no UPDATE but the FKs' own SET NULL, no DELETE outside an opted-in maintenance transaction that only test cleanup uses); every money action writes its audit row on the money transaction, so an audit failure rolls the money back.
- Sev: Low.
- Area: audit.
- Evidence:
  - No app code updates or deletes AuditLog (grep: scripts only), but no trigger enforces it.
  - The FKs are `ON DELETE SET NULL` (`prisma/migrations/20260901022343_init/migration.sql:665,668`).
  - `recordPaymentAction`, `voidPaymentAction`, `refundPaymentAction`, the reception check-in payment and every settlement action call `writeAuditLog` after `$transaction` commits (`(center)/sessions/actions.ts:520,557,602`; `reception/actions.ts:329`; `settlements/actions.ts:63,102,137,168`). `changeAttendanceStatus` audits inside its transaction.
- Exploit: under load, a void can commit with no audit row.
- Fix: write audit rows through `tx`, and add a BEFORE UPDATE/DELETE trigger on `AuditLog` that raises.
- Behaviour: no.
- Gate: `UPDATE "AuditLog"` raises; a forced audit failure rolls the payment back.
- Repro: none.

**SEC-61 — Prisma `contains` doesn't escape `%`/`_`, and insensitive `equals` compiles to `ILIKE`.**
- Status (SEC-2c): **FIXED.** Search tokens drop the pattern characters; duplicate checks compare names by the one name key, never by `ILIKE`.
- Sev: Low. Always within the centre; mostly functional.
- Area: injection (LIKE).
- Evidence:
  - `lib/db/students.ts:116,148` and `lib/db/teacher-portal.ts:152`.
  - The duplicate-name checks at `lib/db/payment-methods.ts:103-108`, `lib/db/terms.ts:56`, `expenses/actions.ts:45` and `settings/actions.ts:332,355`.
  - Probe: `contains('%')` matched 111/111 rows, and the emitted SQL is `"name" ILIKE $1`.
- Exploit: `%` lists the caller's own roster (no gain). Names with `_` are falsely rejected as duplicates.
- Fix: escape `\ % _` in search tokens, and compare duplicates on a normalised `lower(trim(name))` or a unique index.
- Behaviour: no.
- Gate: `Cash_` can be created when only `Cash1` exists.
- Repro: none.

**SEC-62 — The data-visibility window is enforced per page, not in the scoped helpers (CLAUDE.md rule 9).**
- Status (SEC-2b): **OPEN (writes covered).** Money writes on an old session are refused by the closure rules (every session older than its day is closed, cancelled ones included since D-07), asserted under SEC-08. The read side — moving the window floor into the scoped session/attendee/payment helpers instead of each page — is a separate refactor not taken here.
- Status (SEC-2c): **OPEN, needs a decision** — what it would take and three options are in §1.2.
- Status (SYS): **FIXED** — option (a), the user's decision: the floor is in `lib/db/scoped.ts` beside `centerId`; `scopedIgnoringVisibilityWindow(ctx, reason)` is the one opt-out; asserted by `check:visibility` for every centre-side role.
- Sev: Low.
- Area: visibility window.
- Evidence:
  - Only `refunds.list` applies `visibilityFloor` inside `lib/db/scoped.ts:63-69`.
  - Sessions, analytics, expenses and session detail and print clamp at the page level (`(center)/sessions/[id]/page.tsx:87-91`).
  - Student detail (absence streaks) and teacher-portal history have no window.
  - Money **write** actions don't check the window (see SEC-08).
- Exploit: a direct action call operates on data older than the window.
- Fix: move the floor into the scoped session, attendee and payment reads and writes.
- Behaviour: no.
- Gate: a scoped read or write of a session older than the floor returns null or refuses for a non-admin context.
- Repro: none.

**SEC-63 — `lockAttendeeRow`'s raw SQL has no `centerId` predicate.**
- Sev: Low. Defence in depth (tenant rule 1); both callers pre-scope.
- Area: tenant isolation.
- Evidence: `lib/db/session-lifecycle.ts:292-296`. The callers are `payments.ts:110,130` (after `loadGateSessionForAttendee` with `centerId`) and `attendance.ts:241-256`.
- Exploit: none today.
- Fix: add a `centerId` parameter and predicate (do it together with the SEC-05 rewrite).
- Behaviour: no.
- Gate: `lockAttendeeRow(tx, otherCentreAttendee, myCentre)` returns null.
- Repro: none.

### 3.5 Info

Info items have no behaviour change and no gate unless one is stated.

- **SEC-64:** the photo size limit can't be reached.
  - Next's default 1 MB Server Action body limit (`next.config.ts` sets no `serverActions.bodySizeLimit`) sits below `MAX_PHOTO_BYTES` = 5 MB (`lib/storage-paths.ts:102`).
  - A 1–5 MB phone photo fails with a generic error instead of `photoTooLarge`.
  - **NEEDS-DECISION (D-27):**
    - (a) raise the body limit to 5 MB;
    - (b) cap photos at about 1 MB and resize client-side.
- **SEC-65:** photo upload and removal write no AuditLog row and have no rate limit (`(center)/students/actions.ts:534-595`).
  - A receptionist could swap a photo to defeat the reception photo comparison, then restore it, untraced.
  - **NEEDS-DECISION (D-28):** should photo changes join the audited actions in CLAUDE.md rule 7?
- **SEC-66:** there is no password-reset flow and no auth confirm/callback route. **(SEC-2c: DEFERRED to M20 — the confirm route exists since SEC-2a; reset needs email delivery.)**
  - With confirmation turned on (SEC-01), the confirmation link has nowhere to land.
  - Add `/[locale]/auth/confirm` plus forgot/reset pages in M20.
- **SEC-67:** the `lib/rate-limit.ts` map never evicts keys (`:19-31`).
  - Negligible while keys are user ids; it leaks memory if keyed by IP.
  - Superseded by the shared-store fix (SEC-11).
- **SEC-68:** the `X-Powered-By: Next.js` header is on. Set `poweredByHeader: false`.
- **SEC-69:** the Vercel region (fra1, which matters for minors' data residency) and the platform headers are dashboard-only, with no `vercel.json`. Add `"regions": ["fra1"]`.
- **SEC-70:** the wipe and seed guards compare two values from the same `.env` (`scripts/wipe-dev-data.ts:56-104`, `prisma/seed.ts:133-146`).
  - A `.env` copied onto production would pass them.
  - Add a production denylist ref, or a marker row the wipe requires.
- **SEC-71:** `resolveCardLayout` passes `background` through unsanitised (`lib/id-card.ts:134-137`). **(SEC-2c: FIXED — normalised like `accent`.)**
  - The renderer re-checks it (`:452-454`), so it is not exploitable today.
  - Normalise it like `accent`.
- **SEC-72:** the approvals loaders `include: { student: true }` (`lib/db/scoped.ts:1027,1050`), which loads whole `User` rows (`authId`, `isPlatformAdmin`, phone) into server components.
  - Safe today: they reach only server components (`RequestCard`), and the RSC-payload sweep found no client component receiving a whole row.
  - It is one refactor away from a leak. Use a `select` of the name fields.
- **SEC-73:** some pages and their actions check different permissions. This is inconsistent but not an escalation **(SEC-2c: OPEN — permission semantics, options in §1.1)**:
  - `/settings/staff` requires `staff.invite`, while its actions require `membership.role.assign`, `staff.invite`, `staff.manage` and `membership.branch.grant`.
  - The block actions on `/teachers/[id]` use `student.block`, while class blocks use `class.manage`.
  - The Add-teacher dialog (`teacher.manage`) can give an existing staff member a TEACHER role.
- **SEC-74:** small parsing gaps:
  - **Status (SEC-2b): FIXED.** Auth half at SEC-2a; money half now: `parseEgpToPiastres` accepts plain decimal EGP only (no `1e3`, `0x10`, `0.001`), folds Arabic-Indic digits, and the client previews use it; the general-settings audit row includes `teacherEditDeadlineHours`.
  - `parseEgpToPiastres` accepts `1e3`, `0x10` and `0.001` (giving 0); it stays bounded and integer.
  - The client previews re-implement EGP→piastres with `Math.round(x*100)`; display only.
  - `signInSchema.password` and `next` have no max length.
  - `saveGeneralSettingsAction`'s audit row omits `teacherEditDeadlineHours`.
- **SEC-75:** Prisma logs errors in production (`lib/db/client.ts:10-13`). **(SEC-2c: logging half FIXED — `errorFormat: "minimal"` in production; `global-error.tsx` DEFERRED to M20 with Sentry.)**
  - These are constraint and field names, not secrets.
  - There is no `global-error.tsx`, so root-layout errors fall back to Next's generic page.

---
## 4. Repro scripts

Everything lives in `scripts/security-repro/`. Run each script with `node --env-file-if-exists=.env scripts/security-repro/<file>.ts`. **The scripts are not wired into CI.**

How each script behaves:
- It creates its own throwaway organisation, centre and users (slug prefix `secrepro-`, emails `@kayedu.test`).
- It pre-cleans and cleans up in `finally`. It never touches seed data, never creates Supabase Auth users, and runs nothing destructive (rule 7).
- It prints `REPRODUCED` or `NOT REPRODUCED` as its last line.
- Where the vulnerable module can't be loaded outside Next (it imports `@/`, `next/*` or `react`), the script imports the pure `lib/db` functions it calls and replicates the action's query shape. The header comment says which, with line references.
- `_fixtures.ts` is a shared helper for SEC-05/06-race/12/13.

Last run: 2026-10-14, against the shared dev project. A count afterwards found 0 leftover `secrepro` centres, users or organisations.

**SEC-2a:** `SEC-01`, `SEC-02`, `SEC-02-teacher`, `SEC-03`, `SEC-03-squat`, `SEC-04`, `SEC-09`, `SEC-10` and `SEC-11` were pointed at the fixed code, printed **NOT REPRODUCED**, were ported into `npm run check:security` as assertions `SEC-01/02/03/04/09/10/11`, and were then deleted.

**SEC-2b:** the remaining eight — `SEC-05`, `SEC-05-mechanism`, `SEC-06`, `SEC-06-race`, `SEC-07`, `SEC-08`, `SEC-12`, `SEC-13` (and `_fixtures`) — were run against the fixed code on 2026-10-14 and all printed **NOT REPRODUCED**: SEC-05 0/6 doubled (`alreadyPaid` on every race, one active row); SEC-05-mechanism's after-lock read saw the payment; SEC-06 one teacher share paid once in both orders; SEC-06-race one `ok` + `overlappingSettlement`/`sessionAlreadySettled` and one approve/pay out of two; SEC-07 the receipt renders the paid count and an audit-log reader exists; SEC-08 the paid cancel refused and the late void `sessionClosed`; SEC-12 one of void ∥ refund wins, never both flags; SEC-13 2 ACTIVE on a cap-2 class. The only edits before the run were call signatures (approve/pay take the actor; audit cleanup goes through the maintenance helper, the log being append-only now). They are ported into `check:security` as `SEC-05/06/07/08/12/13` — the concurrency ones with real parallel transactions on two clients — and the directory `scripts/security-repro/` is gone.

| Script | Finding | Result | Key output |
|---|---|---|---|
| `SEC-01.ts` | SEC-01 | REPRODUCED | live `mailer_autoconfirm=true`; victim `authId` null before; the attacker now resolves the victim's StudentProfile |
| `SEC-02.ts` | SEC-02 (student) | REPRODUCED | `resolveContact` matches the attacker; local name seeded "Mariam Hassan (attacker-chosen)"; the real owner gets `phoneInUse` |
| `SEC-02-teacher.ts` | SEC-02 (teacher) | REPRODUCED | first submit returns `matchFound`, second returns `linked`; centre X's TEACHER membership belongs to the attacker |
| `SEC-03.ts` | SEC-03 | REPRODUCED | 0 children before verify; 1 child after one staff click; staff saw `matchedPhone == parentPhoneOnFile` |
| `SEC-03-squat.ts` | SEC-03 | REPRODUCED | links at 2 unrelated centres; the real parent's sign-up gets `phoneInUse` |
| `SEC-04.ts` | SEC-04 | REPRODUCED | after the phone change and deactivation, the old parent still reads the upcoming session at 16:00–18:00 |
| `SEC-05.ts` | SEC-05 | REPRODUCED | `attendees=6 activePayments=12`; 6/6 attendees doubled |
| `SEC-05-mechanism.ts` | SEC-05 | REPRODUCED | `{"waitedMs":1478,"hasActivePaymentFromLockQuery":false,"freshCountAfterLock":1}` |
| `SEC-06.ts` | SEC-06 | REPRODUCED | one 8000-piastre share paid out as 16000, in both orders |
| `SEC-06-race.ts` | SEC-06 | REPRODUCED | period ×2 and session ×2 each claim 48000 against a 24000 ledger; approve/pay ×2 both `ok` |
| `SEC-07.ts` | SEC-07 | REPRODUCED | receipt doesn't render a paid count; 0 app files read voided payments; the only AuditLog reader is the admin page |
| `SEC-08.ts` | SEC-08 | REPRODUCED | a 2026-03-10 payment voided on 2026-10-14; the period settlement total is 0 |
| `SEC-09.ts` | SEC-09 | REPRODUCED | TEACHER-only role in a centre action; roster returned; another teacher's block created; a staff CLASS block removed |
| `SEC-10.ts` | SEC-10 | **NOT REPRODUCED** (expected on dev) | every table returns 401/42501. Rerun it against every freshly provisioned project: the finding is the repo gap |
| `SEC-11.ts` | SEC-11 | REPRODUCED | 40 of 50 calls allowed across 2 instances; 3 paths unthrottled; a centre-B-only phone resolved to the name 100/100 times |
| `SEC-12.ts` | SEC-12 (Medium) | REPRODUCED | `voided=true refunded=true revenueContribution=-10000`; double void succeeds; double refund throws P2002 |
| `SEC-13.ts` | SEC-13 (Medium) | REPRODUCED | cap 2, 6 ACTIVE enrolments |

SEC-10 is the only Critical/High that a script cannot show live. The dev project is hand-locked, and proving the gap would mean provisioning a fresh project. The evidence is the repo grep (no RLS, GRANT or REVOKE in any migration) plus the live default-ACL rows Supabase keeps for its other schemas (§8).

---

## 5. Prioritized fix plan

Fixes should land as their own milestone(s) after this report. Each item names the gate that proves it. A reasonable approach is to promote the SEC repros into a `check:security` gate, inverted so they assert NOT REPRODUCED.

**Phase 0: operations (no code, do it now).**
1. Turn on *Confirm email* in Supabase on dev, and later on every project (half of SEC-01).
2. Delete or rotate the 13 legacy auth accounts that still accept the historical password (SEC-36).
3. Stop using `npm run db:migrate` against `.env` (SEC-39).
4. Don't provision any new Supabase project, including production and CI, until SEC-10's lockdown migration exists.

**Phase 1: Critical/High fixes that need no product decision (before any pilot data).**

| Order | Fix | Closes | Gate |
|---|---|---|---|
| 1 | `syncUserFromAuth` refuses to link or sync an unconfirmed email; add the auth confirm route | SEC-01 (option a), SEC-66 | SEC-01 gate |
| 2 | Lockdown migration (RLS on all tables, REVOKE on schema/tables/default privileges) plus a live `check:rls` | SEC-10, SEC-30, SEC-55 (assumes D-19 (a)) | `check:rls` on a fresh project |
| 3 | Partial unique index on active payments, plus a fresh-statement re-check after `lockAttendeeRow` (and add `centerId` to it) | SEC-05, SEC-63 | SEC-05 gate |
| 4 | Per-(centre, teacher) settlement lock, partial unique index and exclusion constraint, conditional transitions | SEC-06 (race part) | SEC-06-race gate |
| 5 | Lock the Payment row in void/refund, add a CHECK constraint, map P2002 | SEC-12 | SEC-12 gate |
| 6 | Action-level experience guard on every `(center)` and `(teacher)` action; `roleForExperience` denies instead of falling back | SEC-09, SEC-44 | static sweep plus SEC-09 gate |
| 7 | Shared-store rate limiter applied to every `resolveContact` path | SEC-11 (option a), SEC-67 | SEC-11 gate |
| 8 | `verifiedChildLinks` re-checks phone, active profile and lifecycle (read side only; the revoke UX is in D-04) | SEC-04 (partial), SEC-16 (parent read, if D-10 (a)) | SEC-04 gate |
| 9 | Audit rows written inside the money transaction, plus a no-UPDATE/DELETE trigger on AuditLog | SEC-60 | trigger and rollback gate |

**Phase 2: decision-gated Highs.** Take these in this order once §6 is answered:
- D-01 (SEC-01 option b/c)
- D-02 (SEC-02, SEC-40)
- D-03 = OD-6 (SEC-03)
- D-05 = OD-8 (SEC-06 cross-shape)
- D-06 (SEC-07)
- D-07 (SEC-08)
- D-04 (SEC-04 revoke UX)
- D-08 (SEC-11 masking)

Until D-03 is decided, strongly consider **disabling the Verify button** (D-03 (d)), because that stand-in is live today.

**Phase 3: Medium.**
- No decision needed: SEC-13, SEC-15, SEC-16 write paths, SEC-19, SEC-25, SEC-28 (headers), SEC-30.
- Decision-gated: SEC-14, SEC-17, SEC-18, SEC-20, SEC-21, SEC-22, SEC-23, SEC-24, SEC-26, SEC-27, SEC-29, SEC-31.

**Phase 4: Low/Info hardening.**
- SEC-33 (httpOnly cookies) and SEC-34 (Next ≥ 16.3.8) are one-line changes; do them early.
- SEC-35, SEC-37, SEC-50, SEC-52, SEC-59, SEC-61 and SEC-62 are mechanical.
- The rest follow their decisions.

**Docs** (§9) are corrected in the same session as each fix (working rule 3).

---

## 6. NEEDS-DECISION register

These are product, money or permission choices. CLAUDE.md says to ask rather than assume on these. **Decided at SEC-2a** (and recorded in `00-master-product-spec.md` §5.1 "Security decisions (SEC-2a)"): D-01 (revised — no auto-link ever; invitation tokens only; staff-approved claims for staff-created people; `REQUIRE_EMAIL_CONFIRMATION` plus a production guard), D-02 (a), D-03 (d) as a stop-gap, D-04 (a), D-08 (b), D-09 (a), D-10 (a), D-11 (a), D-19 (a), D-21 (a), D-22 (a), D-23 (a), D-25 (b), D-27 (b), D-28 (yes). **Decided at SEC-2b** (recorded in §5.1 "Security decisions (SEC-2b)"): D-05 (c) — which closes OD-8 — D-06 (a), D-07 (c) (a refunded payment does not block a cancel), D-12 (creator, not beneficiary; OWNER may, flagged), D-13 (a), D-14 (b), D-15 (c), D-16 (c), D-17 (b), D-20 (audit content only — retention stays with OD-2; platform catalog rows exempt), D-24, D-26 (b). **Decided at SEC-2c** (recorded in §5.1 "Security decisions (SEC-2c)"): D-18 — 30 open reservations and 30 active self-enrolments per account, per-account and per-IP rate limits on reserving and on the teach-here request, no extra verified-account requirement, CAPTCHA kept at M20. **Decided at F3** (recorded in §5.1 "Parent role & portal"): D-03 — the former OD-6 — a one-time code from the student or the branch; D-04 (a) retired with it (no phone-keyed revocation; explicit, audited revocation only). **Still open:** D-20's retention half (= OD-2), in OD-11. They are registered together as **OD-11** in `docs/00-master-product-spec.md` §2.2, which points here. Unless noted, the decider is the Founder/Dev plus the Business partner.

| D# | Finding(s) | Question | Options (★ = auditor's recommendation) |
|---|---|---|---|
| D-01 | SEC-01 | How may a self-registered account claim a staff-created person? | (a) auto-link confirmed emails only (minimum); ★(b) invitation-created rows auto-link, receptionist-created rows need a centre claim code or staff approval; (c) never auto-link, audited admin merge only |
| D-02 | SEC-02, SEC-40 | Can an unverified phone be an identity key? | ★(a) no, until OTP (backlog 12; Twilio already configured); (b) keep it, with an in-person check and a UI warning; (c) accept and record in §5.1. Also: a generic sign-up error instead of `phoneInUse` |
| D-03 | SEC-03 (= **OD-6**, blocked on OD-2) | How does a parent link become VERIFIED? | ★(a) a centre-issued one-time code; (b) OTP to the parent phone; (c) staff approval with the parent in person plus a warning; ★(d) meanwhile, disable origination or the Verify button |
| D-04 | SEC-04 | What happens to a VERIFIED link when the parent phone changes or the student is deactivated? | ★(a) auto-revoke, audited; (b) flag for staff review; plus whether a deactivated child hides the whole parent portal or only the future schedule |
| D-05 | SEC-06 (= **OD-8**) | How do session and period settlements coexist? | (a) a period refuses or excludes already-settled sessions; (b) a session settlement refuses when a period covers it; ★(c) a per-payment claim table (`SettlementPayment`, unique `paymentId`) |
| D-06 | SEC-07 | How do voids and unpaid check-ins become visible? | ★(a) an audit screen plus receipt lines (unpaid N, voided N with actor and reason) plus analytics; (b) also require a reason for a no-payment check-in; (c) also require OWNER approval for voids |
| D-07 | SEC-08 | Cancel or reschedule of a paid session? | (a) refuse while active payments exist; (b) auto-close terminal sessions at day end; ★(c) both |
| D-08 | SEC-11 | How much should a contact lookup disclose? | (a) rate-limit every path with a shared store only; ★(b) also mask the name when the match is outside the organisation; (c) also audit every disclosure |
| D-09 | SEC-14 | Who may reactivate a staff membership? | ★(a) OWNER-only reactivation, MANAGER may deactivate; (b) OWNER-only both ways; (c) keep and record |
| D-10 | SEC-16 | Parent view at a suspended or archived centre, or of a deactivated child | ★(a) hide; (b) read-only history |
| D-11 | SEC-17 | Can a student edit their centre record after first completion? | ★(a) one-time only, as documented; (b) later edits, excluding parent fields, audited |
| D-12 | SEC-18 | Separation of duties on money | ★(a) block self-approval (`teacherId ≠ actor`); (b) approver ≠ creator (hard for one-person centres); (c) split permissions only; (d) allow but flag in analytics |
| D-13 | SEC-20 | Void reason when an attendance change voids a payment. **Contradicts §5.1** ("reason is optional") | ★(a) required only when a payment is voided; (b) keep optional |
| D-14 | SEC-21 | Timezone changes vs. past sessions | (a) OWNER-only timezone; ★(b) freeze the timezone per session at creation; (c) an eager close job |
| D-15 | SEC-22 | FIXED centre cut above the price | (a) refuse everywhere; (b) allow with a warning and record in §5.1; ★(c) refuse, and re-check when a price is lowered |
| D-16 | SEC-23 (tied to OD-8) | Period settlement range bounds / undo | (a) `to ≤ today` and span ≤ N days; (b) a "cancel DRAFT" transition; ★(c) both |
| D-17 | SEC-24 | Money-sum overflow approach | (a) BigInt migration; ★(b) raw `::bigint` sums plus a realistic `MAX_PIASTRES`; (c) cap only |
| D-18 | SEC-26, SEC-27 | Abuse caps and CAPTCHA | the cap values for open reservations and self-enrolments; whether instant-enrol needs a verified account; ★ CAPTCHA (Turnstile) on sign-up and sign-in |
| D-19 | SEC-10, SEC-31, SEC-55 | RLS posture for PostgREST and Storage | ★(a) deny-all: no grants, no policies, Storage service-role-only; (b) SELECT-only policies; (c) JWT-per-query (Phase 2) |
| D-20 | SEC-29 (= **OD-2**) | Retention and erasure for minors' data | blocked on legal (OD-2); ★ meanwhile, stop putting names and free-text reasons into AuditLog |
| D-21 | SEC-38 | Seed admin password | ★(a) a separate `SEED_ADMIN_PASSWORD`; (b) random per account; (c) accept for dev |
| D-22 | SEC-42 | Who may revoke an invitation? | ★(a) OWNER-only, like create; (b) keep `staff.invite` and document it |
| D-23 | SEC-47 | Cross-tenant relation count on the student page | ★(a) same organisation only; (b) remove |
| D-24 | SEC-51 | Expense dates and deletion | whether late, backdated expenses are legitimate (★ allowed, but within the window and not in the future); ★ void-style expenses instead of hard delete |
| D-25 | SEC-53 | Centre logo source | (a) Supabase-host URLs only; ★(b) the `logos` bucket plus signed URLs; (c) free URL with limits |
| D-26 | SEC-58 | Zero-priced one-off sessions | (a) refuse; ★(b) allow, but warn and flag in analytics |
| D-27 | SEC-64 | Photo size | (a) raise the body limit to 5 MB; ★(b) cap at about 1 MB with a client-side resize |
| D-28 | SEC-65 | Should photo changes be audited (CLAUDE.md rule 7)? | ★ yes (it protects the reception photo comparison); or no |

---

## 7. Verified safe

Each item was checked and found sound; the evidence follows it.

**Tenant isolation**
- The `kayedu_center` cookie is checked on every request against the user's live relations. A foreign branch, another user's organisation, or a single-branch organisation is rejected (`lib/auth/tenant.ts:94-123,216-249`). `selectCenterAction` re-checks before setting it (`(auth)/actions.ts:189-216`).
- An OWNER of organisation X cannot reach organisation Y. Widening is by `Center.organizationId` (`lib/auth/relations.ts:101-107,144-154`), and nothing writes `organizationId` at runtime (`lib/db/platform.ts:176` always creates a new organisation).
- Branch grants are OWNER-only, target only same-organisation branches, and resolve with the target branch's own matrix (`settings/staff/member-actions.ts:185-242`, `tenant.ts:153-154`).
- Every centre Server Action file scopes nested ids by `centerId`: payments, voids, refunds, settlements, attendance, schedule slots, rooms, room sets, catalog selections, approvals and parent links (`session-lifecycle.ts:218`, `payments.ts:218-250`, `refunds.ts:88-100`, `payment-methods.ts:85`, `settlements.ts:150-153`, `attendance.ts:170-182`, `class-sessions.ts:1093-1100`, `room-sets.ts:288-292`, `catalog.ts:310`, `approvals.ts:60,125,140`, `parents.ts:163-165`). §2.4 has the full table. The only exception is SEC-46.
- Teacher reads and writes pin `teacherId = ctx.user.id` (`teacher/sessions/[id]/page.tsx:67-72`, `scoped.ts:855-859`, `teacher/approvals/actions.ts:29-33`).
- Print routes, the parent, student and admin pages, and the reception QR all check their ids (§2.3; `reception.ts:319` compares only the payload's centre).
- Not-found and other-centre lookups return the same error (`tenant-scope.ts` `assertInCenter`), and uniqueness errors are scoped per centre.

**AuthZ**
- Every one of the 98 centre actions checks `ctxCan` before writing. All 7 admin actions call `requirePlatformAdmin()` first, which reads `isPlatformAdmin` fresh (`tenant.ts:482-491`; `catalog-admin.ts:105` re-checks).
- The OWNER-only ceiling holds when actions are called directly: the matrix, role assignment, invitations and branch grants. Forged matrix fields are dropped (`settings/actions.ts:826-836`). The last OWNER and self-edits are guarded (`member-actions.ts:52-77,110,153`).
- Deny-by-default: `can()` returns `grants[p] === true` and denies STUDENT and PARENT unconditionally; `platform.manage` is platform-admin only; the TEACHER ceiling holds (`lib/auth/permissions.ts:142-152`).
- No mass assignment: every FormData input goes through a strict `z.object`, with no passthrough. `isPlatformAdmin` is never written by app code. `Membership.role` is written only by `changeMemberRoleAction` (an enum that excludes TEACHER) and by invitation acceptance (role taken from the row).
- Roles and grants are re-derived on every request, and no cookie or JWT carries a role (`tenant.ts:151-154`).
- Parents have no Server Actions, and a PENDING link reveals nothing (`parents.ts:121-130`).

**AuthN**
- Server identity always comes from `supabase.auth.getUser()`; `getSession` is trusted nowhere (`lib/auth/session.ts:9-15`, `lib/supabase/proxy.ts:31`).
- There is no open redirect: `next` always goes through `safeNextPath` plus next-intl's always-prefix (§3, SEC-43).
- Sign-in returns one uniform `invalidCredentials` error. Sign-up runs on the server with zod-built metadata, and no privilege is read from `user_metadata`.
- Invitations:
  - tokens are 256-bit (`randomBytes(32)`), `@unique`, expire after 7 days, and are single-use;
  - acceptance is bound to the invited email;
  - role and centre come from the invitation row;
  - inactive centres are refused;
  - create is OWNER-only and can't mint TEACHER (`(auth)/actions.ts:238-314`, `lib/validation/auth.ts:61-87`).
- A `User` already linked to an auth identity can't be re-linked (`session.ts:54-57`), so registered accounts are not exposed to SEC-01.
- Staff "link" can only target the server-resolved match (`students/actions.ts:220-229`).

**Money**
- The payment amount is derived on the server (`amount = session.priceSnapshot`, `lib/db/payments.ts:146`); `recordPaymentSchema` takes ids only.
- Share snapshots are frozen when the payment is recorded. The split lives only in `lib/money.ts`, clamped to 0..amount. Later price or cut edits never touch existing rows (`class-sessions.ts:549-556`). Cut and price edits are audited.
- A refund is a separate whole-payment `Refund` row (`@unique paymentId`); the payment's money fields are never updated (`refunds.ts:104-122`).
- Closed sessions refuse attendance, payment, void, refund, cancel, reschedule and cut override through one guard. Session close racing any write is serialized correctly, because the close UPDATEs the session row, so EvalPlanQual re-reads `closedAt`. A duplicate check-in is blocked by a unique index.
- PAID settlements are never adjusted, and no edit path exists after APPROVED (`settlements.ts:46-88`).
- Hard deletes can't wipe money: the student, teacher, class and session deletes refuse when history exists, and no code deletes a `SessionAttendee`.
- Default RECEPTIONIST grants exclude void, refund, correction and settlements (`permissions.ts:252-259`).

**Injection, XSS and files**
- All raw SQL in `app/` and `lib/` is parameterised tagged templates. `*Unsafe` appears only in dev scripts, with constants.
- There is no user-controlled `orderBy` or field name.
- ID-card SVG: every text node is escaped, colours are hex-only, the font comes from an allowlist and numbers are finite. A hostile-input check produced 0 event-handler attributes. The only two `dangerouslySetInnerHTML` sinks render that SVG.
- `themeColor` is regex-validated and applied through React style objects. The single `t.rich` call uses a static message. There is no CSV export.
- Storage:
  - all 4 buckets are private, and anonymous list, read, sign and upload all failed in a live probe;
  - every key is built on the server, so there is no path traversal;
  - `assertPathInCenter` runs before every sign, read or delete;
  - `photoUrl` can't be set by a client;
  - signed URLs last 600 s and are minted only for centre staff.

**Secrets and platform**
- No live secret appears in any tracked file or anywhere in git history (count-only scan). `.env.example` holds placeholders, and `.env*` is git-ignored.
- `docs/dev-accounts.md` contains no passwords, now or historically.
- The service-role key is non-public, and none of the 125 client modules reaches it in its import closure. No Server Action returns raw errors or whole rows. Server→client props are mapped DTOs.
- Error pages show `error.message` only in development. There are no `console.*` calls in app code.
- Server Actions CSRF: Next 16.3.4 checks Origin against Host and handles `Origin: null` correctly. No `allowedOrigins` is set, and the cookies are SameSite=Lax.
- Not affected by the middleware-bypass class (CVE-2025-29927 doesn't apply to 16.x, and the proxy doesn't gate anyway). React RSC advisories are patched (vendored React is dated 2026-07-31; react is 19.2.8). The next-intl open redirect is fixed in 4.14.1 with `localePrefix: "always"`.
- `kayedu_center` is httpOnly, Lax and Secure in production. Production source maps are off. Vercel supplies HSTS.

**RLS (dev project)**
- RLS is on for 39/39 app tables, including every R1–R9 table.
- anon and authenticated have no USAGE on `public`, no table privileges and no default privileges.
- There are no functions, views or `pg_graphql` in `public`, and the realtime publication is empty.
- The anon key gets 401/42501 on every sensitive table (`SEC-10.ts`).

**Minors' privacy**
- Teachers never receive student phone, parent phone, email or photo, and only see students from their own sessions.
- Students can't read classmates' data, and ratings expose averages only.
- Discover exposes no rosters or teacher contact details.
- AuditLog contains no phones, emails or photo paths (88 write sites reviewed).
- The QR payload is the centre id plus a sequential code, and it resolves only at that centre for `reception.use`.

**Availability**
- Session generation is capped at about 800 sessions per write (400 days × 14 slots).
- Analytics are database-side aggregates.
- The main lists are paginated or capped, and type-ahead returns `take: 8`.

---

## 8. Live platform state observed

All of this was read-only, on 2026-10-13/14, against the shared dev project.

| Item | Value |
|---|---|
| GoTrue | `mailer_autoconfirm=true` (email confirmation **off**), `disable_signup=false`, `phone_autoconfirm=false`, `sms_provider=twilio` |
| Prisma DB role | `postgres`: `rolsuper=false`, **`rolbypassrls=true`**; member of `anon`, `authenticated`, `service_role`, `authenticator`, `pg_read_all_data` |
| Transaction isolation | `read committed` by default; no money path sets `isolationLevel` |
| `public` tables | 40; RLS on 39 (all except `_prisma_migrations`); 0 policies; anon/authenticated have no USAGE and no grants; no default ACL on `public` (Supabase's stock default ACL is still present on `storage`, `graphql` and `graphql_public`) |
| `public` functions / views | none (`rls_auto_enable` and the `kayedu_*` helpers do not exist) |
| Storage | buckets `avatars` (5 MB img), `id-cards` (2 MB svg), `logos` (5 MB img+svg), `session-uploads` (20 MB img/pdf), all `public=false`; 0 policies on `storage.objects`; 0 objects |
| Constraints | `Payment` has no unique index on active payments (dropped in M5); `Refund_paymentId_key` UNIQUE; `SessionAttendee(sessionId, studentProfileId)` UNIQUE; no CHECK on Payment; no Settlement uniqueness or exclusion; no triggers |
| Exposure counts | 109 `User` rows with an email and `authId` null (107 with a StudentProfile) are claimable via SEC-01; 110 profiles carry a `parentPhone` (the SEC-03 surface); 13 legacy auth users accept the historical password (SEC-36) |
| `npm audit --omit=dev` | 21 vulnerable packages (2 critical, 17 high, 2 moderate); none reachable at runtime (SEC-34, SEC-35) |
| **After SEC-2b** (2026-10-14, `migrate deploy` of `20261018090000_sec2b_money_integrity` on dev) | Data checked first: 0 duplicate active payments, 0 rows both voided and refunded, 0 payments counted by two settlements, 0 FIXED cuts above a price, 0 cancelled/rescheduled sessions holding active money. After: `Payment_one_active_per_attendee` and `SettlementClaim_one_live_per_payment` (partial unique), CHECK `Payment_not_voided_and_refunded`, triggers `Session_freeze_timezone` and `AuditLog_append_only`; 723 sessions backfilled with their centre's timezone; 253 claims backfilled, every settlement total equal to its claims; `migrate diff` against the schema empty; `SettlementClaim` has RLS from birth. |
| **After SEC-2c** (2026-10-14) | No migration. `npm audit --omit=dev`: 0; full audit 9 high, dev-only (`braces` via the `shadcn` CLI, no patched release). Connection-level `options=-c lock_timeout=…` is dropped by Supavisor in both pool modes (server reported `lock_timeout = 0`); role `statement_timeout` 120 s; `idle_in_transaction_session_timeout` 0. 56 contact-less, relation-less `User` rows left by earlier gate runs (left in place). |
| **After SEC-2a** (`check:rls`, 2026-10-14) | 42 `public` tables, RLS on all, 0 policies; `anon`/`authenticated`: no USAGE, no table/sequence/function privilege, no default grant; buckets `avatars` (1 MB), `id-cards`, `logos` (512 KB, raster only), `session-uploads`, all private, 0 `storage.objects` policies; Prisma role `postgres` rolbypassrls=true. GoTrue unchanged (`mailer_autoconfirm=true` on dev, by design until OD-1). `npm audit --omit=dev`: 0. |

---

## 9. Docs contradicted by this audit

SEC-1 changes no behaviour, so these passages are **not** rewritten here. Each one is to be corrected in the same session as the fix that touches it (working rule 3). They are recorded so that nobody relies on them in the meantime.

| Doc claim | Reality | Finding | Status |
|---|---|---|---|
| `docs/03-build-order.md:186` (R2) says the "second active payment" race is closed | It is open; the lock query's EXISTS is stale | SEC-05 | **Corrected at SEC-2b** (the R2 entry says so; the race is closed by a fresh read and a partial unique index) |
| `docs/00` §5 and CLAUDE.md rule 4: duplicate matching uses verified phone/email only | No phone is ever verified, and sign-up phones and student-edited local phones are matched | SEC-02 | **Corrected at SEC-2a** (matching now links on the global email only; a phone is never a key) |
| CLAUDE.md rule 9: the visibility window is enforced in the scoped helpers | Enforced per page; only `refunds.list` applies it in `scoped.ts`; money writes skip it | SEC-62, SEC-08 | **Yes** — writes at SEC-2b (closure), reads at SYS (the floor is in `scoped()`) |
| `docs/02` §10 "Layer 2": `storage.objects` policies mirror membership, using three `kayedu_*` helpers | 0 storage policies and no helpers on the live project; the repo has no `avatars`/`id-cards` policies | SEC-55 | **Corrected at SEC-2a** (§10 now: no Layer 2 by design) |
| `docs/00` §2.1-B (line 69): `public.rls_auto_enable()` is executable by anon/authenticated | The function does not exist | SEC-56 | **Corrected at SEC-2a** |
| `docs/00` §2.1-B (line 71) and `docs/01:58,130`: avatars/id-cards policies exist; tables are "in the RLS backstop list" | No policies; the backstop script fails as written | SEC-30, SEC-56 | **Corrected at SEC-2a** |
| `docs/00:68`, `docs/02:326-328`: RLS is a safety net for direct SQL; the Prisma role is "non-superuser" | The Prisma role has BYPASSRLS, so RLS only ever covers PostgREST | SEC-57 | **Corrected at SEC-2a** (BYPASSRLS stated) |
| `supabase/m10-rls-and-storage.sql:21`: Prisma connects with the service-role key | It connects as `postgres` | SEC-30 | **Resolved at SEC-2a** (file deleted) |
| `docs/03` M20: "run `supabase/m10-rls-and-storage.sql`" is the RLS step | The script aborts on non-existent tables and omits 14 tables, and no migration carries the lockdown | SEC-10, SEC-30 | **Corrected at SEC-2a** (M20 now runs `check:rls` after the migration) |
| `docs/02` §10: photo limit 5 MB | Effectively 1 MB (the Server Action body limit) | SEC-64 | **Corrected at SEC-2a** (about 1 MB, shrunk in the browser) |
| `docs/00` §5.1 (M18): the phone lookup is rate-limited | Only 2 of the 5 paths that disclose a match are limited, and the limiter is per instance | SEC-11 | **Corrected at SEC-2a** (all five paths, shared store) |
