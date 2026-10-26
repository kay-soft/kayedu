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

**T1:** the nav list wears `scrollbar-sidebar`; the header's start cluster (toggle, switcher) sits at the main column's start edge instead of centred on `content-shell`; under Whole Management the brand and the switcher name the organization (`brandFromRollup`), Reception / Sessions / Approvals render as `RollupNavItem`, and `RollupNotice` names the branch whose data a page shows. See 04 §11.1, §14.3.

### `components/shell/nav.ts` / `nav-item.tsx`
`teacher/analytics` was `disabled: true` with a "Soon" pill. **R10a:** removed (see "Removed nav items" in the R10a summary).

---

## Auth (route group `(auth)`)

### `app/[locale]/(auth)/login/page.tsx`
Own `Card` with `p-2 sm:p-4` plus `CardHeader` — heading was 20px, spacing different from register. No password toggle (in the form). **R10a:** `AuthCard`, `PasswordField`, divider above the register link.

### `app/[locale]/(auth)/register/page.tsx`
Same as login; two password fields with no visibility toggle. **R10a:** `AuthCard`, `PasswordField` ×2.

### `app/[locale]/(auth)/invite/[token]/page.tsx`
Two hand-built `Card`s (invalid / valid) with a third spacing. **R10a:** both on `AuthCard`.

### `app/[locale]/(auth)/account-pending/page.tsx`
**SEC-2a (new).** Where a login with no app user yet lands — a pending account claim, an unconfirmed email, or an email held by another account. Built on `AuthCard` like its siblings: the heading and description name the reason, an amber notice says what to do next, and a full-width-on-phone outline Sign out button. Nothing on it names the matched record.

### `app/[locale]/(auth)/select-center/page.tsx`
Branch cards had hover but **no selected state** — the branch you are already in looked like the others — and the "Whole Management" card was always brand-tinted, even when not selected. **R10a:** `AuthCard`; the active branch/roll-up gets a brand outline, tint and a check (not colour alone); idle cards share one hover state.

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

### `app/[locale]/(center)/settings/permissions/page.tsx`
Consistent; matrix already collapses to cards below `md`. No change.

### `app/[locale]/(center)/settings/staff/page.tsx`
Hand-copied list header. **R10a:** `ListHeader`. **T1:** the members list is the shared settings-list layout (name + email, role, Status, one-button Actions); invitations keep their own rows (no status).

**DES (Phase 3):** revoking an invitation and granting or removing branch access return a result and toast it (`staff-result-actions.tsx`) — they had been silent `void` actions; role and access changes toast; the invitation link is `CopyLinkField`, which says when a copy is refused (docs/04 §14.2).

### `app/[locale]/(center)/classes/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header's action slot is a loose flex row holding the Edit dialog button, an Active badge and the "All classes" link — three different heights and three different jobs, so the one verb on the page does not read as an action bar. The body is `xl:grid-cols-2` over a `display: contents` wrapper, so three cards of very different heights (key facts, the weekly-schedule builder, sessions) are dealt into two columns by the browser: the schedule builder is a tall card beside a 3-row facts card, leaving a blank block under it. Below `xl` (1024–1279px — a laptop with the sidebar open) it is a single column of full-width, mostly-empty cards. The roster, the most-used part of the page, is a full-width card *below* both. There is no upcoming-sessions list and no centre-cut figure on the page today, and the kept-sessions warning is buried inside the "Sessions" card.
**R10b:** header with the period and rooms and **Edit class** as its action bar; the kept-sessions warning is a full-width amber panel directly under the header; `DetailLayout` — schedule and roster in `main`, Key facts and Sessions in a sticky `side` (the roster is no longer a separate full-width row). Not added: an upcoming-sessions list and a requests/approvals card (no such data on the page today — see the R10b entry in 03).

### `app/[locale]/(center)/sessions/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the session's verbs (Reschedule · Edit rooms · Cancel · Delete) are in an `ActionBar` **at the bottom of the side column's facts card** — below the date/time/room/seats/price rows, far from the title and, on a phone, below the entire roster. The header's own action slot holds only badges and the "All sessions" link, in a loose row. End session is a separate strip between header and body, with its hint left and the button right, in its own bordered box. The two columns are `3fr/2fr` from `xl` only; the receipt card moves above/below the facts card depending on `closed`, so the side column's order changes with state. The roster card is tall while the side stack has no matching rhythm (facts card is short, receipt card is long) — the columns end at unrelated heights. The closed banner is correct (R2) and stays.
**R10b:** all five verbs (End session, Reschedule, Edit rooms, Cancel, Delete) are one `ActionBar inHeader` under the title, each behind the same condition as before (none once closed/cancelled/rescheduled, none without the permission — and no empty bar then); the End-session and Delete hints are muted text under the header; badges, time and rooms are the header's `meta`; the roster is `main`, the details and receipt are a sticky `side` (receipt first once closed, as R2 had it).

