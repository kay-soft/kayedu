# KayEdu — Design review (DES)

> The professional UI/UX pass with visual verification. Phase 1 screenshotted every route for
> the roles that see it — **375 / 768 / 1280 / 1920, English and Arabic** — and reviewed them per
> area against the frontend-design principles, the Web Interface Guidelines (Vercel,
> `web-interface-guidelines/command.md`) and `docs/04-design-system.md`. This file holds the
> findings, the design direction, the batch plan and the progress log. **`docs/04` stays the
> single design source**: every token or pattern change below was written into it before it
> was applied in code.
>
> Screenshots live in `design-review/` (git-ignored, never committed): `baseline/` before,
> `after/` at the end, one PNG per `<role>__<screen>__<locale>-<width>`.

---

## 0. Method

- **Capture.** Headless `playwright-cli` (`run-code`), one browser session per role from a saved
  sign-in (`design-review/<role>.json`). Roles: platform admin, owner (Downtown), manager,
  receptionist, accountant, a teacher at two centres, a zero-centre teacher, a student, a
  parent, and signed out. Every route in the nav plus detail pages (a live, a scheduled and a
  closed session; a class; a student; a teacher; the admin's centre view), filtered and empty
  states, an unknown id, an unknown URL, the four print views, every auth screen and `/`.
  Dialogs were opened from their buttons and captured at the viewport: add student / teacher /
  class, new session, edit class, reschedule, edit rooms, cancel / delete / end session, add
  expense, add payment method, add term, the admin catalog's add, and the mobile nav drawer.
  **644 baseline images.**
- **Review.** One reviewer per area (auth & shell, dashboards, reception, core lists, money &
  admin lists, detail pages, dialogs, settings, portals, print) read its screenshots *and* the
  source behind them, and returned concrete findings with the screenshot path. Their tables are
  condensed in §2.
- **Dev data** was freshly seeded. Records named `E2E…` (left by the e2e suite) were ignored.
- **Capture artifact, not a finding:** the fixed desktop sidebar stops at the first viewport's
  height in a full-page capture.

### Measured before any review (WCAG 2.2)

| Pair | Ratio | Verdict |
|---|---|---|
| `--text-muted #94a3b8` on white (every 12px label, caption, hint) | 2.56 : 1 | **fails** AA (4.5) |
| same on the canvas `#f5f6f8` | 2.37 : 1 | **fails** |
| amber `--warning #f59e0b` text on `--warning-bg` (Late, Pending badges) | 1.93 : 1 | **fails** |
| green `--success` on `--success-bg` (Present, Paid) | 3.00 : 1 | **fails** at 12px |
| blue `--info` on `--info-bg` (Upcoming, Scheduled) | 3.01 : 1 | **fails** at 12px |
| red `--danger` on `--danger-bg` (Absent, Void) | 3.95 : 1 | **fails** at 12px |
| brand `#2563eb` on white; white on brand | 5.17 : 1 | passes |
| `--text-secondary #475569` on white | 7.58 : 1 | passes |

- **Cairo's Latin digits are already tabular** (`1111` and `0000` measure the same), with or
  without `tabular-nums`. **Its Arabic-Indic digits are proportional and the font has no `tnum`
  feature for them** (`١١١١` 49px vs `٠٠٠٠` 40px at 40px). `tabular-nums` is therefore applied
  (it is right for Latin and harmless for Arabic), and the Arabic rule is **alignment**:
  numeric columns align to the end edge, so figures line up by their last digit.
- **An unknown URL renders Next's bare default 404** ("404 | This page could not be found", no
  locale, no way back): `app/[locale]/not-found.tsx` only renders for an explicit `notFound()`.

---

## 1. Design direction

**Refine, don't reinvent.** KayEdu is a calm, professional operations tool for busy front desks:
high information density without clutter, clear hierarchy, a consistent spacing rhythm, one
brand accent (the centre's theme colour) on neutral surfaces with restrained elevation,
interactions that feel fast, motion that is subtle and respects reduced motion, and typography
tuned for Latin and Arabic with tabular numerals for money and times.

### 1.1 Plan (pass one)

- **Colour** — five neutrals and the centre's accent:
  `ink #0f172a` (text, the sidebar) · `canvas #f5f6f8` · `surface #ffffff` ·
  `slate #475569` (secondary text) · `mist #5f6b7d` (muted text, darkened from `#94a3b8`) ·
  `brand` (per centre, default `#2563eb`). Status keeps its four hues; text drawn in a status
  colour uses a darker shade of the same hue so it reads.
- **Type** — Cairo, one family for both scripts. Weights 400 / 500 / 600 / 700 only.
  12 label · 14 body and table · 16 card title · 18 section · 24 page title · 30 KPI.
  `tabular-nums` on every figure; numeric columns end-aligned.
- **Layout** — the app shell's content column (`content-shell`, 96rem) with a 24px rhythm between
  page regions and 16px inside a card; one surface per region with hairline-separated rows
  inside it (not a card per row); borders before shadows.
- **Principles** — status colour is information, never decoration · one obvious primary action
  per region · a phone is a first-class desk, not a fallback · every mutation answers.

### 1.2 Review against the brief (pass two)

Checked against what a generic generated admin would do with the same prompt:

- **The SaaS-card kit** (content chopped into identical rounded cards, one radius, one soft
  shadow on everything) is the most likely default for an ERP and the one this app already
  leans toward. *Changed:* the plan keeps two radii **by hierarchy** (12px containers, 8px
  controls), uses **borders before shadows** (a card at rest is a 1px border with the faintest
  lift; only floating surfaces cast a real shadow), and lists are **one surface with hairline
  rows**, not a card per row. Cards-inside-cards are removed where the review finds them.
- **Template chrome** (tracked all-caps eyebrows, `A · B · C` meta strings, `→` on links) — the
  app's meta lines already join facts with ` · `. *Kept where it carries data* (a session's
  "teacher · date · time" is genuinely three facts) and not added anywhere new; no all-caps
  labels, no eyebrows.
