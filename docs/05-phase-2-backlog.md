# KayEdu — Phase 2 Backlog

> Everything deliberately **not** built in Phase 1, with the reasoning attached. `00-master-product-spec.md` §6 points here; this file is the detail.
>
> **Why this file exists.** §6 used to be one comma-separated line. That is enough to say "no" in a meeting and nowhere near enough to *re-decide* six months later, when the person asking has a real reason and nobody remembers what the item actually depended on. Every entry below therefore carries three things: **what it is**, **why it was deferred**, and **what it depends on** — the concrete precondition that would have to exist before building it is even sensible.
>
> **How to use it.** A center request that lands in the "Roadmap / Phase 2" bucket of `00-master-product-spec.md` §8 gets written down here, not remembered. An entry moving into a milestone gets deleted from here and written into `03-build-order.md` — an item living in both places is a bug, the same way a doc disagreeing with code is.
>
> **Not the same as Open Decisions.** `00-master-product-spec.md` §2.2 tracks questions with no answer yet. This file tracks answers we already have: "yes, later, and here is why not now."

---

## 1. Dynamic, session-aware QR check-in tokens

**What it is.** Replace the static printed card payload (`KAYEDU|{centerId}|{studentCode}`) with a rotating token that encodes the *session* as well as the person — a per-session or short-TTL code shown on a phone, verified server-side against a clock.

**Why deferred.** Phase 1's static card is a deliberate decision, not an oversight — see `00-master-product-spec.md` §5 "Check-in & the QR payload". A printed card works with no smartphone, no battery, no signal and no app install, which is the actual condition at the reception desk of an Egyptian center. A dynamic token converts a working offline flow into one that needs connectivity at exactly the moment (the rush) when connectivity is least reliable.

**Depends on.** A real, observed impersonation problem that reception's photo check does not catch; and either a student mobile app or a reliable in-browser student session on a phone the student actually carries. Also depends on the offline story (M21) — a rotating token and an offline queue are in direct tension and would have to be designed together, not separately.

---

## 2. Cross-center teacher conflict detection

**What it is.** Warn when a teacher's session at Center A overlaps a session at Center B — a genuinely cross-tenant read.

**Why deferred.** Every conflict check in Phase 1 is deliberately **within one center** (`00-master-product-spec.md` §5 "Scheduling", `02-architecture.md` §11). Detecting a cross-center clash means one center learning that a teacher works somewhere else, when, and with which class — precisely the leak M12's teacher-detail fix closes on purpose. The feature is not hard to build; it is hard to build *without* breaking the isolation guarantee the product is sold on.

**Depends on.** A teacher-consented disclosure model: the teacher, not the center, opting in to publish busy/free intervals (never class, student or center identity) across their own centers. That is a new consent entity plus a free/busy read path that is not `centerId`-scoped — a category of query this codebase currently has exactly one of (`lib/db/discover.ts`) and treats as an explicit exception.

---

## 3. Waitlist + reservation expiry

**What it is.** When a class is full, let a student join a waitlist and be promoted automatically as seats free up; and expire a `PENDING` reservation nobody acts on after N days.

**Why deferred.** Phase 1's rule is the simple one: enrollment is hard-capped by room capacity, a student may still *request* a full class, and staff cannot approve past the cap (`00-master-product-spec.md` §5 "Capacity"). A waitlist adds ordering, fairness, promotion timing, and a notification the moment a seat opens — and notifications are themselves deferred, so a waitlist would silently promote people who never find out.

