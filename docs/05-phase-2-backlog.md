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

## 5. Learning content: materials, question bank, richer assessments, grades, progress, teacher notes

> **Narrowed by the W-batch (3 Nov 2026, W-C1).** Teacher-built **multiple-choice exams and homework** — one correct option, text only, one attempt, auto-graded, in centre classes and PERSONAL workspaces — moved into `03-build-order.md` W2–W4 and W9 (`00-master-product-spec.md` D-W01…D-W11, D-W26), so they are no longer listed here. What stays deferred is everything else below. That includes **images in questions** (wait for Cloudinary, M20), **any other question type** (multi-select, free text, file answers, manual marking), **more than one attempt**, **assessments seen by centre staff or parents** (D-W11), a **gradebook** across assessments, and a **reusable question bank**.

**What it is.** The LMS half of an education platform — uploading materials, a reusable question bank, question types beyond single-answer multiple choice (and their manual marking), gradebooks, per-student progress tracking, and private teacher notes on a student.

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

**W-batch note (3 Nov 2026, W-C2 / W-C5).** Two things nearby are now in the build and are **not** this entry. (1) **Premium teachers** (`03-build-order.md` W6, D-W14): a platform admin sets an end date on a *teacher's* account, with no payment flow. It is not a centre plan and switches nothing on or off for a centre, so "module entitlements" for centres stay rejected. (2) **The in-app inbox** (W1, D-W12) is the notification substrate this entry depends on, and it carries system notices only. Support tickets, announcements and Approvals-contact stay here and would build on it.

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

## 28. Written reviews of teachers and classes

**What it is.** Free-text reviews a student (or parent) writes about a teacher or a class, shown beside the star average on Explore (F5), Discover and the teacher's own view.

**Why deferred.** Today a rating is a 1–5 score and what is published is the **average only, never a count** (spec §5 "Teacher ratings") — nothing a person wrote is ever shown. Written reviews change that in three ways the product has no answer for yet: **moderation** (who reads every review before it is public, what is removed, how fast, and who answers an appeal); **minors** — most reviewers are school students, so a public text field is a child's words published under (or traceable to) their name, with the retention and erasure questions of OD-2; and **defamation** — a public claim about a named teacher is the platform's liability the moment it is shown. F5's public pages make the exposure larger, not smaller: a review would be readable by anyone, without an account. Explore therefore shows the star average only, by design.

**Depends on.** A moderation workflow and the people to run it; OD-2's retention and erasure rule (legal review for minors' data, M20); a terms-of-use and takedown policy (needs the domain and legal entity, OD-1); a decision on whether reviews are anonymous (and how anonymity holds with small classes — the same reasoning that keeps the count hidden).

---

## 29. Booking a one-time session (no class) online

**What it is.** Let a student book a one-time session (R5 — `Session.classGroupId` null: its own title, price and cut) from the student portal, the way F6 lets them book one session of a class.