- **Where the boldness goes** — one place, chosen for the subject: **the reception desk's
  find/scan field.** It is the moment the product exists for (a queue of students at a desk
  with a hardware scanner), so it is the one element that gets a strong, unmistakable state:
  large, focused on arrival, a clear "ready to scan" state and an immediate, legible answer
  after every scan. Everything around it stays quiet.
- **Distinctiveness within "refine"** — the brief fixes the direction (calm, neutral, one
  accent), so identity comes from the centre's own colour and mark carried consistently
  (sidebar, switcher, ID card, auth panel), from excellent Arabic typography, and from the
  reception moment above — not from a new palette.

---

## 2. Findings per area

Each area's full table (every row with its screenshot path, about 30 rows each) is in
`design-review/findings/<area>.md`, git-ignored with the screenshots. Below are the headline
findings, ranked **H** (broken, unreadable, inaccessible, wrong in one locale) and **M**
(inconsistent, weak hierarchy, cramped). Screenshot names are
`design-review/baseline/<area>/<role>__<screen>__<locale>-<width>.png`.

### 2.0 Across every area — the patterns behind most rows

1. **Contrast in the tokens themselves** (§0): `--text-muted` carried every 12px label, hint,
   column header and code at 2.56:1; status text on its own tint was 1.9–4.0:1. Every reviewer
   hit this.
2. **`dir="ltr"` on a block element** (a phone, a code, a time, a slug) flips the block's
   alignment, so in Arabic the value sits on the far edge from its label — reception check-ins,
   the student / teacher lists, approvals, rosters, the paper form, `DetailRow`, the catalog.
3. **Mixed numerals in Arabic**: next-intl prints ICU plural counts in Latin digits beside
   Arabic-Indic figures ("3 حصة" next to "٣"); a few hand-built strings (`2026`, `40.00`,
   `String(n)`) do the same; several Arabic plurals are ungrammatical.
4. **The Arabic ID card is broken** (`lib/id-card.ts`): text is mirrored twice — `x` is mirrored,
   then `text-anchor="end"` is set *together with* `direction="rtl"`, which flips it back — so the
   branch name runs off the card and the photo overprints the grade. Same SVG on screen, in print
   and in the stored file. *Three reviewers found it independently.*