**Depends on.** The notification layer (entry 9's announcements, or an SMS/WhatsApp channel). Expiry additionally depends on a scheduled job — and since R4 removed the session-generation cron, the product has none at all; expiry would introduce the first.

---

## 4. Employee HR: staff attendance, leave and payroll

**What it is.** Treat staff as employees, not just accounts — shift schedules, clock-in/out, leave balances, salaries and payroll runs.

**Why deferred.** KayEdu's financial model is per-session student payments and teacher shares. Payroll is a different ledger with different legal obligations (tax, insurance, Egyptian labour law) and different auditors. Bolting it onto the payment ledger would put two unrelated kinds of money in one place and break the "one snapshot rule for all money" clarity `01-data-model.md` §3 rests on.

**Depends on.** Teacher settlements (M14) proving out first — a payout record with DRAFT/APPROVED/PAID is the smaller, session-derived cousin of a payroll run, and its shape should inform payroll's rather than the reverse. Also depends on a legal review of Egyptian payroll requirements.

---

## 5. Learning content: materials, homework, exams, question bank, grades, progress, teacher notes

**What it is.** The LMS half of an education platform — uploading materials, assigning and collecting homework, building and marking exams, a reusable question bank, gradebooks, per-student progress tracking, and private teacher notes on a student.

**Why deferred.** This is a second product, not a feature. KayEdu Phase 1 is an **operations** system: who came, who paid, who gets what share. Every item here is content and pedagogy, needs its own storage/permission/ownership model (who owns a question a teacher wrote at a center they later leave?), and none of it is what a center pays for on day one.

**Depends on.** A settled answer to content ownership under the teacher-is-portable model (`01-data-model.md` §1 principle 1); plus session-level file uploads actually shipping — `session-uploads/` is provisioned as a bucket with no code path writing to it (`02-architecture.md` §10). Grades and progress additionally depend on academic terms (entry 11).

---

## 6. AI: paper-to-digital capture and question generation

**What it is.** Photograph a handwritten attendance sheet, exam or worksheet and digitize it; generate exam questions from material.

**Why deferred.** It presupposes the content layer in entry 5 and, for paper capture, a level of trust in extracted data that an append-only financial/attendance ledger cannot casually grant — an OCR mistake on an attendance sheet is a wrong money row. Any capture path must land in a **staging** area a human confirms, never straight into `SessionAttendee`/`Payment`.

**Depends on.** Entry 5; a staging-and-review pattern (shared with entry 10's import); and a per-center cost model, since inference is a real recurring cost the current pricing does not account for.

---

## 7. Online payments: gateway, checkout and webhooks

**What it is.** Students or parents paying online (Fawry, Paymob, InstaPay APIs, cards) with a webhook confirming settlement.

**Why deferred.** Phase 1 records payments taken at the desk; it never *processes* one (`00-master-product-spec.md` §2). A gateway introduces asynchronous, externally-authored money events — a webhook can arrive twice, late, or for a payment the center already recorded by hand — a fundamentally different reliability problem from a receptionist pressing a button. It would also reopen the debt question, since online payment naturally implies paying ahead.

**Depends on.** Idempotent, externally-keyed money writes (M21's client-UUID dedupe is the same primitive one layer out); a settled position on prepayment/credit, which Phase 1 explicitly does not have (§2 "Student debt"); and a payment-provider contract per center.

---

## 8. Zoom / Google Meet integration

**What it is.** Attach a live meeting link to a session, auto-create it from the class schedule, and reconcile online attendance.

**Why deferred.** Online teaching is out of Phase 1 scope. A meeting link on its own is a text field nobody needed; the version worth building reconciles *who actually joined* against the roster, which is a second attendance source with its own truthfulness problem sitting next to the desk's.

**Depends on.** A decision that KayEdu supports hybrid/online sessions at all, and per-center OAuth credentials for a provider.

---

## 9. Platform operations: support tickets, system announcements, subscription plans, module entitlements

**What it is.** In-app support ticketing between a center and KayEdu; platform-wide or per-center announcements; billing plans; and gating features per plan.

**Why deferred.** `Center.plan` was a free-text field with an editor and no behavior behind it; it **was removed entirely at M19** rather than left to imply a billing system that does not exist (`00-master-product-spec.md` §5 "Center lifecycle"). Module entitlements are explicitly rejected for Phase 1 — one product, configured, never forked per center (§8) — and a plan flag that switches features on and off is the first step toward that fork. Support tickets and announcements both need the messaging entity this app has nowhere: the Approvals screen's "contact" action was punted for exactly this reason (`03-build-order.md`, Approvals).

**Depends on.** A real billing relationship with more than one paying customer (the `Organization` model at M11 is the entity that would carry it); and one messaging/notification substrate serving tickets, announcements and Approvals-contact together, rather than three one-off inboxes.

---

## 10. Data import with a staging area and duplicate review

**What it is.** Onboarding import — a center arrives with its students in a spreadsheet — landing in a staging table, run through the duplicate-match workflow, reviewed row by row, then committed.

**Why deferred.** Listed as a pre-deployment item since M10 and not reached; a half-built import (or an import without duplicate review) is worse than none, because it is the fastest possible way to create exactly the duplicate-person mess `01-data-model.md` §6 exists to prevent. **Export is different** — it is a Phase 1 pre-deployment requirement and stays in M20.

**Depends on.** M3's duplicate-match panel, which already exists and is the right reviewer UI; plus a staging model that is deliberately *not* a tenant table of real records until commit.

---

## 11. Academic year and term entities (beyond R4's term presets)

**What it is.** First-class `AcademicYear` / `Term` records that enrolments, billing, analytics and grade promotion **hang off**: term-based enrolment (enrol a student "for Semester 2" rather than in a class open-endedly), billing by term, term-scoped analytics, automatic grade promotion at a term boundary, and report cards.

**What R4 already built — and why it is not this.** R4 shipped centre **term presets** (`CenterTerm`: a name and two dates, Settings → Terms — `03-build-order.md` R4, `00-master-product-spec.md` §5.1 "Class periods and centre terms"). A preset only **fills** a class's `startDate`/`endDate`; the dates are copied and nothing references the preset, so renaming, redating or deleting it never moves a class. That is a form convenience over a class's own period, not an entity anything hangs off — which is exactly what this entry still describes, so it stays here and does not appear in `03-build-order.md`.

**Why deferred.** Phase 1 is date-ranged, not term-ranged: analytics filters by day/week/month, a class's sessions come from its own period (R4), and no entity says "this is the end of a term" in a way enrolment, money or promotion could act on. **This resolves a live inconsistency the docs carried until now** — `00-master-product-spec.md` §4.1 item 4 promised "promote grade **at term end**" while no `Term` or `AcademicYear` model existed anywhere in `prisma/schema.prisma`. The shipped behavior is a **manual, staff-initiated bulk grade promotion** with no term trigger, and §4.1 now says exactly that.

**Depends on.** Mostly a modelling decision waiting on demand. Everything that would consume it (term-scoped analytics, automatic promotion, term-bounded enrolment, report cards) is itself deferred, so introducing the entity first would add a dimension to every query for no current reader. Entries 5 (grades/progress) and 17 (reporting) are its real customers. **Billing by term** additionally depends on prepaid packages/subscriptions, which Phase 1 excludes outright (`00-master-product-spec.md` §2 "Prepaid / packages / discounts / monthly subscriptions" — pay-per-session only — and this file's "Also deferred" row on packages). A future entity should be able to adopt R4's presets (a preset becomes, or links to, a `Term`) without moving any class, since classes only ever stored dates.

---

## 12. Phone / OTP registration and multi-factor authentication

**What it is.** Signing up and signing in with a phone number and a one-time code, and a second factor for staff and owners.

**Why deferred.** Supabase Auth owns credentials and email/password is what Phase 1 wires (`02-architecture.md` §3). SMS OTP has a real per-message cost and needs a provider contract — the same one the deferred notification layer needs — and MFA is a hardening step that belongs after there is production data worth protecting.

**Depends on.** An SMS provider (M20 provisions the account; the *feature* is this entry). **F3 note:** parent access no longer keys on a phone (OD-6 decided — a one-time code from the student or the branch, `00-master-product-spec.md` §5.1 "Parent role & portal"). An OTP to the parent phone the student declared stays a possible **extra factor** on accepting a code — it would narrow the residual risk recorded there (a student handing a code to a non-student adult) — and needs OD-2's answer on minors' data before it is built.

---

## 13. Teacher substitution

**What it is.** A named substitute teaching one session in the regular teacher's place, with the money attributed correctly.

**Why deferred.** `Session.teacherId` is a single value and `Payment.teacherId` is a denormalized snapshot of it (`01-data-model.md` §2) — the whole by-teacher analytics and settlement path assumes one teacher per session. Substitution means deciding whose share a session's `teacherShareSnapshot` belongs to, which is a money question, and CLAUDE.md rule 2 forbids guessing at those.

**Depends on.** Teacher settlements (M14) existing, so there is a payout record to attribute a substituted session against; and a center-level rule for who is paid — the regular teacher, the substitute, or a split.

---

## 14. Teacher qualification mapping

**What it is.** Recording which subjects, grades and education systems a teacher is qualified to teach, and using it to filter class assignment and the centre directory.

**Why deferred.** Phase 1 lets a center assign any of its teachers to any of its classes; the center knows who can teach what. The mapping only starts paying for itself when *matching* matters — a center browsing for a teacher, or a teacher browsing centers.

**Depends on.** The global academic catalog (M13), which is what makes a qualification portable at all: "qualified for IGCSE Physics" is meaningless while subjects are center-local rows. Also depends on the teacher centre-directory (M15), the first screen that would actually filter on it.

---

## 15. Student schedule-conflict warnings

**What it is.** Warning a student who enrolls in a class that overlaps one they are already in.

**Why deferred.** Conflict detection in Phase 1 protects the center's resources — a room cannot hold two classes, a teacher cannot be in two places (`02-architecture.md` §11). A student double-booking themselves harms only themselves, and across centers it is the cross-tenant read entry 2 describes. Within one center it is genuinely small, and it would be a warning rather than a refusal, since a student may legitimately intend to drop one.

**Depends on.** Nothing blocking within a single center — it is queued behind higher-value work rather than by a precondition. The cross-center version inherits entry 2's consent problem entirely.

---

## 16. Expenses: recurring entries, attachments and cost-centre attribution

**What it is.** Rent that repeats monthly without re-typing; a receipt image on an expense row; and attributing an expense to a branch, a room or a teacher rather than only to the center.

**Why deferred.** M6 shipped expenses as the minimum that makes net profit correct: category, amount, date. Recurrence needs a generator and a "was this month's actually paid?" state; attachments need a fifth storage bucket and its policies; attribution needs a decision about whether an attributed expense should reduce a *teacher's* net in analytics, which is a money-semantics question, not a UI one.

**Depends on.** Branch-level analytics (M11) for attribution to have a scope worth naming; and, for recurrence, the same scheduled-job infrastructure entry 3 wants.

---

## 17. Room-utilisation and reservation-conversion reports

**What it is.** Analytics beyond money — how full each room is by hour, which classes convert requests into enrollments, where a center is leaving capacity unused.

**Why deferred.** Phase 1 analytics answers the owner's first question (where did the money go) exactly and provably, reconciled against frozen snapshots. Operational analytics answers a second-order question a center only asks once the first one is trusted, and it needs history the pilot has not accumulated yet.

**Depends on.** A pilot center with real history; and, for utilisation to mean anything, branch-level roll-up (M11) so "which room, at which branch" is a question with a scope.

---

## 18. Full database rename: `Center` → `Branch`, `Organization` → `Center`

**What it is.** Renaming the models, columns and every reference so the schema uses the vocabulary the business actually uses — the paying customer is a *Center*, and each location is a *Branch*.

**Why deferred.** M11 introduces the `Organization` model and makes `Center` the branch-level tenant, but keeps `center_id` as the sole isolation key, untouched (`01-data-model.md` §2, `02-architecture.md` §5). The rename would touch every table, every scoped helper, every gate script and every migration — a very large, purely cosmetic change to the one part of the system the whole product's correctness rests on. **The naming mismatch is resolved in the i18n layer instead**: the UI says "Branch" where the DB says `Center`, and "Center" where the DB says `Organization` (`02-architecture.md` §8). Nobody outside the schema ever sees the old vocabulary.

**Depends on.** A quiet period with no in-flight milestone touching isolation, and a mechanical migration plan with every isolation gate (`check:isolation`, plus each gate asserting cross-center denial) green before and after. Do this as its own dedicated pass or not at all — never folded into a feature milestone.

---

## 19. Layout-independent card payload (a digits-only code a scanner types identically under any keyboard layout)

**What it is.** A card payload — printed in the QR, or an additional short numeric code beside it — that a USB keyboard-wedge scanner types as the *same characters* whatever the OS keyboard layout is. Today `KAYEDU|{centerId}|{studentCode}` carries Latin letters (the prefix and the hex centre id) that arrive as Arabic letters when an Arabic layout is active, so the desk has to scan with the English layout.

**Why deferred.** The static payload is a recorded decision (`00-master-product-spec.md` §5.1 "Check-in & the QR payload") and R7 was explicitly told not to change the format; changing it invalidates every card already printed. R7 instead makes the failure *visible* (a payload-shaped scan with an unreadable prefix says "check the keyboard language" rather than "no student") and keeps the bare digits-only code working under any layout. Student codes also restart at 1001 in every centre, so a digits-only payload cannot identify the centre by itself — the desk's own centre scoping would have to carry that, and a card from another branch would then be indistinguishable from a student of this one.

**Depends on.** A decision on transition (accept both payloads for a period, or reprint), a way to keep a card from another branch refusable without the centre id in the text (a per-centre numeric prefix, or a check digit over centre + code), and the ID-card editor, where the card layout and the QR block are edited (R9 shipped the editor's styling and drag fixes with the payload deliberately untouched, so this dependency is still open).

---

## 20. The card font actually drawn: embed Cairo in the card SVG

**What it is.** Make the "Cairo (card font)" choice in the ID-card editor render as Cairo everywhere — the editor preview, the print view and the stored `id-cards/` file — by embedding the font in the card SVG (a subset as a base64 `@font-face`), so the three-way font choice (card font / system sans / system serif) is three visibly different faces on every machine.

**Why deferred.** The app loads Cairo through `next/font`, which serves it under a generated family name; the card SVG asks for `Cairo` by its plain name, which resolves only on a machine that has Cairo installed, and otherwise falls back to `'Segoe UI'` / `system-ui`. That is how the card has always rendered, and R9 deliberately added **no new web font** and kept every layout saved before it byte-identical. Embedding a font changes the size of every stored card file and the bytes of every card, which is a decision of its own — not something to slip into a styling pass. In practice today the "card font" and "system sans" options look alike in a browser; the serif option is visibly different.

**Depends on.** A decision on how large a stored card may be (a subset of Cairo's Arabic + Latin ranges, with weights 400/500/600/700, is tens of KB per file), and on whether stored cards from before the change are regenerated or left as they are.

---

## 21. A platform-admin "repair this centre's baseline" action

**What it is.** A button on `/admin/centers/[id]` that runs `provisionCenterBaseline` (`lib/db/provision.ts`) for a centre that lacks part of it — missing settings, missing baseline `PermissionGrant` rows, no active payment method — and writes an audit row saying what it added, with a preview of exactly which rows are missing (`centerBaselineGaps`) before anything is written.

**Why deferred.** P1 fixed the cause (every centre-creating path now goes through that one function) and deliberately did **not** backfill existing centres: re-adding a grant row an Owner removed or never wanted is a permission change made by side effect, and the only centres known to lack the baseline were the two dev Center 60 branches, which a wipe + reseed replaces. There is no production centre in that state. A repair that is a visible, audited, deliberate platform action is the right shape if one ever appears; building it before one does would be speculative.

**Depends on.** A decision on whether a repair may only *add* missing rows (the function's behaviour today — it never flips an existing row) or may also reset a centre's matrix to the baseline, which is a different and more dangerous operation; and on who may run it (platform admin only, per `00-master-product-spec.md` §3).

---

## 22. ~~Enforce the Content-Security-Policy~~ — moved to M20 (SEC-2c)

**Moved, not dropped.** Enforcing the policy SEC-2a ships as `Content-Security-Policy-Report-Only` is now an **M20** build item (`03-build-order.md` M20, `00-master-product-spec.md` §2.1-C): it needs a browser pass over every route group in both locales and a reporting endpoint (Sentry's CSP intake), both of which M20 brings. The number is kept so older references still resolve; an item lives in one list only.

---

## 23. A dedicated Postgres role for the app that does not bypass RLS

**What it is.** Connect Prisma as a `kayedu_app` role with exactly the table privileges the app needs and **no** BYPASSRLS, so the row-level-security backstop also covers the app's own connection — today it only covers the Supabase Data API (SEC-57).

**Why deferred.** On Supabase the `postgres` role Prisma uses has BYPASSRLS, and the app's tenant isolation is enforced in code (`lib/db/scoped.ts`, CLAUDE.md rule 1). A non-bypass role only helps once there are **policies** that express tenant isolation per request (a `centerId` set per transaction, read by the policies) — a per-query design the audit lists as D-19 (c) and the project chose not to build (D-19 (a): deny-all, no policies). Without those policies a non-bypass app role would simply see nothing.

**Depends on.** A decision to move from deny-all to per-tenant policies (setting the tenant per transaction from `getTenantContext()`), a migration path for the role and its grants that `prisma migrate deploy` can run, and connection-pooler support for per-transaction settings.

---

## 24. Identity merge: one person recorded as two `User` rows

**What it is.** A platform-admin tool to merge two global `User` rows that turn out to be the same person (registered twice before the duplicate-match caught it, or a sign-up whose account claim was declined and who is later proven to be the staff-created person): move every `Membership`, `StudentProfile`, `FamilyLink` (both sides) and `FamilyInvitation`, rating and claim from one `User` to the other, in one audited transaction, and retire the loser.

**Why deferred.** Earlier docs described "merge is a manual, audited admin action" as if it existed; the SYS audit found no such tool (`docs/08-system-audit.md`). The match workflow (M3, SEC-2a) already prevents most duplicates by refusing to create a second `User` for a known global email, and an `AccountClaim` (D-01) covers the sign-up case without a merge. A merge touches money-bearing history across centres (`Payment.studentProfileId`, `Settlement.teacherId`, `Payment.teacherId`) and the identity rules of CLAUDE.md rule 4, so it needs its own design — including what happens when both rows hold a profile at the same centre.

**Depends on.** A decision on conflict rules (two profiles at one centre; two Supabase logins), the verified-phone/OTP work (entry 12) for proving the merge is wanted, and the retention/erasure rule (OD-2) for the retired row.

---

## 25. Drop `ParentLink` after the pilot

**What it is.** A migration that drops the deprecated `ParentLink` table, its `ParentLinkStatus` enum and the three relations to it (`User.parentLinks`, `StudentProfile.parentLinks`, `Center.parentLinks`), plus `gate-db`'s orphan filter on it.

**Why deferred.** F3 replaced it with `FamilyLink` and copied its VERIFIED rows across (`LEGACY_VERIFIED`), and nothing reads or writes it any more — but every migration in the F3 batch is additive, so the live build and the dev database can be migrated in either order. Dropping a table is the one change that is not; it waits until the pilot has run on family links and nobody needs to look back at the old rows.

**Depends on.** The pilot (M20 → first centre live) having run on F3's family links; a backup taken before the drop (M20's tested restore).

---

## 26. A platform-admin screen to find and revoke a family link

**What it is.** A small `/admin` tool: look up a family link by either person's account, see how it was made, and revoke it with a reason — the screen for `revokeFamilyLink({ by: "admin" })`, which F3 built and gates (`lib/db/parents.ts`, asserted in `check:parent`).

**Why deferred.** F3's revocation paths that a centre operates — the branch (from the student's page) and the parent (Account → Family) — cover the cases a pilot will meet; a platform admin is the escalation path for a link no branch can see (a child at no branch yet), which needs a support process before it needs a screen. Building a cross-tenant people lookup for the admin is a privacy surface of its own.

**Depends on.** A support process (backlog entry 9's support tickets, or the pilot's own escalation route); OD-2 for what an admin may see of a minor's family.

---

## 27. A real order for catalog grades (a "next grade" in promotion)

**What it is.** A sequence on the global academic catalog's grades within an education system (Grade 9 → Grade 10 → …), so that Promote students (F4) can **pre-select the next grade** as the To grade, and a future "promote a whole year" or report can reason about "this grade's successor".

**Why deferred.** `CatalogGrade` has no order — only a name, an education system and an active flag — and grades are free-text bilingual names a platform admin adds (R8). F4's promotion therefore asks the admin to pick the To grade and **invents no order** (sorting by name would put "Grade 10" before "Grade 2" and promote students the wrong way). A sequence is a modelling decision across every education system the platform carries (some have two terms, some skip a year, some end), best made with the platform admin who owns the catalog.

**Depends on.** A `sortOrder` (or a successor link) on `CatalogGrade`, editable at `/admin/catalog` (R8), backfilled by the platform admin for the systems in use; entry 11 (academic terms) if promotion is ever to be automatic.

---

## Also deferred (carried forward, no change in reasoning)

Already listed in `00-master-product-spec.md` §6 before it became a pointer. Recorded here so the single list is complete.

| Item | Why it stays out |
|---|---|
| **Native mobile apps** | The web app is responsive to a 375px floor (`04-design-system.md` §6). A native shell adds two store pipelines and an update cadence for no capability the browser lacks in this product. |
| **Online live teaching** | Same reasoning as entry 8 — KayEdu manages in-person operations. |
| **Advanced LMS / content library** | Entry 5. |
| **University workflows** | A different institution shape entirely (credits, faculties, semesters) — not a configuration of the current model. |
| **Marketplace monetization** | Discover is a browse surface, not a market; taking a platform cut of a center's revenue is a business-model change, not a feature. |
| **Student debt / credit balances** | Explicitly rejected (§2): attend = pay, or not counted. Refunds at M14 are **cash-back only** and deliberately create no balance (`00-master-product-spec.md` §5 "Refunds"). |
| **Packages / subscriptions / discounts** | Every one of these breaks the "one session, one price, one snapshot" model that makes the ledger auditable. Revisit only with a designed answer for how a discounted session snapshots. |
| **SMS / WhatsApp notification features** | The *provider accounts and credentials* are provisioned pre-deployment (M20) so the channel exists; the notification features that would use them — reminders, absence alerts, waitlist promotion, parent messaging — stay Phase 2. Provisioning a channel is not shipping the feature, and this row is the line between the two. |
| **Full parent portal (as previously scoped)** | **No longer deferred.** A parent role and a per-child mirror of the student portal are Phase 1 as of M16 (`00-master-product-spec.md` §4.5). What stays out is everything §6 originally bundled under "parent portal" that belongs to other entries here: parent messaging (entry 9), homework/grades visibility (entry 5), and online payment by a parent (entry 7). |