**SEC-2b (D-06, D-13, D-26, SEC-19):** the receipt adds a "Payments" count, "Refunded (n) −amount", a red "Voided — not counted (n)" row and an amber "Present or late without a payment" row, then named sections — present-but-unpaid students, voided payments (amount, who, when, why, on a red tint), refunds — each absent when empty; the same receipt prints and shows on the teacher's session page and in the reception dialog. A session priced at 0 gets an amber "Free session" badge in the header and on the receipt. The roster's "Mark absent and void payment" dialog now requires its reason (field marked required, the server's refusal shown under it). The New session dialog, at a price of 0, shows an amber tick box "I understand this session is free" that the server requires.

### `app/[locale]/(center)/teachers/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header is title + "Active" badge + back link in one loose row, with no initial or avatar. The main column is a single tall **edit form** card whose footer carries *Save* and, on the far side, *Delete* (a destructive button sharing a row with the primary action). The "trusted teacher" switch sits inside that same form between the fields and the buttons. The side column is two small cards (identity/rating, classes) — so under the form there is a large blank area at 1280px whenever the form is taller than them, and the block-list is a full-width card below both with its own search. The identity card is titled for a concept (`identityTitle`) the user does not recognise and carries a 'claimed account' row. There is no list of upcoming/recent sessions or of the teacher's students on the page today.
**R10b:** header with a first-letter avatar, the Active badge and the phone; `main` is one grouped record form (person · branch settings, one Save) and the classes taught; `side` is the rating/account card and the block list (candidate rows stack in the narrow column); Delete is a danger zone at the foot, behind `teacher.delete`. No other-centre data is read or shown (security fix 16).

### `app/[locale]/(center)/students/[id]/page.tsx` — **R10b**
*Wrong now (at `ea7f645`):* the header mixes the student code, the Active badge and a back link in one row, with no photo or initial (the photo lives in its own card two screens down). The left column is one tall edit-form card (person, contact, grade, four parent fields, Save and — beside it — Delete); the right column is **four** stacked cards (ID card, photo, parent summary, parent links) that are much taller than the form, so the form card ends and the left column is blank for hundreds of pixels. Enrolments and "blocked by" are a separate two-up row below, at `lg`, while the rest is `xl` — two different breakpoints for one page. The parent summary card repeats the parent fields the form above it already edits. The ID-card actions are three differently-shaped buttons in a wrapping row. There is no attendance or payment history on the page today.
**R10b:** header with the photo (a signed URL) or first letter, code, Active and grade, and **Print ID card / Print paper form** as its action bar; `main` is the record (person · grade · parent contact, one Save), enrolments with the absence-streak alerts, and "blocked by"; `side` is the ID card (preview and the stored-card control), photo, parent summary and parent links (with the placeholder verify, behind `parent.link.manage`); Delete is a danger zone at the foot. The columns now end within a card of each other at 1280px. Not added: attendance/payment history (no data on the page today).

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

### `app/[locale]/(teacher)/teacher/students/[id]/page.tsx` — **R10b**
Teacher view of a student. Marked R10b but not among the four centre detail pages this pass covered — not touched.

---

## Student experience (route group `(student)`)

### `app/[locale]/(student)/student/schedule/page.tsx`
Consistent. No change.

**DES:** upcoming sessions show eight, then "Show N more" (`CappedList`, docs/04 §14.9).

### `app/[locale]/(student)/student/discover/page.tsx`
Filter labels hand-built (in `discover-filters.tsx`). **R10a:** `FilterField`. The class card's subject-accent top border is the documented rotating subject palette (docs/04 §2), not a status colour.

**DES:** "Request to join" is the outlined brand button with a spinner. Still one long column on a phone — capping a browse surface is a product call — **OD-13** (docs/00 §2.2), not guessed.

### `app/[locale]/(student)/student/reservations/page.tsx`
`CardContent … pt-6` double padding. **R10a:** removed.

### `app/[locale]/(student)/student/profile/page.tsx`
Redirect only. No change.

---

## Parent experience (route group `(parent)`)

### `app/[locale]/(parent)/parent/page.tsx`
"No children linked" was a bare muted sentence in a padded card. **R10a:** `EmptyState`.

---

**DES:** upcoming sessions capped at eight with "Show N more" (`CappedList`).

## Platform admin (route group `(admin)`)

### `app/[locale]/(admin)/admin/centers/page.tsx`
Initial drawn with `charAt(0)` and a hard-coded `text-white` on an inline colour; "Open" a bare link; empty state was an info banner. **R10a:** `BrandAvatar`, outline `LinkButton`, `EmptyState`.

### `app/[locale]/(admin)/admin/centers/[id]/page.tsx`
`pt-6` double padding on three cards. **R10a:** removed.

### `app/[locale]/(admin)/admin/platform/page.tsx`
`pt-6`; a "brand" KPI border. **R10a:** both removed.

### `app/[locale]/(admin)/admin/catalog/page.tsx`
Consistent. No change.

---

## Other

### `app/[locale]/page.tsx`
Entry redirect. No UI. **DES:** signed out it is now the public landing — the public header (product mark + language toggle), the product name as `h1`, one plain line, Sign in / Create an account; a signed-in visitor is redirected home exactly as before (docs/04 §12).

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
