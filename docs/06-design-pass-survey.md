# KayEdu — Design pass survey (R10a)

> Written **before** any R10a code change, from the code as it stood at `c27448c` — not from the docs. Each entry says what was wrong visually and, in the last line, what R10a did about it. Entries marked **R10b** belong to the second design pass (add-student / add-teacher dialogs and the class, session, teacher and student detail pages). Their "wrong now" text was written **before** any R10b code change, from the code as it stood at `ea7f645`; the closing **R10b:** line of each was added when the pass was done.
>
> `npm run check:design` asserts that every `page.tsx` under `app/[locale]` has an entry here.

## What the survey found overall

Several things the R10a brief lists as broken had **already been fixed** by earlier presentation work, and were confirmed fixed rather than redone:

| Brief's known problem | State at `c27448c` |
|---|---|
| Analytics filter bar: raw native `<select>` | **Already fixed** — `TeacherFilter` used the shared `Select`. |
| Analytics filter bar: three date affordances | **Already fixed** — one `DateFilter` trigger. (Its label was inline, though, so the bar had no shared baseline — see below.) |
| Orphaned KPI row | **Partly** — `StatGrid` chose columns per count, but a **3-card row left one tile alone on its second line at 640–1023px** (`sm:2 → lg:3`), and the 5-card row did the same at `lg`. This is the orphan. |
| Weak login / register | **Partly** — a two-column layout and `Field`s existed; no password toggle, cards drew their own padding, and the four auth screens each hand-rolled a different `Card`. |
| Bare Approvals empty state | **Partly** — an icon/title/hint existed, but no way forward from it. |

And things that were genuinely wrong:

1. **The language control was a two-segment track** (`LocaleSwitcher`), and its links were `href={pathname}` — **the query string was dropped on every switch**. A filtered Analytics view or a `?next=` return path was lost.
2. **Three places hand-drew a centre initial with `name.trim().charAt(0)`** (teacher dashboard, teacher "Find a branch" card, admin centres grid) — the exact bug `lib/initials.ts` was written to fix. They disagreed with the sidebar for any centre named `مركز …` / "… Academy".
3. **Semantic colours used as decoration**: `StatCard accent="success|warning|danger|info"` painted a green/amber/red/blue top border on "Live now", "Not started", "Expenses", teacher KPIs, etc.
4. **Double padding**: `Card` already pads 16px top and bottom, and ten `CardContent className="… pt-6"` added 24px more — the "large gap" between a card border and its first row (dashboard Today's sessions, Analytics tables, admin, teacher settlements, student reservations).
5. **Nine copies** of the list-header `<li>` class string, drifting.
6. **One disabled nav item with a "Soon" badge** (`/teacher/analytics`).
7. **Bare muted-text empty states** in six places (`<p className="text-sm text-text-muted">`).
8. **Unstyled header links**: the dashboard's "View all sessions" and the admin centres grid's "Open" were bare `text-brand hover:underline` links floating in a header.
9. **Sidebar had no sections** — twelve items in one run — and the mobile drawer had a blank row above the brand with a loose close button.
10. Two scrims hand-coloured with `bg-slate-900/50` instead of the sidebar token.

A note on the sidebar-initial complaint: the sidebar, the header label and the branch switcher **already take the same `brand.name`**, and the avatar is the shared `BrandAvatar`. The initial skips a leading generic word (`مركز`, "Academy") **by recorded design** (`lib/initials.ts`, docs/04 §5 "Avatar"). The screens that really disagreed were the three `charAt(0)` ones above — fixed, and gated.

---

## Shell (not a page)

### `components/shell/app-shell.tsx` (sidebar, header, drawer)
Twelve nav items with no grouping; drawer opened on an empty row with a detached close button; header carried `LocaleSwitcher` (segmented track, query lost). **R10a:** nav grouped (Front desk / Academics / Money) with headings, hairlines on the icon rail; close button moved onto the brand row; `LocaleToggle`; scrim on the sidebar token.

**T1:** the nav list wears `scrollbar-sidebar`; the header's start cluster (toggle, switcher) sits at the main column's start edge instead of centred on `content-shell`; under Whole Management the brand and the switcher name the organization (`brandFromRollup`), Reception / Sessions / Approvals render as `RollupNavItem`, and `RollupNotice` names the branch whose data a page shows. See 04 §11.1, §14.3. **T6:** every item but Analytics is a `RollupNavItem`, `RollupNotice` is removed, and every centre page but Analytics renders `PickBranchScreen` under a roll-up (04 §11.1).

**F2:** the user menu gains **Account settings** (a `UserCog` row, 44px, above Sign out) in every experience. Each experience's shell data moved out of its layout into a frame builder (`(group)/*-shell.ts(x)`: `centerShell()` …); the layout and `/account` both render `<AppShell {...frame.props}>`, so the account page wears the shell of the experience it was opened from.

### `components/shell/nav.ts` / `nav-item.tsx`
`teacher/analytics` was `disabled: true` with a "Soon" pill. **R10a:** removed (see "Removed nav items" in the R10a summary).

---

## Auth (route group `(auth)`)

### `app/[locale]/(auth)/login/page.tsx`
Own `Card` with `p-2 sm:p-4` plus `CardHeader` — heading was 20px, spacing different from register. No password toggle (in the form). **R10a:** `AuthCard`, `PasswordField`, divider above the register link.

### `app/[locale]/(auth)/register/page.tsx`
Same as login; two password fields with no visibility toggle. **R10a:** `AuthCard`, `PasswordField` ×2.
**F4:** the form opens with **I'm joining as** — three radio cards (Student / Parent / Teacher, required; Parent pre-ticked from a join link) — above the name fields; one column on a phone, three from `sm` (docs/04 §11.23).
**T7:** the optional **Phone** field is gone (it was stored nowhere and matched nowhere since F3); the form is intent, name, email, password, confirm password. A contact phone lives only in Account settings.

### `app/[locale]/(auth)/invite/[token]/page.tsx`
Two hand-built `Card`s (invalid / valid) with a third spacing. **R10a:** both on `AuthCard`.

### `app/[locale]/(auth)/account-pending/page.tsx`
**SEC-2a (new).** Where a login with no app user yet lands — a pending account claim, an unconfirmed email, or an email held by another account. Built on `AuthCard` like its siblings: the heading and description name the reason, an amber notice says what to do next, and a full-width-on-phone outline Sign out button. Nothing on it names the matched record.

### `app/[locale]/(auth)/family/join/page.tsx`
**F3 (new).** Where a parent accepts a code; open to guests. `AuthCard` (title "Link your child", one-line description), then "Signed in as {name}" when signed in, the code field (LTR, monospaced, upper-case, `one-time-code` autofill, hint "Capitals and the dash don't matter") and **Link my child** (full width on a phone, `w-fit` from `sm`). A guest gets an info notice and **Sign in** / **Create a parent account** instead of the submit, both returning here with the code kept in the tab. A signed-in student account gets the refusal up front, with Sign out. A refusal is a `FormMessage` above the field; success toasts and lands on the parent portal.

### `app/[locale]/(auth)/select-center/page.tsx`
Branch cards had hover but **no selected state** — the branch you are already in looked like the others — and the "Whole Management" card was always brand-tinted, even when not selected. **R10a:** `AuthCard`; the active branch/roll-up gets a brand outline, tint and a check (not colour alone); idle cards share one hover state.
**F3:** the empty state gains a third start, **I'm a parent: link my child** (to `/family/join`); a staff member or teacher who is also a parent gets a ghost **Your children (parent view)** link under their branches.
**F4:** the three starts are ordered by the person's sign-up intent (theirs first and highlighted); no intent keeps the old order and emphasis.

---

## Account (every experience)

### `app/[locale]/account/page.tsx`
**F2 (new).** Account settings, reached from the user menu (and the branch hub) by every signed-in role, rendered inside the shell of the experience it was opened from (`?from=`). `PageHeader`, then two `PageSection`s: **Profile** — one card (first/last name side by side from `sm`, contact phone LTR with its hint, preferred-language `Select`) and, below it, one read-only card per branch record ("How {branch} has you on file": role, local name, phone, "Ask the branch to update this"), two columns from `md`; **Sign-in & security** — Email and Password cards, side by side from `lg`, stacked below. Email shows the current address LTR and is read-only with an info notice until the override or confirmation is on. Password uses `PasswordField` ×3 and a `Checkbox` "Sign out other devices", ticked by default, in a 44px label row. Two named extension points between the sections render nothing until F3/F4 fill them.

**F4 (new section):** Account → **Study details** (a `PageSection` between Profile and Family, only for a student account): one card with the education-system → grade picker, a muted note that a branch's record is never changed, and **Save**.

---

## Center experience (route group `(center)`)

### `app/[locale]/(center)/dashboard/page.tsx`
"Live now" (green), "Not started" (amber), "Collected today" (blue) tiles wore semantic top borders; the Today's-sessions card stacked 24px `pt-6` on 16px card padding, and its mobile rows were bordered boxes inside a bordered card; "View all sessions" was a bare link; the money row could be a lone full-width tile. **R10a:** neutral tiles; card owns no vertical padding, rows own 12px and are separated by hairlines; ghost `LinkButton`; empty state with next action kept; grids fill evenly.

### `app/[locale]/(center)/analytics/page.tsx`
Filter bar: date control and teacher select had **different label treatment** (date inline in the trigger, teacher visually hidden), so they shared no baseline; Reset floated; `pt-6` gaps on the table cards; accent borders on KPIs. **R10a:** `FilterBar` + labelled `FilterField`s, the date control is the only date affordance, KPI cards neutral, table cards even. Tables were already stacked cards below `md`.

### `app/[locale]/(center)/approvals/page.tsx`
Empty state: icon + title + hint but **no action**; Approve/Decline buttons were different widths (text length) and right-aligned on mobile. **R10a:** empty state links to Teachers; the two actions are equal-width in a two-column grid, full-width below `lg`.

### `app/[locale]/(center)/students/page.tsx`
Header, filter, list and empty states already on the shared parts; hand-copied list-header row. **R10a:** `ListHeader`.

**F4:** the Promote card is gone — a **Promote students** button joins Add student in the header (stacked on a phone); an amber **undo banner** names the latest promotion while it can be undone; a **Grade differs from account** pill filter sits beside the search (`SoftLink`, 44px).

### `app/[locale]/(center)/students/promote/page.tsx`
**F4 (new).** Promote students (docs/04 §11.23): `PageHeader` with a back link; **Choose the grades** (From, To and Preview in one `FilterBar`; nothing pre-selected for To); **Preview** (search, Select all / none, a ≥56px checkbox row per student with the code, name, an amber "Account says" badge and "Enrolment is kept", one confirm button that names the count); **Promotion history** (a bordered row per batch with an **Undo** on the latest open one). Stacked below `md`.

### `app/[locale]/(center)/teachers/page.tsx`
As students. **R10a:** `ListHeader`.

### `app/[locale]/(center)/classes/page.tsx`
Filters were a `grid sm:grid-cols-3` of hand-labelled selects; hand-copied list-header row. **R10a:** `FilterField`, `ListHeader`.

### `app/[locale]/(center)/sessions/page.tsx`
"Live now" (green) and "Collected" (blue) KPI borders; hand-labelled filter grid; hand-copied list header. **R10a:** neutral KPIs, `FilterBar`/`FilterField`, `ListHeader`.

### `app/[locale]/(center)/expenses/page.tsx`
**SEC-2b (D-24):** Delete is gone — "Void" opens an inline reason field (required) and a destructive confirm; a voided row stays in the list struck through with a red "Voided" badge and a "Voided by … · time · reason" line under it, and leaves both totals.
Red "Total" KPI border (money going out is not an error); the date filter sat in a bare `<form>`; hand-copied list header. **R10a:** neutral KPI, `FilterBar`, `ListHeader`.

**DES (Phase 3):** the add form checks the action's own schema before posting, opens with an error summary at two or more field errors, and toasts "Expense added"; voiding toasts too (docs/04 §14.2).

### `app/[locale]/(center)/settlements/page.tsx`
**SEC-2b (D-12, D-16):** a DRAFT gets a ghost "Cancel draft" beside Approve; CANCELLED has a red badge; a settlement the viewer created (and the viewer is not an OWNER) shows no Approve/Mark-paid buttons, only a muted line saying another manager or the owner must do it.
"No teachers" was a bare muted sentence in a card. **R10a:** compact `EmptyState`.

### `app/[locale]/(center)/refunds/page.tsx`
Consistent (PageHeader, card, empty state, bordered rows). No change.

### `app/[locale]/(center)/audit/page.tsx`
**SEC-2b (new, D-06).** The centre audit trail, `audit.view` only, reached from the Dashboard and Analytics headers (not the nav — `check:permissions` pins each role's nav list; adding it there is a one-line change awaiting a decision). `PageHeader`, then a row of filter pills — Everything, Voids, Switched to absent, Refunds, Settlements, Price and cut changes, Present-not-paid — each a link with a 44 px touch height and `aria-current` on the active one, wrapping at 375 px. Every row is a stacked card at every width (nothing scrolls sideways): action, amount on the end side, "time · actor", the person it concerns, the reason, the before → after of any price/cut/status field, and an "Open the session" link. An OWNER's self-approved settlement carries an amber badge. Paged at 50.

### `app/[locale]/(center)/reception/page.tsx`
Page chrome already on the shared parts. Its "Recent check-ins" panel showed a bare muted sentence when empty. **R10a:** compact `EmptyState` there (`recent-check-ins.tsx`). Filter chips already use the single brand selected state.

### `app/[locale]/(center)/settings/page.tsx` (General)
Section header under the settings layout's `PageHeader`; consistent. No change.

**DES:** the result is said once, in the sticky save bar — no second toast; client validation with the action's schema and an error summary (docs/04 §14.2, §14.8).

### `app/[locale]/(center)/settings/payment-methods/page.tsx`
Consistent (`EntityManager`). **R10a:** its list header uses `ListHeader` via the manager. **T1:** the manager's rows are the shared settings-list layout (04 §14.8) — Status in its own column, the Actions header over its buttons.

### `app/[locale]/(center)/settings/rooms/page.tsx`
**T3:** the separate "Rooms that can be combined" card and its "needs two rooms" note are gone; the list is `rooms-manager.tsx` (Add room button, shared settings list with a "Combines with" column) and add/edit are one dialog that carries "Can be combined with" (chips + checklist, 04 §11.12). **T1:** the Status badge was hidden under the Edit button and the Actions header did not line up with the buttons; the rooms list is now the shared settings-list layout (04 §14.8).

### `app/[locale]/(center)/settings/terms/page.tsx`
Consistent (`EntityManager`). **T1:** shared settings-list layout (04 §14.8) — same fix as Rooms.

### `app/[locale]/(center)/settings/catalog/page.tsx`
Page stack used `gap-8` where every other settings page uses `gap-6`. **R10a:** `gap-6`. **T1:** each section's rows are the shared settings-list layout with a header (Name, Details when there is a price or a parent, Status, Actions); the retired badge sits under Active in the Status column; Edit / Deactivate / Remove in that order.

### `app/[locale]/(center)/settings/card/page.tsx`
Consistent header; the editor itself is a canvas tool (R9) — no change.

### `app/[locale]/(center)/settings/branding/page.tsx`
**F8:** new. `SectionHeader` + one card: the branch's current mark (`BrandAvatar`), a file field with hint, Upload (full-width on a phone), and a confirmed Remove. Stacked at 375, same at 1280.

### `app/[locale]/(center)/settings/permissions/page.tsx`
Consistent; matrix already collapses to cards below `md`. No change.

### `app/[locale]/(center)/settings/staff/page.tsx`
Hand-copied list header. **R10a:** `ListHeader`. **T1:** the members list is the shared settings-list layout (name + email, role, Status, one-button Actions); invitations keep their own rows (no status).

**DES (Phase 3):** revoking an invitation and granting or removing branch access return a result and toast it (`staff-result-actions.tsx`) — they had been silent `void` actions; role and access changes toast; the invitation link is `CopyLinkField`, which says when a copy is refused (docs/04 §14.2).

**F1:** with more than one branch where the Owner may invite, the invite form opens with a **Branch** select (default: the active branch); an invitation for another branch confirms with that branch's name. Hidden for a one-branch Owner.

### `app/[locale]/(center)/settings/branches/page.tsx` — **F1, removed at U5**
**Removed at U5** (only KayEdu manages branches — the admin's tools are on `/admin/centers/[id]` and `/admin/organizations/[id]`, `04-design-system.md` §11.21). The F1 entry, kept as the record: New. OWNER only (`organization.branch.create`). A usage card ("2 of 3 branches used") holding **Add branch** — disabled at the limit, with the reason under it — and the branch list (name, English name, "You're here", lifecycle badge; a card per branch below `md`). The Add branch dialog is the shared `DialogShell`: Branch (Arabic name, English name, timezone), Theme colour (native picker + swatches, 44px), Copy setup (source select + six ticks, all on, and a "never copied" note); a full-screen sheet on a phone.

### `app/[locale]/(center)/classes/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header's action slot is a loose flex row holding the Edit dialog button, an Active badge and the "All classes" link — three different heights and three different jobs, so the one verb on the page does not read as an action bar. The body is `xl:grid-cols-2` over a `display: contents` wrapper, so three cards of very different heights (key facts, the weekly-schedule builder, sessions) are dealt into two columns by the browser: the schedule builder is a tall card beside a 3-row facts card, leaving a blank block under it. Below `xl` (1024–1279px — a laptop with the sidebar open) it is a single column of full-width, mostly-empty cards. The roster, the most-used part of the page, is a full-width card *below* both. There is no upcoming-sessions list and no centre-cut figure on the page today, and the kept-sessions warning is buried inside the "Sessions" card.
**R10b:** header with the period and rooms and **Edit class** as its action bar; the kept-sessions warning is a full-width amber panel directly under the header; `DetailLayout` — schedule and roster in `main`, Key facts and Sessions in a sticky `side` (the roster is no longer a separate full-width row). Not added: an upcoming-sessions list and a requests/approvals card (no such data on the page today — see the R10b entry in 03).

### `app/[locale]/(center)/sessions/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the session's verbs (Reschedule · Edit rooms · Cancel · Delete) are in an `ActionBar` **at the bottom of the side column's facts card** — below the date/time/room/seats/price rows, far from the title and, on a phone, below the entire roster. The header's own action slot holds only badges and the "All sessions" link, in a loose row. End session is a separate strip between header and body, with its hint left and the button right, in its own bordered box. The two columns are `3fr/2fr` from `xl` only; the receipt card moves above/below the facts card depending on `closed`, so the side column's order changes with state. The roster card is tall while the side stack has no matching rhythm (facts card is short, receipt card is long) — the columns end at unrelated heights. The closed banner is correct (R2) and stays.
**T7:** the "Booked — not arrived (n)" list gains an outlined **Cancel booking** beside Check in (`approvals.manage`; asks first; full width below `sm`; docs/04 §11.25).
**R10b:** all five verbs (End session, Reschedule, Edit rooms, Cancel, Delete) are one `ActionBar inHeader` under the title, each behind the same condition as before (none once closed/cancelled/rescheduled, none without the permission — and no empty bar then); the End-session and Delete hints are muted text under the header; badges, time and rooms are the header's `meta`; the roster is `main`, the details and receipt are a sticky `side` (receipt first once closed, as R2 had it).

**SEC-2b (D-06, D-13, D-26, SEC-19):** the receipt adds a "Payments" count, "Refunded (n) −amount", a red "Voided — not counted (n)" row and an amber "Present or late without a payment" row, then named sections — present-but-unpaid students, voided payments (amount, who, when, why, on a red tint), refunds — each absent when empty; the same receipt prints and shows on the teacher's session page and in the reception dialog. A session priced at 0 gets an amber "Free session" badge in the header and on the receipt. The roster's "Mark absent and void payment" dialog now requires its reason (field marked required, the server's refusal shown under it). The New session dialog, at a price of 0, shows an amber tick box "I understand this session is free" that the server requires.

### `app/[locale]/(center)/teachers/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header is title + "Active" badge + back link in one loose row, with no initial or avatar. The main column is a single tall **edit form** card whose footer carries *Save* and, on the far side, *Delete* (a destructive button sharing a row with the primary action). The "trusted teacher" switch sits inside that same form between the fields and the buttons. The side column is two small cards (identity/rating, classes) — so under the form there is a large blank area at 1280px whenever the form is taller than them, and the block-list is a full-width card below both with its own search. The identity card is titled for a concept (`identityTitle`) the user does not recognise and carries a 'claimed account' row. There is no list of upcoming/recent sessions or of the teacher's students on the page today.
**R10b:** header with a first-letter avatar, the Active badge and the phone; `main` is one grouped record form (person · branch settings, one Save) and the classes taught; `side` is the rating/account card and the block list (candidate rows stack in the narrow column); Delete is a danger zone at the foot, behind `teacher.delete`. No other-centre data is read or shown (security fix 16).

### `app/[locale]/(center)/students/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header mixes the student code, the Active badge and a back link in one row, with no photo or initial (the photo lives in its own card two screens down). The left column is one tall edit-form card (person, contact, grade, four parent fields, Save and — beside it — Delete); the right column is **four** stacked cards (ID card, photo, parent summary, parent links) that are much taller than the form, so the form card ends and the left column is blank for hundreds of pixels. Enrolments and "blocked by" are a separate two-up row below, at `lg`, while the rest is `xl` — two different breakpoints for one page. The parent summary card repeats the parent fields the form above it already edits. The ID-card actions are three differently-shaped buttons in a wrapping row. There is no attendance or payment history on the page today.
**R10b:** header with the photo (a signed URL) or first letter, code, Active and grade, and **Print ID card / Print paper form** as its action bar; `main` is the record (person · grade · parent contact, one Save), enrolments with the absence-streak alerts, and "blocked by"; `side` is the ID card (preview and the stored-card control), photo, parent summary and parent links (with the placeholder verify, behind `parent.link.manage`); Delete is a danger zone at the foot. The columns now end within a card of each other at 1280px. Not added: attendance/payment history (no data on the page today).
**F3:** the "Parent accounts" card (pending phone matches and a disabled Verify) is replaced by **Parent access** (docs/04 §11.22): one bordered row per active parent account — account name, a neutral "how linked" badge, the date, and the parent the student declared when there is one — with **Remove access** (an inline reason panel) per row; the slot count; an info notice for this branch's waiting code (its hint in an LTR run); **Generate parent code** / **Replace the code** and **Cancel code**. Without `parent.link.manage` the list shows with a muted "ask a manager" line and no controls.

**F4:** when the student's own account names a different grade, the header meta gains an amber **Account says: {grade}** badge with a **Use account grade** button (hidden, with a note, when the branch does not offer that grade).

**DES (Phase 3):** removing the photo confirms first (it deletes the file); photo save/remove toast.

### Add student and Add teacher dialogs (`students/add-student-dialog.tsx`, `teachers/add-teacher-dialog.tsx`) — **R10b**
*Wrong now (at `ea7f645`):* both open the **old narrow `Dialog`** (`max-w-lg`) — not the R6 `DialogShell` the class and session dialogs use — so there is no sticky header/footer, no Cancel, and the submit button is the last thing at the bottom of a long, scrolling single column. The structure is one undifferentiated stack: a grey "look up by phone" box, a section heading, names (2-up), then email / phone / alt-phone (2-up, in that order, so the *real* phone is the second control after the lookup's own phone box), then — for a student — grade and four parent fields in **one** 2-up grid with no grouping. The duplicate-match panel (`MatchPanel`) renders **after** all of that, next to the submit button, a screenful away from the phone that caused it; its "Link to this person…" button is the same default button as the dialog's own submit. Both forms submit through `<form action>`, which React 19 resets after the action returns — so a failed or "match found" submit clears what was typed. The student form offers no photo (the create action has none; the upload lives on the student page) and says nothing about it.
**R10b:** both are the `DialogShell` mounted by `DialogLauncher` (wide, sticky header and footer, Cancel + primary, full-screen sheet below `sm`); sections are `FormSection` cards — Person · Grade · Parent contact · Photo (a note) for a student, one Person card for a teacher; the phone leads, and the match panel is a full-width row directly under it, with **Use this person** as its own solid button while the dialog's primary is held back; both forms submit through `startTransition`, so a refused or "match found" submit keeps what was typed. The phone lookup's controls are 44px.

---

## Teacher experience (route group `(teacher)`)

### `app/[locale]/(teacher)/teacher/dashboard/page.tsx`
Hand-drawn `charAt(0)` initial per centre; 5-card KPI row stranded two tiles at `lg`; blue/brand/amber KPI borders. **R10a:** `BrandAvatar`; five-up grid built on a six-column track; neutral KPIs.

### `app/[locale]/(teacher)/teacher/sessions/page.tsx`
Blue KPI border; hand-labelled filter grid (in `session-filters.tsx`). **R10a:** neutral KPI, `FilterField`. (Its forward-looking day/week/month filter stays bespoke — docs/04 §11.7.)

**DES:** "Request a new session" is a closed disclosure above the list (docs/04 §14.9); Arabic counts in Arabic-Indic digits with proper plural forms.

### `app/[locale]/(teacher)/teacher/calendar/page.tsx` — **U7 (new)**
The teacher's month calendar on the shared `SessionCalendar` (docs/04 §11.28): Held green, Upcoming blue, Cancelled grey, a legend, and the tapped day's sessions below with a text badge, branch (under All branches), room, present/late/absent counts and a link to each session. A Branch filter under All branches. Dots only at 375px, 44px day targets.

### `app/[locale]/(teacher)/teacher/students/page.tsx`
Consistent. No change.

### `app/[locale]/(teacher)/teacher/classes/page.tsx`
Consistent. No change.

### `app/[locale]/(teacher)/teacher/approvals/page.tsx`
Decline/Approve buttons unequal. **R10a:** equal-width pair (shared pattern with the centre queue).

### `app/[locale]/(teacher)/teacher/settlements/page.tsx`
`CardContent … pt-6` double padding. **R10a:** removed.

### `app/[locale]/(teacher)/teacher/centers/page.tsx`
`pt-6` on the empty-state card; each "teach here" card drew its own `charAt(0)` initial. **R10a:** both fixed (`teach-at-center-card.tsx`).

### `app/[locale]/(teacher)/teacher/sessions/[id]/page.tsx` — **R10b**
Teacher session detail. Marked R10b but not among the four centre detail pages this pass covered — not touched.
**T7:** a "Booked — not arrived (n)" card appears under the roster when students booked this session online and have not arrived (name, code LTR, Booked badge, and for `reservation.manage.own` the same **Cancel booking** button as the centre page, pinned to the teacher's own classes); nothing else on the page changed.

### `app/[locale]/(teacher)/teacher/students/[id]/page.tsx` — **R10b**
Teacher view of a student. Marked R10b but not among the four centre detail pages this pass covered — not touched.

---

## Student experience (route group `(student)`)

### `app/[locale]/(student)/student/schedule/page.tsx`
Consistent. No change.
**T7:** booked single sessions join the upcoming list with a **Booked** (`info`) or **Requested** (`warning`) badge in place of "Upcoming"; the header description says so (docs/04 §11.25).

**DES:** upcoming sessions show eight, then "Show N more" (`CappedList`, docs/04 §14.9).

### `app/[locale]/(student)/student/calendar/page.tsx` — **U7 (new)**
The student's month calendar on the shared `SessionCalendar` (docs/04 §11.28) across every branch: Present green, Late amber, Absent red, Upcoming blue, Booked blue ring, Requested dashed amber, Cancelled grey struck through; a legend; the tapped day's sessions below, each with a text badge, its branch and room. No branch switcher anywhere in the student shell (U7).

### `app/[locale]/(student)/student/discover/page.tsx`
Filter labels hand-built (in `discover-filters.tsx`). **R10a:** `FilterField`. The class card's subject-accent top border is the documented rotating subject palette (docs/04 §2), not a status colour.
**F4:** the grade filter is pre-selected from the student's account grade; its "All" option posts the explicit `all` when a grade is pre-selected.

**DES:** "Request to join" is the outlined brand button with a spinner. Still one long column on a phone — capping a browse surface is a product call — **OD-13** (docs/00 §2.2), not guessed.

**F5:** the card is the shared `ClassCard` (`components/explore/class-card.tsx`) that Explore also renders; its subject name links to the Discover class page.

### `app/[locale]/(student)/student/discover/[centerId]/[classId]/page.tsx` — **F5 (new)**
A Discover class on the shared `ClassDetail` (the Explore class page's body) under Discover's own rules — any accessible branch, blocks hide it — with the student's own status and the same `ReserveButton`. `PageHeader` with a back link to Discover.

### `app/[locale]/(student)/student/reservations/page.tsx`
`CardContent … pt-6` double padding. **R10a:** removed.

### `app/[locale]/(student)/student/onboarding/page.tsx`
**F4 (new).** Your studies (docs/04 §11.23): `PageHeader`, then one `max-w-xl` card per step — the grade picker and **Continue**, then (where a parent slot is free) the Invite a parent form with **Skip for now**, then the one-time code reveal and **Find classes**. Part of the student portal; the sidebar stays; nothing is gated behind it.

### `app/[locale]/(student)/student/profile/page.tsx`
Redirect only. No change.

---

## Parent experience (route group `(parent)`)

### `app/[locale]/(parent)/parent/page.tsx`
**T7:** the selected child's booked and requested single sessions appear in Upcoming with the same Booked / Requested badges (read-only, through the same reads as the student schedule).
"No children linked" was a bare muted sentence in a padded card. **R10a:** `EmptyState`.
**F3:** zero linked children → a card with the info `EmptyState` "No child linked yet" whose action is a code field + **Continue** (it writes nothing — it carries the code to `/family/join` in the URL fragment) and the "where to get a code" line under it. Linked children at no branch yet → an info `EmptyState` naming them. Otherwise as before, with a ghost **Link another child** (to Account → Family) as the header action and an info line naming any linked child who has not joined a branch.

### `app/[locale]/(parent)/parent/calendar/page.tsx` — **U7 (new)**
The selected child's month calendar, read-only, on the shared `SessionCalendar` — the same colours, legend and day list as the student's own. The child selector above it (`?child=`, kept while moving between months); no child at a branch → an info `EmptyState` with a link back to the parent portal.

---

**DES:** upcoming sessions capped at eight with "Show N more" (`CappedList`).

## Platform admin (route group `(admin)`)

### `app/[locale]/(admin)/admin/centers/page.tsx`
Initial drawn with `charAt(0)` and a hard-coded `text-white` on an inline colour; "Open" a bare link; empty state was an info banner. **R10a:** `BrandAvatar`, outline `LinkButton`, `EmptyState`.
**F1:** the header gains an outline **Centers & branch limits** button (to `/admin/organizations`); the Create form opens with a **New center / Add to an existing center** segmented control — New adds the center name, English name and branch limit above the branch fields, Existing swaps them for a searchable center pick (usage on each row) and drops the owner email (docs/04 §11.21).

### `app/[locale]/(admin)/admin/centers/[id]/page.tsx`
`pt-6` double padding on three cards. **R10a:** removed.

### `app/[locale]/(admin)/admin/organizations/page.tsx` — **F1**
New, reached from the **Centers & branch limits** button in `/admin/centers`' header (no sidebar item). `PageHeader` with a back link; one card per organization (avatar, name, a "2 of 3 branches" badge — warning only when full — and an archived note); one column on a phone, two from `md`, three from `xl`.

### `app/[locale]/(admin)/admin/organizations/[id]/page.tsx` — **F1**
New. `PageHeader` (back to the list, the usage badge as meta), the **Branch limit** editor (a number field with the "lowering only stops new branches" hint, Save beside it from `sm`), and a card per branch — lifecycle badge, slug, staff/teacher/student counts, **Open** to its `/admin/centers/[id]` support view.

### `app/[locale]/(admin)/admin/platform/page.tsx`
`pt-6`; a "brand" KPI border. **R10a:** both removed.

### `app/[locale]/(admin)/admin/catalog/page.tsx`
Consistent. No change.

---

## Other

### `app/[locale]/page.tsx`
Entry redirect. No UI. **DES:** signed out it is now the public landing — the public header (product mark + language toggle), the product name as `h1`, one plain line, Sign in / Create an account; a signed-in visitor is redirected home exactly as before (docs/04 §12). **F5:** the landing is gone — signed out, `/` redirects to Explore; signed in, unchanged.

---

## Public (route group `(public)`, F5)

Every page renders inside `PublicShell` (`components/explore/public-shell.tsx`: mark, Explore, language toggle, Sign in / Create account or Go to my dashboard; two rows below `sm`) and opens with `PageHeader`. Reads come only from `lib/db/public-catalog.ts` (`check:public`).

### `app/[locale]/(public)/explore/page.tsx` — **F5 (new)**
Branches / Classes as two `SoftLink` pills (the Audit tab pattern). Branches: a card grid of `BrandAvatar` + name, 12 per page. Classes: the shared Discover filters (subject / grade / day) and `ClassCard`s, 20 per page. Both through `Pagination` + `ResultsRegion` (T4).

### `app/[locale]/(public)/explore/[slug]/page.tsx` — **F5 (new)**
`PageHeader` with the branch logo as `leading` and a back link to Explore; classes (two-up from `md`, 20 per page) beside a Teachers card (44px rows, average rating only) that drops below on a phone.

### `app/[locale]/(public)/explore/[slug]/classes/[classId]/page.tsx` — **F5 (new)**
`ClassDetail`: an "About this class" fact list (branch, teacher, grade, period, weekly schedule) and a "Join this class" card (price per session, a seat badge — Open / Few seats left / Full, never a number — and Enrol / Request to join). Stacks to one column below `lg`.

### `app/[locale]/(public)/explore/[slug]/teachers/[teacherUserId]/page.tsx` — **F5 (new)**
`PageHeader` with an initial avatar and the rating as a neutral badge in `meta` (omitted when none); the teacher's classes at this branch as `ClassCard`s.

### `app/[locale]/[...rest]/page.tsx` — **DES (new)**
The unknown-path catch-all: it calls `notFound()`, so an unknown URL renders the bilingual `app/[locale]/not-found.tsx` instead of Next's bare English default page. Renders nothing itself.

### `app/[locale]/(print)/sessions/[id]/print/page.tsx`
Print sheet — outside the shell by design. No change.

**DES:** the shared `PrintToolbar` (`components/shared/print-toolbar.tsx`); the roster prints as a sorted table (docs/04 §14.10).

### `app/[locale]/(print)/students/[id]/card/page.tsx`
Print sheet. No change.

**DES:** the shared `PrintToolbar`, with a card-specific hint (card size, card paper, no margins).

### `app/[locale]/(print)/students/[id]/paper/page.tsx`
Print sheet. No change.

**DES:** the shared `PrintToolbar`; labels stack over values (`DetailRow stacked`); the card prints at true size.

### `app/[locale]/(print)/teacher/sessions/[id]/print/page.tsx`
Print sheet. No change.

**DES:** its own toolbar is deleted for the shared `PrintToolbar`; the sheet sorts the roster itself, so this print is no longer unsorted.

### `app/[locale]/not-found.tsx` (not a `page.tsx`)
Carried its own copy of the locale switch. **R10a:** `LocaleToggle`.