5. **One-tap destructive or irreversible verbs** next to careful ones: revoke invitation (the
   brief's example), deactivate a student / teacher / staff member, revoke a branch grant,
   decline a request, remove or block a class student, remove a holiday, Mark paid / Approve /
   Cancel draft on a settlement, Suspend a centre, Reset the card layout.
6. **Silent results**: no toast layer existed; row actions (Deactivate, Remove) gave no answer;
   several forms put the result at the top of a long page or dialog; the settings "Add" dialogs
   and the expense form reset what was typed on a refusal.
7. **Hierarchy**: `CardTitle` shipped at weight 500 as a `div` (no heading outline); every list row
   carried a name link *and* an "Open" button; several screens show three or four equal solid
   primaries (reception, the session roster, settings).
8. **Tables at 768**: fixed `md:w-*` columns squeeze the name columns to nothing on Sessions and
   Classes (header labels overlap, "Open" clipped); numeric columns are start-aligned.

### 2.1 Public, auth & app shell
- **H** An unknown URL renders Next's bare English 404 — no locale, no brand, no way back
  (`auth/anon__not-found__*`).
- **H** Placeholders drew in the secondary text colour: the register form looked pre-filled
  (`auth/anon__register__*`).
- **H** The mobile drawer was only `aria-hidden` while closed — its links stayed in the tab order
  of every phone page; focus neither moved in on open nor back on close (`shell/*`, code).
- **M** The branch hub's Sign out was a full-width navy slab, heavier than the choices above it
  (`auth/*select-center*`).
- **M** No skip link; the collapse toggle sat beside Sign out; the account button looked disabled
  next to the language toggle; the active nav pill carried a stray white tab
  (`dashboards/manager__dashboard__*`).
- **M** The invalid-invite page has no next step; the locale-level error page has no brand,
  language toggle or way home.

### 2.2 Dashboards & analytics
- **H** A negative Net wraps its minus sign onto its own line
  (`dashboards/manager__analytics-month__en-1280`).
- **H** The accountant's dashboard links "View all sessions" and each session row to pages that
  role cannot open.
- **H** Arabic zero `٠` dimmed to the muted colour all but disappears; the admin adoption list
  prints Latin `2026` beside Arabic month names.
- **M** Hierarchy upside down (session counters lead at 30px, money second, head-counts a full
  row); values at different heights depending on the icon; every KPI full width at 375 (pages
  of 2,000–3,500px); at 768 a third card spans the row; Today's-sessions rows have no column
  grid and "6 / 8" has no label.
- **M** Analytics money columns start-aligned, with mixed decimals and `truncate` at 112px; with a
  teacher selected, Expenses and Net stay branch-wide without saying so.
- *Flagged, not a DES change* (§6): trends and a revenue chart (new `lib/db` period queries);
  the Staff KPI omitting ACCOUNTANT (a query); Analytics opening on *Today* (documented, §11.7).

### 2.3 Reception desk
- **H** Arabic: the student code in Recent check-ins jumps to the far edge (block `dir="ltr"`,
  `reception/receptionist__reception-session-mode__ar-*`). Session-card titles had no focus
  style.
- **M** Session mode is not unmistakable (a white card with one 14px line); the live session is
  not distinguished — every card has the same solid "Start attending", plus "Register student":
  four equal primaries at 1280; every upcoming card shows a disabled red End session and the
  same hint.
- **M** The student-first confirm shows a 56px photo and the name inside a muted sentence — the
  weakest anti-impersonation check, on the path used for walk-ins.
- **M** At 375 the header pushes Check in below the fold in session mode; at 1920 the search is
  1,400px wide and recent rows put the badge 1,400px from the name.

### 2.4 Core lists (sessions, approvals, classes, students, teachers)
- **H** At 768 fixed columns crush Sessions and Classes (labels overlap, names vanish, "Open"
  clipped — `lists/manager__sessions__*-768`, `manager__classes__en-768`).
- **H** Arabic: block `dir="ltr"` cells on the wrong edge; Latin-digit ICU counts and wrong plurals;
  English teacher notes with the full stop flipped to the start (no `dir="auto"`).
- **H** With a search active, the subtitle reads "0 registered at this branch" — the filtered
  count (`lists/manager__students-nomatch__*`).
- **H** From `md` the per-cell labels are `display:none` and the header `aria-hidden`: a screen
  reader hears values without column names.
- **M** Two ways to open every row plus an equal-weight Deactivate; a student card is 330–420px at
  375 (25 students ≈ 9,900px); Deactivate (students, teachers) and Decline (approvals) are one tap
  while Classes asks first; "Promote a grade" out-shouts "Register student"; the Sessions title
  stays "Today's Sessions" on a 7-day range; numbers start-aligned.

### 2.5 Money & platform-admin lists
- **H** The audit trail shows raw action keys (`classGroup.deactivate`) and raw enums
  (`CANCELLED`, `PAID`), in English inside the Arabic UI (`lists/manager__audit__*`).
- **H** Refund amounts painted red with a hand-glued hyphen (§11.9: money is never coloured; red
  is the void colour).
- **H** Settlement Mark paid / Approve / Cancel draft are one click (Paid is irreversible); the
  admin create form's logo picker is the native file input, English inside Arabic.
- **M** Money columns start-aligned and truncated; a voided expense struck *and* muted
  (unreadable); money inputs `type="number"`; primary buttons stretched the full card width
  (`w-full sm:w-auto` inside a `flex-col` form); developer copy ("Stored as piastres — never a
  float"); Latin digits in Arabic catalog defaults.

### 2.6 Detail pages
- **H** The Arabic ID card (pattern 4, `details/manager__student__ar-*`).
- **H** The `TimePicker`'s clock button covers the time in Arabic: the input is `dir="ltr"` (its
  padding goes right) while the button is `end-0` in the RTL wrapper (it goes left) —
  `details/manager__class__ar-*` and every reschedule / new-session dialog.
- **H** The session header's action bar sits beside the title from `sm`, leaving a 130px title at
  768 (`details/manager__session-scheduled__ar-768`).
- **H** Void / Refund on a paid roster row are 36px / 12px with unlabelled reason inputs; the
  selected Late chip is amber on amber (1.93:1) on the most-used control in the product.
- **H** Class roster Remove / Block are one tap; a missing record renders the global 404 outside
  the centre shell; the teacher card says "Signed in before: Inactive" (Arabic: "suspended").
- **M** About 200px a roster student, with full-width solid "Check in" bars; a closed roster
  shows Present grey; the receipt colours zero counts; side-card labels take a fixed 160px; the
  photo picker is the native file input.

### 2.7 Dialogs
- **H** The `TimePicker` overlap (above); the phone-lookup input has no label and a hard-coded
  `01xxxxxxxxx`; catalog pickers show English names in `/ar` (labelled with the account's stored
  locale in `lib/db/scoped.ts`, not the URL's — a `lib/db` change, flagged §6).
- **M** Between 640 and ~930px the wide dialog runs edge to edge; confirmations draw an empty body
  band and, on a phone, a full-screen sheet for two lines; the committing destructive button is
  the soft tint, weaker than "Keep it"; End session never names the counts it locks; the settings
  "Add" dialogs are not the shared shell (no footer, no Cancel, a generic "Add") and reset what
  was typed on a refusal; Escape or the backdrop discards a half-typed New class; Select
  placeholders read as chosen values.

### 2.8 Settings
- **H** The Arabic card preview (pattern 4); the Users & roles role select squeezed to "M…";
  Revoke invitation / Deactivate member / revoke branch grant are one tap; catalog row buttons are
  36px on a phone.
- **H — needs a test before it is called a bug.** The permissions matrix renders each checkbox
  twice in one form (table + phone cards); reading the code, a revoke might not persist. Checked
  in §5 before anything is touched.
- **M** General has one Save at the foot of ~2,000px with its message at the top; the matrix's
  not-grantable cell looks like an unchecked box and the matrix is a nested 70vh scroll; Reset
  card sits beside Save and wipes everything; the settings sub-nav wraps to three or four rows
  at 375.

### 2.9 Portals (teacher, student, parent)
The area reviewer stopped on an account usage limit before reporting; this area is reviewed
directly during batch 9 (§5).

### 2.10 Print views
- **H** The Arabic ID card (also printed on the Arabic paper form); block `dir="ltr"` values on the
  wrong edge; the email breaks mid-word on the A4 form; labels print in the pale muted colour.
- **M** The roster's code column drifts with name length (no table); the teacher sheet unsorted
  while the staff sheet is sorted; the A4 form prints the full dark card artwork at the wrong
  size; one `break-inside-avoid` on the whole receipt leaves large page gaps; the back link sits
  at the far end after Print; two copies of the print toolbar.

---

## 3. Token changes

*(Each is written into `docs/04` §2–§4 before it is applied; reasons in §2. Semantic status
colours themselves are unchanged — only their text shade on a tinted badge is new.)*

| Token | Before | After | Why |
|---|---|---|---|
| `--text-muted` | `#94a3b8` | `#5f6b7d` | 2.56:1 on white failed AA for every label it carried; now 5.40:1 (5.00:1 on the canvas) |
| `--text-placeholder` | — (used `text-secondary`) | `#64748b` | placeholders distinct from typed values but still 4.76:1 |
| `--text-on-dark-muted` | — (reused `text-muted`) | `#94a3b8` | the old muted value kept where it works: on the navy sidebar |
| `--border-control` / `-hover` | `--input: #e5e7eb` | `#848f9f` / `#64748b` | a field's edge was 1.24:1 on a white card, where it is the only cue; WCAG 1.4.11 asks 3:1 — now 3.28:1 (3.03:1 on the canvas), hover 4.76:1 |
| `--success-fg` `--warning-fg` `--danger-fg` `--info-fg` | — (base colour as text) | `#15803d` `#b45309` `#b91c1c` `#1d4ed8` | status text on its tinted badge reached AA only with a darker shade |
| `--muted-foreground` (shadcn) | `var(--text-secondary)` | `var(--text-placeholder)` | shadcn placeholders follow the new token |
| print: `--text-secondary` / `--text-muted` | as on screen | `#1e293b` / `#334155` | pale grey drops out on office lasers |
| Button sizes | `h-9` default | `h-11` default, `sm` `h-9`, `lg` `h-12`, icon `size-11` | 44px targets by default (§6) |
| Focus | per-component rings | one `outline-2` ring (`focus-ring`, `focus-ring-inverse`) | one focus language |
| Badge radius | 8px, same as a button | full (pill) | a status read as something to press; containers 12px and controls 8px are unchanged, now written down |
| Card padding | 16px at every width (docs/04 said 24) | 16px, 20px from `md` | doc and code agree; a desktop card gets room |

---

## 3a. Found, flagged, not changed (outside DES's constraints)

| # | What | Why not changed here | Suggested fix |
|---|---|---|---|
| F1 | **Catalog names show in English inside the Arabic UI** (grades, subjects and education systems in the class / session dialogs, the student page, filters) whenever the account's stored locale is English. `lib/db/scoped.ts` labels catalog rows with `ctx.user.locale ?? "ar"`, not the request's locale. | It is in `lib/db`, which DES may not change. Patching each screen instead would leave the rest inconsistent. | One line: label with the request locale (pass it into `scoped(ctx)`, or `getLocale()` there). Needs a decision because `scoped` is the tenant boundary. |
| F2 | **The dashboard's Staff count omits ACCOUNTANT** (`role in [OWNER, MANAGER, RECEPTIONIST]` in `dashboard/page.tsx`). | A data query, not presentation. | Count `CENTER_STAFF_ROLES`. |
| F3 | **Analytics has no trend chips or revenue chart**, which docs/04 §8 promises. | Needs new period-comparison queries in `lib/db/analytics.ts`. | A previous-equal-period read and one bar chart; backlog. |
| F4 | **Password reset** is not built. | M20 (SEC-66) — it needs the transactional email sender. | As planned in M20. |
| F5 | **Analytics and Expenses open on *Today*** (reviewers suggested *This month*). | The default is documented behaviour (docs/04 §11.7); changing it is a product decision. | Decide the default per screen. |
| F6 | **The permissions matrix silently dropped every revoke** — **confirmed and fixed in DES** (it is a form bug, not a rule). Each cell rendered two uncontrolled checkboxes with the same name (the table and the phone cards); a CSS-hidden checkbox still submits, so unticking the visible copy left the hidden one posting `on`. Verified in a browser as the owner on a cell no journey uses (Accountant × Promote students): under the old form two revokes in a row did not persist; under the new one the revoke persisted; the cell was restored to its original state. | The Server Action, the grantable ceiling and the rules are untouched: the form now keeps one controlled state for both layouts and posts each granted cell once, with the same `grant__<role>__<action>` = `on` fields the action already read. | Worth a gate that posts a revoke through the real form (e2e owner journey) — not added in DES. |

---

## 4. Batch plan

| # | Batch | Scope |
|---|---|---|
| 1 | Foundations | tokens, typography, buttons, inputs, selects, comboboxes, date/time pickers, cards, table/card lists, badges, dialogs/sheets, toasts, PageHeader, EmptyState, skeletons, the shell (sidebar, header, drawer, LocaleToggle) |
| 2 | Public & auth | `/` (public landing), login, register, select-center, invite, account-pending, password reset (none exists — see §5), not-found and error pages |
| 3 | Dashboards | centre dashboard, analytics, teacher dashboard, admin platform |
| 4 | Reception desk | layout, the scan flow, session mode, feedback |
| 5 | Lists | students, teachers, classes, sessions, expenses, settlements, refunds, approvals, audit; teacher, student, parent and admin lists |
| 6 | Detail pages | class, session (and its receipt), teacher, student |
| 7 | Dialogs | every create/edit dialog and sheet |
| 8 | Settings | every settings screen, the permissions matrix, the card editor |
| 9 | Portals | teacher, student, parent |
| 10 | Print views | receipts, ID card, paper form (print CSS) |
| P3 | Feedback & validation | every mutation answers; field errors; shared zod on the client; pending; input kept; confirmations; per-group error/not-found/loading |
| P4 | Accessibility & responsiveness | contrast, focus, keyboard paths, aria, landmarks, reduced motion; 320 / 375 / tablets / 1920+ |
| P5 | Final | after-screenshots, before/after notes, docs/04 + docs/06, `check:design` rules |

---

## 5. Progress log

- **Phase 0** — dev server; nine role sessions saved under `design-review/` (git-ignored); route
  list built from the app directory and `components/shell/nav.ts`; gates green before any change
  (`tsc`, `eslint` 0 errors, `check:design`, `check:rtl`; `npm run e2e` baseline — see below).
- **Phase 1** — 644 baseline captures; ten area reviews; nine reported (§2), the portals reviewer
  stopped on an account limit (reviewed directly in batch 9). The e2e baseline run overlapped
  the first Batch 1 edits, so its failures (`MISSING_MESSAGE Shell.skipToContent` in the minutes
  before the key existed, plus hot-reload hydration noise) are not a baseline; SYS recorded
  161 passed / 0 failed, and the post-batch runs below are the real check.
- **Batch 1 (in progress)** — docs/04 §2–§4 + §14 written first. Done in code: tokens
  (`--text-muted`, `--text-placeholder`, `--text-on-dark-muted`, `--border-control*`, the four
  `-fg` status text shades) and the `text-*-fg` codemod; `Button` (44px default, one focus ring,
  readable destructive); white fields on `--border-control` (`Input`, `Textarea`, `Select`,
  `Combobox`, `DatePicker`, `TimePicker`, `DateFilter`, `Checkbox`); `Card` (border recipe,
  16/20 padding, `CardTitle` 600 as `h2`); `Badge` (pill, `dot`/`pulse`); `EmptyState` (no
  dashed box); `Field` (`aria-describedby` / `aria-invalid`); `FormMessage` / `FieldError` /
  `SubmitButton` (`pendingLabel`); skeletons; dialog close focus ring; the shell (skip link,
  `inert` drawer with focus in/out, collapse toggle on the brand row, account button, header
  padding, plain active pill, on-dark muted tokens); `SignOutButton` light variant; toast layer
  (`components/ui/toast.tsx`, mounted in the locale layout) and `lib/ui/action-feedback.ts`;
  `PageSection`; `Ltr` (`DetailRow` uses it); `check:design` refuses base-token status text.
  Then: `TimePicker` input no longer `dir="ltr"` (the clock button covered the time in Arabic);
  dialogs get a 16px gutter, no empty body band (hidden inputs are not a body), a bottom sheet
  for confirmations on a phone, a solid `danger-solid` committing button, backdrop presses
  ignored by form dialogs, opacity/scale-only motion and safe-area footer padding; `Select`
  shows an empty choice as a placeholder; the collapse toggle moved to the app bar's start
  edge (on the brand row it cut the branch name — caught in the re-shoot); detail-page
  headers put the action bar beside the title only from `lg`; `design-review/` added to
  eslint's ignores (its capture scripts were the 20 baseline warnings).
- **Batch 1 — done.** Re-shot a cross-section (dashboard, analytics, admin platform, login,
  owner hub, three dialogs, sessions, audit, settlements, drawer, session and student detail,
  session mode, settings general and permissions, three portal homes) at all four widths in
  both locales into `design-review/b1/`. **Gates:** `tsc`, `eslint` (0 problems),
  `check:design`, `check:rtl` green; **`npm run e2e`: 161 passed, 0 failed, 4 skipped** (the
  same as SYS); no e2e locator changed. Every route is re-captured in full in Phase 5.
- **Batch 2 — public & auth (done).** docs/04 §12 "DES additions" first. `/` signed out is a
  public landing (public header, product name, one line, Sign in / Create an account;
  signed-in routing unchanged). `app/[locale]/[...rest]/page.tsx` → the bilingual 404 for any
  unknown URL; `not-found.tsx` in every route group (`RecordNotFound`, inside the shell, back
  to that experience's home); `(print)/error.tsx`; the locale error page has the public
  header and "Go to your home screen". `ProductMark` replaces three hand-drawn tiles;
  `PublicHeader` is the chrome outside a shell. Branch hub: light Sign out, an
  empty-specific title, neutral role badges, readable hint, full-width next steps on a phone.
  Invitation refusals: warning tone, a next step in the copy, Create an account. Name
  placeholders prefixed "e.g." / "مثال:"; email fields without spell-check or
  auto-capitalise. **Arabic numerals in messages:** a global `arab` number format
  (`lib/i18n/formats.ts`) and a codemod writing every `ar.json` count as
  `{count, number, arab}` (39 messages; docs/02 §8) — "٢ فروع" now matches "٢" everywhere,
  and the hub's dual is grammatical. Copy: curly apostrophes, "Loading…". Re-shot the
  whole auth area + the in-shell not-found (80 images, `design-review/b2/`). Gates:
  `tsc`, `eslint`, `check:design` (now also: every out-of-shell screen renders
  `PublicHeader`), `check:rtl` green. Password reset was **not** built — it is M20 (SEC-66,
  needs the email sender; §6). **e2e after batch 2: 160 passed, 1 failed, 4 skipped** — the
  failure (reception's daily loop in `ar-375`: the check-in reported success but the roster
  was empty) happened while `check:all` was writing to the same branch at the same time;
  re-run alone it passed (17/17). The same overlap made `check:all`'s run-level "user rows"
  baseline report 6 rows created by the concurrent e2e sign-ups; every individual gate
  passed. From here on the two never run together.
- **Batch 3 — dashboards (done).** docs/04 §14.4 + §3 ("Dates name their month") first.
  `StatCard` (fixed label row, no-wrap figure that steps down when long, secondary-colour
  zero, `compact`); `StatGrid dense` (two up on a phone); `formatMoney` gains
  `signDisplay: "negative"` and `{ fixed: true }`; times keep their meridiem with a
  no-break space; **every date now names its month in Arabic too** (`١٥ أكتوبر ٢٠٢٦`, it
  was `١٥‏/١٠‏/٢٠٢٦`). Centre dashboard: title "Dashboard" with branch · date, role badge as
  meta, money first, dense counts, Today's sessions on one column grid with a labelled
  count ("6 / 8 checked in"), the branch head-counts as one strip; session links and
  "View all" / "Manage classes" only for a role that can open them (the accountant's had
  bounced). Analytics: `PageSection`s, the period in words, Net's icon by its sign,
  "Branch-wide" on Expenses/Net with a teacher selected, one shared `RevenueBreakdown`
  (end-aligned, two decimals, never truncated; a card with a two-column list per row below
  `md`). Admin platform: dense counts, the month through `lib/format.ts`, a proportional
  bar per month. Teacher dashboard: role badge as neutral meta, counts formatted (a plain
  `{today}` placeholder had printed Latin digits). `design-review/` excluded from
  `tsconfig`. Re-shot every dashboard (`design-review/b3/`). Gates: `tsc`, `eslint`,
  `check:design`, `check:rtl` green.
  *Found, flagged, not changed:* the dashboard's Staff count includes OWNER / MANAGER /
  RECEPTIONIST but not ACCOUNTANT (a query in the page — §6). **e2e: 161 passed, 0 failed.**
- **Batch 4 — reception desk (done).** docs/04 §14.5 first (and §11.17's End-session line).
  The find / scan field is the desk's one bold element: `TypeAheadSearch size="lg"` (56px, a
  scan icon, the label kept for assistive technology), capped at `max-w-3xl` in plain mode, a
  "Ready to scan" line in session mode, a polite live region announcing "Searching…" / the
  result count, spell-check off, codes as isolated LTR runs. Session mode: a brand-tinted
  banner with a brand start edge, the name at 16px / 600, Live badge and checked-in count,
  real `AnchorButton`s, only the summary as the live region; from `xl` the confirm area and
  Recent check-ins sit side by side. Cards: one-row four-segment filter at 375, 16px
  focusable titles, Start attending solid only on a live card, the disabled End session and
  its hint gone from upcoming cards, an "Attending now" badge in the header, a two-column
  action grid at every width. One `StudentConfirmHeader` (80px photo, name, code, Enrolled /
  Drop-in) for both check-in paths. Recent rows single-line from `sm`, code and time
  readable. Phone: subtitle hidden, payment-method and session-picker buttons 48px, "Press
  Enter" from `sm` only. Register student outline on the desk; the receipt's Print says it
  opens a new tab; a scan that finds nobody names the next step. Re-shot the reception area
  (`design-review/b4/`). Gates: `tsc`, `eslint`, `check:design`, `check:rtl` green. *Not done:*
  "Check in · {price}" as the button label — e2e finds the button by its exact label and the
  price is already the row above it. **e2e: 161 passed, 0 failed.**
- **Batch 5 — lists (done).** docs/04 §14.6 first. `ConfirmAction` — the one confirmation
  dialog for a destructive or irreversible row verb, posting the row's unchanged action —
  now guards: deactivating a student, teacher or class (the class's inline confirm moved
  into it), declining any approval request (centre and teacher queues, incl. account
  claims), and Cancel draft / Approve / Mark paid on a settlement (`tone="default"` for the
  two that are final but not destructive). Rows: the redundant "Open" button removed (the
  name is the link), a hover tint from `md`, per-cell labels `sr-only` from `md` (they had
  been `display: none`), numbers end-aligned, codes and phones bidi-isolated. Sessions and
  Classes no longer crush at 768 (narrower fixed columns; Room joins from `lg`; names wrap to
  two lines); student, teacher and class cards on a phone are a two-column grid (a student
  card ~200px, was 330–420). Counts in descriptions and pagination are ICU plurals in the
  locale's digits (Arabic: all six forms); Students counts the matches while a search is on;
  "Today's Sessions" is "Sessions". Money lists: refunds uncoloured with the locale's own
  minus, a cancelled settlement neutral, an expense's void struck but legible, amounts never
  truncated, the void confirm a pending-aware button with a focused, labelled reason. Audit
  trail: all 44 missing action labels written (both locales), status values translated, a
  "set" form when there is no before-value, a red "Voided" badge, never a raw key. Admin
  catalog: counts and the default cut through `lib/format.ts`, names bidi-isolated under
  their labels, Delete quiet at rest. **e2e locator changes (meaning unchanged):**
  `claim.spec.ts` confirms the Decline in its dialog; `manager.spec.ts` opens the new class
  from the row's link instead of the removed "Open". **First e2e run: 158 passed, 3 failed** —
  the two "Open" locators (fixed above) and a third that exposed a real double-submit: after
  **Create session** succeeded the dialog animated out while the app navigated, its submit
  was clickable again in that window, and the e2e helper's retry posted a second create to
  the new session's URL (the trace showed it). Fixed for every dialog: a closing
  `DialogShell` cannot submit, and a dialog takes no pointer input while animating out —
  this is also what made the Batch 2 reception failure intermittent.
- **F6 (permissions matrix) confirmed and fixed** — see §3a. Pulled forward from Batch 8.
- **Batch 6 — detail pages (done).** docs/04 §5 (ID card) first. **The Arabic ID card is
  fixed** (`lib/id-card.ts`: logical text anchors under `direction`; LTR byte-for-byte
  unchanged; `check:card-layout`'s four RTL goldens re-taken, its RTL end-anchor assertion
  corrected, and a start-anchor assertion added). Roster: Void / Refund 44px with a labelled,
  focused reason field and a Cancel; Refund neutral, not "upcoming" blue; a closed roster's
  statuses in their colours; the selected attendance status carries a check mark (never
  colour alone); Check in no longer stretched on desktop; Record payment is the row's
  primary. Class roster: Remove and Block confirm (`ConfirmAction`), codes isolated.
  Receipt: zero counts uncoloured, the refund minus from `formatMoney`, labels readable,
  tiles keep an edge in print. Teacher page: "Signed in before: Yes / Not yet" (it had said
  "Inactive", in Arabic "suspended"). Re-shot the detail pages (`design-review/b6/`).
  **The first e2e run for batches 5–6 died with the dev server** (Node ran out of heap
  after ~7 hours of hot reloads: 131 passed, 30 failed, every failure after the crash or
  `ERR_INSUFFICIENT_RESOURCES`); the server was restarted with an 8 GB heap and the suite
  re-run: **161 passed, 0 failed.**
- **Batch 7 — dialogs and forms (done).** docs/04 §14.7 first. The settings "Add" dialogs are
  the shared narrow `DialogShell` (bottom sheet on a phone, fixed header and footer); every
  uncontrolled create and settings form submits through `startTransition`, so a refused
  submit keeps what was typed (it had cleared the form); an odd field count gives the first
  field the whole row; staff-entered people and contacts are never autofilled with the
  signed-in user's own details (`ownProfile` keeps autofill on a person's own profile); the
  phone lookup is a labelled field with an announced answer; column-form primaries no longer
  stretch (`sm:self-start`). Pricing and period fields sit on one grid.
- **Batch 8 — settings (done).** docs/04 §14.8 first. General settings has a sticky save bar
  that carries its result; the settings sub-nav is two even chip columns on a phone. Users &
  roles: the email under the name, a fixed role column (it had been squeezed to "M…"),
  deactivate / revoke invitation / remove branch each confirm, the grant select has a
  placeholder. Payment methods and the other entity lists deactivate through `ConfirmAction`.
  ID-card editor: Reset asks first (inline two-step) and a phone gets its own instruction.
  Catalog: prices as formatted money, 44px row buttons below `md`. **e2e locator changes
  (meaning unchanged):** `owner.spec.ts` confirms Deactivate (payment method) and Revoke
  (invitation) in their dialogs — the brief's one behaviour change.
  **e2e for batches 7–8: 157 passed, 4 failed.** Two were a real overlap this pass created —
  General settings said "Changes saved." in its save bar *and* in a toast, so the test's
  text locator matched twice; the toast was removed (one answer, once — docs/04 §14.2). The
  other two (teacher hub, reception daily loop, en-1280 only) were bounced to `/login`
  about an hour into the run — the shared storage-state session expiring, not a UI change;
  both passed in the other projects and in the next run.
- **Batch 9 — portals (done).** docs/04 §14.9 first. The teacher's "Request a new session"
  is a closed disclosure above the list; the student and parent upcoming schedules show
  eight sessions, then "Show N more" (`CappedList`, display only); Discover's "Request to
  join" is the outlined brand button with a spinner; the rating pop-up's Skip is a real
  outline button; schedule meta lines readable (`text-secondary`). Re-shot in
  `design-review/p39/portals/`. **Not done:** Discover itself is still one long column on a
  phone (~6,000px with every open class) — it is a browse surface with its own filters, so
  capping it is a product call (paging vs. filters), recorded as **OD-13** (docs/00 §2.2), not guessed.
- **Batch 10 — print (done).** docs/04 §14.10 first. One shared `PrintToolbar` for all four
  print views (the teacher's duplicate deleted): back link at the start, page-specific hint
  (the card names card size, card paper, no margins), Print at the end, sticky, hidden on
  paper. Print-only token overrides darken muted and secondary text; headings keep with
  what follows; rows and receipt cards never split, while the receipt section may now
  break (it had been pushed whole to page two). The roster prints as a real table — #,
  student, code, attendance — sorted by name in the sheet itself (the teacher's sheet had
  been unsorted). The A4 paper record stacks label over value (an email had broken
  mid-word) and prints its card at true size. Re-shot in `design-review/p39/print/`.
- **Phase 3 — feedback and validation (done).** docs/04 §14.2 first.
  - *Silent actions:* `revokeInvitationAction`, `grantMembershipBranchAction` and
    `revokeMembershipBranchAction` returned `void` — a refusal looked exactly like
    success. They now return `ActionState` (same rules, same order; each early return names
    its rule), and the staff screen toasts the result (`staff-result-actions.tsx`).
  - *Silent catches:* the two copy-link buttons (staff invitation, admin founding-owner
    invitation) swallowed a refused clipboard write; both are now one `CopyLinkField` that
    says so and selects the link.
  - *Success that said nothing:* 11 row and inline controls (activate/deactivate student,
    teacher and member, role change, enrol/remove/block/unblock, photo save/remove, catalog
    add/remove/save, expense add/void) now toast in the act's own words (`Toasts`).
  - *Network failures:* all 59 form-state hooks use `useGuardedActionState` — a request that
    never arrives is a toast with Retry, and the form keeps what was typed.
  - *Client validation* with the action's own zod schema on the student, teacher, expense
    and General-settings forms; it blocks only what the person can see and fix and focuses
    the first invalid field. *Error summary* on those forms at two or more field errors.
  - *Confirmations:* removing a student photo (it deletes the file) now confirms; every
    other destructive verb already did (dialog, or an inline two-step inside an open form).
  - *Boundaries:* every route group has `error.tsx` and `not-found.tsx`; six have
    `loading.tsx` (print has none — it renders one record, and a skeleton would print).
- **Phase 4 — a11y and responsive (done).** Static sweep: every `outline-none` has a
  `focus-visible` ring beside it; reduced motion is one global rule; no clickable
  non-button elements. **Numbering:** 13 Arabic messages printed Latin digits in prose
  (sizes, limits, "0 EGP") and 14 passed a raw count to a bare `{count}` — now Arabic-Indic,
  and the counted nouns use Arabic's plural forms ("٥ حصص", not "5 حصة"). Typed-input
  examples (a phone placeholder, "250.50") stay as typed; both parsers fold Arabic digits.
  **Dynamic sweep** (`MODE=sweep node design-review/gen.mjs`, every manifest route, both
  locales, 320 / 375 / 768 / 1024 / 1920): **no horizontal overflow on any route at any
  width.** Arabic DOM text with a Latin digit outside an isolated LTR value: only data
  (branch, room and catalog names as entered) and E2E records — plus four real ones, fixed:
  the class page's seats ("4 من 12") and price ("EGP 80" — formatted with the account's
  saved locale, `ctx.user.locale`, instead of the page's), an approval's late threshold, and
  the student page's "other branches" count. **Keyboard:** the skip link is the first stop
  and lands on `main`; a confirm dialog takes focus, Escape closes it and focus returns to
  its trigger; one `main`, one `h1`. **Bug found and fixed:** with the phone drawer open,
  16 of 30 Tab presses walked out of it into the page under the overlay — the content
  column and skip link are now `inert` while it is open, the drawer is a modal `dialog`,
  and widening past `lg` closes it (docs/04 §14.3). **Field borders to 3:1** (WCAG 1.4.11):
  `--border-control` `#cbd5e1` was 1.48:1 on a white card, where the edge is a field's only
  cue — now `#848f9f` (3.28:1), hover `#64748b` (§3). Reduced motion is one global rule;
  every `outline-none` has a `focus-visible` ring beside it.
- **Phase 5 — verification (done).** After-shots of every route: `design-review/after/`
  (628 images; the baseline's 8 "delete session" dialog shots are absent only because the
  seeded scheduled session has since started — a started session cannot be deleted, so
  the button is correctly not offered). `check:design` extended (route-group boundaries,
  guarded form state, every state reported, no `void` Server Action, no silent `catch`).
  `npm run build` passes. **`check:all`: 32 of 32 gates pass** — after one fix:
  `check:people` still asserted the *old* Arabic card anchor (`text-anchor="end"`), the
  very bug Batch 6 fixed; it now asserts the logical anchor, as `check:card-layout` does.
  Final e2e: see the closing line below.

## 6. Before and after, per area

| Area | Before (baseline) | After |
|---|---|---|
| Foundations | muted text 2.56:1, status text 1.9–3.9:1 on its badge, field edges 1.24:1, 36px buttons, mixed Latin/Arabic digits | every text token ≥ 4.5:1, status `-fg` shades, field edges 3:1, 44px default targets, one numbering system per locale, one focus ring |
| Public, auth & shell | `/` only redirected; unknown URLs hit Next's bare 404; drawer links in the tab order while closed and Tab escaping it while open | a public landing; a localized 404 with a way home in every group; skip link; drawer inert when closed, modal when open |
| Dashboards & analytics | flat stat walls, zero values shouting, raw counts | grouped sections, quiet zeros, dense counts, checked-in-of-enrolled, formatted ranges |
| Reception | search low on a phone, check-ins in the wrong session after a dialog double-submit | search first, live banner, a closing dialog cannot submit |
| Lists | "Open" buttons, labels `display:none` from `md`, 768 columns crushed, one-tap destructive verbs | the name is the link, labels `sr-only`, columns that fit 768, `ConfirmAction` everywhere |
| Detail pages | Arabic ID card text anchored at the wrong end; void/refund reasons cramped | card fixed (both gates assert it), 44px void/refund with labelled reasons |
| Dialogs & forms | a refused submit cleared the form; settings dialogs bare; autofill of the user's own details into a student's | input kept, shared `DialogShell`, `autoComplete` off for others' details, client validation with the server's schema, error summary |
| Settings | the permissions matrix silently dropped revokes; three staff actions silent | matrix saves exactly what is shown; every staff action answers |
| Portals | request form open above every list; 6,000px schedules; grey "Request to join" | disclosure, capped lists, brand outline button |
| Print | pale labels, unsorted teacher roster, a receipt pushed whole to page two | ink-safe tokens, sorted roster table, breaks only between rows |

Per-screen images: `design-review/baseline/` → `design-review/after/` (same file names).