**Why deferred.** F6's booking rules all hang off a class: whether booking is on and whether it needs approval (`ClassGroup.sessionBookingMode`), the optional cap (`maxBookingSeats`), the seat limit (the class's room set), the teacher queue (the class's teacher) and where a student finds the session at all (a class page on Discover / Explore). A one-time session has none of these — no setting to say it is bookable, no page that lists it, no seat limit defined independently of a class, and no class teacher to route an approval to. Answering each is a product decision, not a configuration of what F6 built, so F6 refuses them (`requestBooking` needs a class session) rather than guessing.

**Depends on.** Booking settings on a one-time session (mode and cap, probably on the New session form); a seat limit for it (its own room set's capacity); a place a student discovers one-time sessions (Discover / Explore list classes only); who approves (the session's teacher, or the branch only).

---

## 30. A pending-approvals count that updates without navigating

**What it is.** The sidebar Approvals badge and the Approvals tab counts (F7) refresh the moment a request is made, in a manager's or teacher's already-open tab, without them navigating or acting.

**Why deferred.** F7 reads the counts on every navigation and after each approval action (the action's `revalidatePath` refreshes the page and the shell together) and deliberately does not poll: polling every open tab multiplies pooled-connection load for a number that is usually unchanged, and the pooler is the product's scarce resource (`02-architecture.md` §14). A request made while someone sits on another page therefore shows on their next click. Doing better needs a push channel, which the product does not have anywhere yet.

**Depends on.** A realtime transport (Supabase Realtime or server-sent events) that carries only "a request landed for branch X" — never the rows — and re-reads `pendingApprovalCounts` on receipt, subscribed per branch so `center_id` stays the sole isolation key; a decision on the load it adds against the connection budget.

**W1 note (3 Nov 2026).** The notification bell's unread count (D-W12) is in the same position, for the same reason: server-rendered on every navigation, never polled. The same transport would serve it, carrying "a notice landed for user X" only.

---

## 31. A note on a staff-cancelled booking

**What it is.** When staff cancel a student's confirmed single-session booking (T7), an optional one-line note — "the room is closed that day", "duplicate booking" — that the student sees beside **Cancelled by the branch** in My requests.

**Why deferred.** T7 was an explicitly no-schema-change session. `SessionBooking` has no text column, and an `AuditLog` row may not carry free text (D-20 — ids, amounts, statuses only), so there is nowhere to put the note without a migration. The cancel itself (reason `STAFF`, seat freed, audited with ids) is delivered without it.

**Depends on.** A nullable note column on `SessionBooking` (length-capped, cleared with the booking like the rest of the row), an optional textarea in the Cancel booking confirm dialog, and a line in My requests. The audit row stays free of the text — it lives on the record, like `Payment.voidReason`.

---

## 32. Drop `CatalogSubject.gradeId` after the pilot

**What it is.** A migration that drops the deprecated `CatalogSubject.gradeId` column (U3) — the subject's old single parent grade.

**Why deferred.** U3 made a subject grade-independent (links live in `CatalogSubjectGrade`) and its migration was expand-only, so the build deployed before U3 kept working on the migrated database until the new code shipped. Nothing reads or writes the column since U3, and its FK and index are already gone; dropping it is the one step that is not backward-compatible, so it waits until no build that reads it can be running and nobody needs the old values to look back at.

**Depends on.** The pilot (M20 → first centre live) on the U3 build; a backup taken before the drop (M20's tested restore). Remove the column and its schema comment in the same change.

---

## 33. Purge a deleted branch

**What it is.** Permanently removing a branch a platform admin soft-deleted (U5) — its `Center` row and everything that hangs off it: classes, sessions, attendance, payments, settlements, students' records there, staff memberships, pauses — after its 30-day `restorableUntil` has passed. Today the row stays in the database for good once deleted: it is invisible everywhere (`ACCESSIBLE_CENTER`, `COUNTED_BRANCHES`), the admin's Restore is refused after the window, and bringing it back later is a manual database fix.

**Why deferred.** It deletes minors' records and money history, so what may be erased, after how long, and with what export first is exactly the retention question **OD-2** (legal review for minors' data, D-20's retention half) is open on. Building an eraser before that answer would either erase what the law requires us to keep or keep what it requires us to erase. A soft delete is reversible and harmless meanwhile.

**Depends on.** OD-2 answered (retention and erasure rules); OD-4 (data export scope — a centre may be owed an export before its data goes); a tested backup/restore (M20). The audit log is append-only by trigger, so a purge also needs a decided answer for the branch's own audit rows.

---

## 34. Drop `CenterSettings.dataVisibilityDays` after the pilot

**What it is.** A migration that drops the deprecated `CenterSettings.dataVisibilityDays` column (U6) — the single M19 window, replaced by `centerDataVisibilityDays` and `teacherDataVisibilityDays`.

**Why deferred.** U6's migration was additive and backfilled both new fields from it, so the build deployed before U6 kept working on the migrated database until the new code shipped. Since U6 the only code touching it is the branch-copy carry-over in `lib/db/branches.ts` (kept so `check:branches`' existing copy assertion still holds); dropping the column is the one step that is not backward-compatible, so it waits until no build that reads it can be running.

**Depends on.** The pilot (M20 → first centre live) on the U6 build; a backup taken before the drop (M20's tested restore). Remove, in the same change: the column and its schema comment, the carry-over line in `copyBranchSetup`, the `dataVisibilityDays` fixture/assertion in `check:branches` (moved to the two new fields), and the allowance for it in `check:visibility`'s "no file reads the deprecated column" assertion.

---

## 35. Drop `User.avatarUrl` after the pilot

**What it is.** A migration that drops the deprecated `User.avatarUrl` column (U9).

**Why deferred.** It has never been written: F8's personal profile photo had no storage destination, and U9 removed that feature (only teachers have photos, per branch, on `Membership.photoKey`). Dropping the column is not backward-compatible with a build that still selects it (any `User` `include` returns it), so it waits until no such build can be running.

**Depends on.** The pilot (M20 → first centre live) on the U9 build; a backup taken before the drop (M20's tested restore). Remove, in the same change: the column and its schema comment in `prisma/schema.prisma`, and the mention in `docs/01-data-model.md` (User).

---

## 36. Notify parents

**What it is.** A parent gets the notices their linked child gets — an enrolment or booking decision, a session cancelled or moved — in the parent portal's bell, one per child, naming the child.

**Why deferred.** W1 decided parents are not notified in v1 (decision 10 of the W1 prompt). A parent's reach is through `FamilyLink` (a per-child view, M16/F3), not a relation of their own, so the read-time access re-check needs a second rule ("the child is still linked, and the child still reaches the branch"), and the text would name a child — a person's name rendered in a notice, which needs its own decision on what a parent may see after a link ends.

**Depends on.** A `PARENT`-audience rule in `lib/notifications/kinds.ts` and `visibleWhere` that re-checks the active `FamilyLink` at read time; fan-out at the producer (one row per linked parent, in the event's transaction); a decision on whether a revoked link hides the parent's past notices.

---

## 37. Prune old notifications

**What it is.** A retention rule for `Notification` rows — for example, read notices older than 90 days removed.

**Why deferred.** W1 keeps every notice (decision 11 of the W1 prompt): volumes are small at pilot scale, the inbox is paged, and a deletion needs a scheduled job, which the product does not run anywhere (the R4 / D-W10 / D-W12 rule — no cron).

**Depends on.** A decision on the retention period and whether unread notices are kept longer; a place to run it without a cron — lazily on the owner's own inbox read (delete that person's expired rows, D-W10's shape) is the likely answer; the `(userId, readAt, createdAt)` index already serves it.

---

## 38. A notice when "End pause now" restores a session

**What it is.** When a platform admin ends a branch pause early and a session the pause cancelled is restored to SCHEDULED (U5), the students who were told it was cancelled are told it is back on.

**Why deferred.** W1's producers are the four events the prompt named; a restore is a fifth. Until then a student who got "cancelled" sees the session reappear on their schedule with no notice, and the old "cancelled" notice stays in their inbox (it is history, not a status).

**Depends on.** A `SESSION_RESTORED` kind and a producer inside `endBranchPause`'s per-session write; a decision on whether restoring also notifies bookers (bookings are not restored — U5).

---

## 39. Parents seeing exams, homework and results

**What it is.** A parent seeing what their child has been set, whether it was submitted, and the score, in the per-child mirror of the student portal.

**Why deferred.** W3a decided parents see nothing in v1 (D-W11, D-W31). Reveal rules were designed around the student: a parent's view needs its own answer to whether a score hidden from the student is hidden from the parent too, and before reveal it must carry the same guarantee (CLAUDE.md rule 11).

**Depends on.** A decision on what a parent may see against `showScore` and `showCorrectAnswers`; a read of its own (W4's `lib/db/assessment-results.ts` is teacher-only and returns correctness, so a parent must never reuse it); `check:assessments` extending its sweep to `(parent)` for anything it starts reading.

---

## 40. CSV export of an assessment's results

**What it is.** Downloading a results table, and perhaps the per-question analysis, as a CSV from the results page.

**Why deferred.** W4's job is reading results on screen (D-W33). An export is a new way for students' names and marks to leave the system, so it needs its own answer on what it carries and whether it is audited.

**Depends on.** W4's `readAssessmentResults`; a decision on columns and audit; the same owning-teacher authority.

---

## 41. Manual regrade and point overrides

**What it is.** A teacher correcting a question's key or awarding points by hand after attempts are final.

**Why deferred.** Scores are frozen at submit and never recomputed (D-W09), and that is what makes the results reconcile. A regrade needs a designed answer for how a corrected score sits beside the frozen one, what the student is told, and how it is audited.

**Depends on.** A decision that replaces "never recomputed" for this one case, with an audited, append-only correction (the void-and-recreate shape of rule 2); the lock (D-W08).

---

## 42. Comparing a student across assessments

**What it is.** One student's scores over time, across every exam and homework in a class or from a teacher.

**Why deferred.** W4 is per assessment (D-W11). A longitudinal view is the gradebook and progress tracking entry 5 keeps deferred, and it raises questions W4 does not: how homework and exams weigh against each other, and what happens across a left and rejoined class.

**Depends on.** Entry 5's gradebook decision; W4's reads.

---

## 43. Changing the reveal toggles after a student has started

**What it is.** A teacher turning `showScore` or `showCorrectAnswers` on or off once an attempt exists, for example to show answers after the exam, having published with them off.

**Why deferred.** W2 and W3a let the teacher choose them before publishing, and D-W08/D-W31 fix everything except the closing time once an attempt exists. The W4 plan named these toggles as editable afterwards, which contradicts that lock, so the founder deferred them at W4 (D-W33). Turning `showCorrectAnswers` on reaches rule 11 directly, since it changes who can read correct answers.

**Depends on.** A recorded exception to D-W08/D-W31; audit of the change; a `check:assessments` proof that the reveal still needs a final attempt and a closed assessment; whether students are told.

---

## 44. An admin premium overview and an expiring-soon list

**What it is.** A page under `/admin/teachers` listing the accounts that are premium now, with their end dates, and a list of those ending within the next few weeks, so KayEdu can follow up on renewals.

**Why deferred.** W6 (D-W35) deliberately builds an exact-email lookup only: no listing, no partial search, no browsing of users. A list of premium accounts is a list of users with names and emails, so it needs its own decision on what the admin may browse. The renewal conversation happens outside the product in v1 ("Contact KayEdu").

**Depends on.** A decision on what a list may show (name, email, end date) and to which admins; paging and a count read over `User.premiumUntil` (an index if the list grows); the same `requirePlatformAdmin()` and `lib/db/premium.ts` re-check.

---

## 45. Notices for a premium grant, expiry or renewal

**What it is.** An inbox notice (and, once `EMAIL_ENABLED` has a sender, an email) when an account is granted premium, when it is about to end, when it has ended, and when it is renewed.

**Why deferred.** Out of scope at W6 (D-W35, item 7). An "about to end" or "has ended" notice has no event to write it, and rule 12 allows no cron, so it would have to be computed on read (the D-W32 "soon" pattern) — a design of its own. The grant and renewal notices are simple, but shipping only those would be half a feature.

**Depends on.** A new notification kind or kinds (an additive enum migration), the compute-on-read producer for expiry, the audience (the account holder only), and the M20 email sender for anything beyond the inbox.

---

## 46. Inviting an assistant by email

**What it is.** The teacher types an assistant's email on `/teacher/assistants` and KayEdu sends the invite: a link to `/assistant-join` with the code in its fragment, so the person never has to be handed the code.

**Why deferred.** W7a (D-W36) ships the code only, shown once and handed over by the teacher (D-W16: "an email invite comes later, behind `EMAIL_ENABLED`"). There is no email sender until M20, and an emailed invite is the first feature that addresses an assistant by contact before they accept, which needs the D-02 / W-C6 rule written for it (an email may address an invitation; it never links).

**Depends on.** M20's SMTP sender and `EMAIL_ENABLED`; the same `createAssistantInvite` (one code, one slot), with the address used only to send and never stored on the invite or the audit row (D-20); a rate limit on sends per teacher; copy in both locales.

---

## 47. A notice when an assistant joins or leaves

**What it is.** An inbox notice to the teacher when someone redeems their code ("<name> is now your assistant"), and when an assistant leaves; optionally one to the assistant when the teacher removes them or changes their permissions.

**Why deferred.** Out of scope at W7a (D-W36): the teacher sees the new assistant on their own page at the next request, and nothing yet acts on an assistant's grants. The planned `ASSISTANT_INVITATION` kind does not fit a code invite at all (nobody is addressed before redemption), so these are new kinds, each a decision about who is told what.

**Depends on.** New `NotificationKind` values (an additive enum migration), written in the redemption's and the leave's own transactions (`notify(tx, …)`, D-W12), ids only in the payload (the link id), names loaded at read time — and only while the link is effective, so a lapsed teacher's name is never shown.

---

## 48. Notices to and about assistants

**What it is.** An assistant receives the notices that matter to their work (a student submitted, a request the assistant filed was approved or declined), and the teacher is told when an assistant acts for them ("<assistant> published <exam>").

**Why deferred.** W7b (D-W37 item 11) sends nothing to or about an assistant. Each kind is a decision about who learns what about whom, and an assistant has no centre relation, so the read-time access re-check notices use (D-W12) has no reach to test them against. A notice about an assistant's act would also be the first place the teacher sees the assistant's name tied to an action.

**Depends on.** New `NotificationKind` values (an additive enum migration) written in the event's own transaction; a reach rule for assistants built on `resolveAssistantActing` (an effective link, the branch allowing assistants), re-checked on read; ids only in the payload, names at read time.

---

## 49. A teacher's view of their assistants' activity

**What it is.** On the teacher's own side, a list of what each assistant did for them: the exams published, the requests filed, each with "via <assistant>". The teacher's request list could also tag a request filed through an assistant.

**Why deferred.** D-W37 item 10 puts the "via assistant" tag on the teacher's own audit-style views only where one exists, and the teacher portal has none: its pages list rows, not who acted on them. The audit rows already carry both people (`actorUserId` = the assistant, `onBehalfOfUserId` = the teacher), so the data is there.

**Depends on.** A teacher-facing read of `AuditLog` by `onBehalfOfUserId`. Unlike every centre read it would show the assistant's name to the teacher, who sees their assistants already (the Assistants page). It also needs a page under the teacher nav (P1: the nav permission, the baseline, the expected navs).

---

## 50. A reschedule request (teacher and assistant)

**What it is.** A teacher, or their assistant with `requests.manage`, asks the branch to move one of the teacher's sessions to another date and time, and the branch approves it in `/approvals` like the other teacher requests.

**Why deferred.** The W7b prompt listed "reschedule" among the requests a teacher can file, but the teacher cannot file one: `ChangeRequestType` is only `NEW_CLASS` and `NEW_SESSION`, and rescheduling is a staff action (`rescheduleSession`). Decided with the founder at W7b: assistants file exactly what the teacher can, so this waits for both.

**Depends on.** A `RESCHEDULE` value on `ChangeRequestType` (an additive enum migration), a payload naming the session and the new slot, an approval branch in `/approvals` that calls the unchanged `rescheduleSession` (so its conflict, pause and notice rules apply), and the trusted-teacher and `changeRequest.create` gates of the other requests.

---

## 51. Cancelling a pending request (teacher and assistant)

**What it is.** The teacher, or their assistant, withdraws a request the branch has not decided yet.

**Why deferred.** Teachers cannot do it today: `ChangeRequestStatus` has no cancelled state and there is no withdraw action. Decided with the founder at W7b: the assistant sees each request's status and cannot cancel one until the teacher can.

**Depends on.** A `CANCELLED` status (an additive enum migration) or a delete rule, an action for the teacher and the assistant (the assistant's through `assistantCan(…, "requests.manage")`, audited on behalf), the approvals queue and counts leaving cancelled rows out, and a decision on whether a cancelled request stays in the teacher's list.

---

## 52. Student phones for the teacher and the assistant

**What it is.** A teacher sees their students' phone numbers on their class roster, and an assistant sees them only when the teacher grants `students.phones`. *(W8d, D-W41: in the teacher's PERSONAL workspaces — whose Students tab already shows the phone the teacher typed — `students.phones` now shows phones on the assistant's workspace rosters. What stays here is the branch half.)*

**Why deferred.** The teacher's own portal shows no student phone today; it searches by phone but never displays one. An assistant is never wider than the teacher (CLAUDE.md rule 6, D-W19). So in W7b `students.phones` stays in the catalogue and reveals nothing, and every assistant roster is names only (decided with the founder). Showing phones to teachers is a product decision about student contact data.

**Depends on.** The decision for teachers first. Then the teacher's roster read, and the assistant's `assistantClassDetail`, select the profile phone only when allowed (`assistantCan(…, "students.phones")` returns true once the equivalent teacher view exists). It is formatted through `lib/phone.ts` and never written to an audit row.

---

## 53. Workspace sessions in the teacher's Sessions list

**What it is.** A premium teacher's PERSONAL-workspace sessions shown in `/teacher/sessions` beside their branch sessions, marked as the workspace's. *(Narrowed at W8d — D-W41 item 8: the **calendar** half is delivered; `/teacher/calendar` reads each owned workspace as a second source, tagged Private.)*

**Why deferred.** The W8d prompt decided the calendar only. The Sessions list has filters (grade, student search, status) and a request form that are branch concepts, and its rows open the branch session page; a workspace row needs its own link and a decision on which filters apply. Each workspace's sessions stay on its own Sessions page meanwhile.

**Depends on.** The calendar's pattern (W8d): `listOwnedWorkspaces` + `getWorkspaceContext` per workspace, the same `teacherSessionListWhere` search under the teacher's history floor, merged in memory; a decision on the filters for a workspace row.

---

## 54. A live conflict preview in workspace forms

**What it is.** The debounced "this clashes with…" preview the branch class and session dialogs show while the teacher types, in the workspace's New class, Add slot, New session and Reschedule forms.

**Why deferred.** The preview action (`checkSlotConflictsAction`) reads the branch context (`getTenantContext("center")`), which a workspace never resolves. In W8a the workspace forms show the server's own refusal list with the same "I understand" tick (`useSlotConflicts(null, state)`), so nothing double-books silently — the teacher just learns of a clash on submit rather than while typing.

**Depends on.** A workspace twin of the preview action that resolves `getWorkspaceContext` and runs the same `findSessionConflicts`.

---

## 55. A grade and subject on a workspace one-time session

**What it is.** The optional grade and subject a branch's one-time session can carry, on a workspace's one-time session.

**Why deferred.** `createOneOffSession` resolves them through the centre's own `CenterCatalogSelection` rows, which a workspace does not have (D-W38: its offered pairs are the whole linked catalogue). W8a's workspace one-time session has a title and a price only.

**Depends on.** The PERSONAL branch of the pair rule (`isWorkspacePairOffered`, W8a) applied in the one-time session writer.

---

## 56. A share code or link to link a workspace student — high priority

**What it is.** A per-profile, single-use code (or a link carrying it) the teacher gives a workspace student in person, which the student redeems from their own account to link the profile — stored as **sha256** like the parent codes (F3) and the assistant codes (W7a), shown once, expiring, rate-limited at redemption.

**Why deferred.** W8b (D-W39) invites by phone only, and the match is `User.phone`. Sign-up never writes `User.phone` and Account settings writes only `contactPhone` (D-02 (a), F2), so a student who registered on their own can never be matched: the invitation reaches only an account a centre created with that phone and that was later claimed. The founder accepted that narrow reach for W8b and asked for this entry, at high priority.

**Depends on.** Nothing new in the model beyond a code table like `FamilyInvitation`; the accept path is W8b's `acceptWorkspaceInvitation` (the profile moved, the placeholder removed when empty), reached by a code instead of a phone match.

---

## 57. Parent visibility of workspace classes

**What it is.** A linked child's private classes and sessions on the parent portal's schedule and calendar.

**Why deferred.** The parent portal reads only `activeChildLinks` at accessible **branches** (`BRANCH_ONLY`), and W8b's opt-in student resolver is the student's own. Showing a teacher's private classes to a parent is a separate consent question the W8b prompt left out.

**Depends on.** A parent-side counterpart of `getStudentScheduleContexts`, and a decision on whether the workspace teacher or the student consents to it.

---

## 58. Editing a workspace student's record after creation

**What it is.** Changing a workspace student's phone (and name or grade) after they were added.

**Why deferred.** The phone is what an invitation matched on; changing it after an invitation exists raises "re-match, cancel, or keep?" questions W8b did not need. The add dialog says the phone cannot be changed later.

**Depends on.** A rule for pending invitations when the phone changes (cancel them, then the 24-hour "Invite again" window), and the centre's local-record editor (`components/center/person-fields.tsx`) reused for the workspace.

---

## 59. Deactivating or removing a workspace student

**What it is.** Taking a student out of a workspace — deactivating the profile (history kept) or deleting one that never attended or paid.

**Why deferred.** W8b adds, invites and enrols; removing a student from a class (REMOVED) covers the day-to-day need. A delete must honour the delete blockers (`studentDeleteBlockers`) and the placeholder's own removal, which waits for attendance and payments in workspaces (W8c).

**Depends on.** W8c (attendance and payments in workspaces), then the centre's deactivate / delete rules applied with `workspaceCan`.

---

## 60. Drop-in attendees in a workspace

**What it is.** Checking in a workspace student who is not enrolled in the session's class — and so any check-in or payment on a workspace **one-time session**, which has no class and therefore no enrolled students.

**Why deferred.** W8c (D-W40 item 4) checks in ACTIVE-enrolled students only, by direct call, so a workspace's roster is exactly its class. Drop-ins raise questions a branch answers with its desk (search, the confirm panel's photo, blocks) that a workspace does not have yet.

**Depends on.** W8c's `workspaceCheckIn` with an `isDropIn: true` branch, a student picker over the workspace's own profiles, and a decision on whether a one-time session lists the whole workspace.

---

## 61. Expenses in a workspace

**What it is.** A teacher recording their own costs (rent, printing) against a workspace, as a branch records expenses.

**Why deferred.** W8c is about money in (payments), not money out; a workspace has no expense categories and no Expenses screen, and the Earnings page (W8d) shows the teacher share collected only.

**Depends on.** The branch expense model (`Expense`, `ExpenseCategory`) under `workspaceCan`, and a place on the Earnings page for "net of expenses".

---

## 62. A refunds report for the workspace teacher

**What it is.** A list of every refund in a workspace over a period — the branches' Refunds page for the teacher.

**Why deferred.** W8c records refunds and shows them on each session's receipt; a period report belongs with the Earnings page and is not in W8d's scope.

**Depends on.** W8d (Earnings), then a scoped `Refund` read per workspace.

---

## 63. Receipts shared with workspace students

**What it is.** A student (or parent) seeing or downloading the receipt of what they paid for a workspace session.

**Why deferred.** D-W40 item 10: a Private class row shows attendance and no money. Showing a student their own payments in a workspace is a separate decision from a branch's, where the past list shows the amount.

**Depends on.** A decision on what a student may see of a workspace's money, and a student-side receipt view.

---

## 64. Payment methods other than Cash in a workspace

**What it is.** InstaPay, Vodafone Cash or a teacher-named method in a workspace, with a picker on the payment form.

**Why deferred.** W8c gives each workspace one hidden "Cash" method (D-W40 item 2) so `recordPayment` has the active method it requires, with nothing to configure. Several methods need a workspace settings screen and the picker.

**Depends on.** `lib/db/payment-methods.ts`'s writers under `workspaceCan`, and the payment form's `PaymentMethodSelector`.

---

## 65. CSV export of the teacher's Earnings

**What it is.** A download of the Earnings page's figures — per source, per class, per week — for the period shown.

**Why deferred.** Out of scope for W8d by decision (D-W41). Export scope for the whole product is still an open decision (OD-4), and a file leaving the server is a new data surface to review.

**Depends on.** OD-4; the same per-source reads (`lib/db/teacher-earnings.ts`), formatted through `lib/format.ts`; the assistant's windows applied identically.

---

## 66. More charts on the Earnings page

**What it is.** Charts beyond the one weekly trend list — by source, by class, attendance over time.

**Why deferred.** D-W41 item 2 allows one small trend, a table or a chart, not both; W8d shipped the list. More visuals need a design pass and the dataviz rules (`04-design-system.md`).

**Depends on.** A chart component that meets §6 (375px, no colour alone) and the same summed reads.

---

## 67. Notices to the teacher about payments

**What it is.** An in-app notice when a payment is recorded, voided or refunded in the teacher's workspace (for example by an assistant), or when a branch settlement is paid.

**Why deferred.** Out of scope for W8d by decision (D-W41). Notices to and about assistants are already deferred (entry 48), and a money notice needs a rate rule so a busy session does not flood the bell.

**Depends on.** The W1 notice kinds (one new kind per event), the audit rows' ids (D-W18), and entry 48's decision on assistant-related notices.

---

## 68. Assistants managing workspace students and classes

**What it is.** An assistant adding or enrolling workspace students, editing classes or sessions for the teacher.

**Why deferred.** D-W41 item 9 limits assistants to check-in, payments and reads in a workspace. Adding a student sends an invitation that names the teacher (D-W27), and editing classes changes money (the price); both widen what an assistant can do beyond the W8d catalogue.

**Depends on.** New catalogue keys (or a decision to reuse `classes.view` / a new `classes.manage`), the W8a/W8b writers taking a `WorkspaceActor` like the W8c ones, and the on-behalf audit (D-W18).

---

## 69. Centre-side visibility of a teacher's workspaces

**What it is.** A branch's staff seeing that a teacher also runs private classes, or their size.

**Why deferred.** D-W20/D-W41: a workspace is private and every centre-side surface spreads `BRANCH_ONLY`. Showing any of it to a centre is a product and privacy decision, not a missing feature.

**Depends on.** A founder decision on what (if anything) a centre may see, and the teacher's consent.

---

## 70. Earnings forecasts

**What it is.** Projected earnings from upcoming sessions and enrolments.

**Why deferred.** Out of scope for W8d by decision (D-W41). A forecast is computed from current prices, which the money rules keep strictly apart from frozen snapshots (CLAUDE.md rule 2); it must never be confused with collected money.

**Depends on.** A design that labels it as an estimate, never sums it with collected figures, and reads prices only for sessions with no payment.

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
