# KayEdu — Design System (Phase 1)

> Derived from the approved visual direction (the five reference screens: Reception Desk, Today's Sessions, Session Detail, Student Profile + ID Card, Analytics). This is the authority for look and feel. Build every screen against these tokens — do not invent new colors, radii, or spacing per screen.

---

## 1. Direction in one line

**Clean, trustworthy, data-dense SaaS** — light working canvas, white cards, a dark sidebar for anchoring, one confident blue as the brand, and color used _only_ to carry meaning (status, money, alerts). Calm enough to stare at for eight hours, sharp enough that an owner trusts it with their money.

---

## 2. Color tokens

Define these as CSS variables on `:root` in `globals.css`. The **brand** value is overridden per center at runtime (see architecture §9) — everything else stays fixed.

```css
--brand: #2563eb; /* primary blue — per-center overridable */
--brand-fg: #ffffff;

--bg-canvas: #f5f6f8; /* app background */
--bg-surface: #ffffff; /* cards, tables, panels */
--bg-sidebar: #0f172a; /* dark navy sidebar */
--bg-sidebar-hover: #1e293b;
--bg-subtle: #f8fafc; /* table header, inset rows */

--text-primary: #0f172a;
--text-secondary: #475569;
--text-muted: #94a3b8;
--text-on-dark: #e2e8f0;

--border: #e5e7eb;
--border-subtle: #f1f5f9;
--border-strong: #cbd5e1; /* the border a control takes on hover */

/* Interaction surfaces. `--bg-subtle` is a *resting* inset (table headers,
   read-only panels), so it cannot double as the hover tint for a control
   that already sits on one. These are the two steps above it. */
--bg-hover: #f1f5f9; /* pointer over an interactive surface */
--bg-active: #e2e8f0; /* pressed */

--success: #16a34a; /* present, paid, positive trend */
--success-bg: #dcfce7;
--warning: #f59e0b; /* late, pending, attention */
--warning-bg: #fef3c7;
--danger: #dc2626; /* absent, negative trend, destructive */
--danger-bg: #fee2e2;
--info: #3b82f6; /* upcoming, neutral badge */
--info-bg: #dbeafe;
```

**How these bind to shadcn (`app/globals.css`).** The tokens above are the source; the base-nova variables are aliases onto them, so components inherit the palette without per-screen overrides:
`--background: var(--bg-canvas)` · `--card: var(--bg-surface)` · `--muted: var(--bg-subtle)` · `--primary`/`--ring`/`--sidebar-primary`: `var(--brand)` · `--destructive: var(--danger)` · the sidebar family maps to `--bg-sidebar` / `--bg-sidebar-hover` / `--text-on-dark`. The semantic set is exposed as Tailwind utilities too: `bg-success-bg text-success`, `text-text-muted`, `bg-canvas`, `bg-surface-subtle`, `bg-surface-hover`, `bg-surface-active`, `border-border-strong`.

**Semantic color rules (non-negotiable — consistency here is what makes the app readable at a glance):**

- **Present / Paid / positive** → success green.
- **Late / Pending / warning** → amber.
- **Absent / Void / negative** → danger red.
- **Upcoming / neutral / informational** → info blue.
- **Live / in-progress** → success green with a pulsing dot.
- Money figures are **never** colored except for trend indicators (▲ green / ▼ red).
- Subject tags may use a rotating accent palette (blue, green, purple, amber, rose) — assigned per subject, consistent app-wide.

---

## 3. Typography

- **Font:** Cairo (already loaded via `next/font` — covers Arabic + Latin). One family everywhere.
- **Numerals:** Arabic-Indic (٠١٢٣) in `ar`, Latin (0123) in `en`, via a shared `Intl` formatter helper. Never mix within a locale.
- **Times:** 12-hour with a meridiem — `4:00 PM` / `٤:٠٠ م`, never `16:00`. A start–end pair renders as one range through `formatTimeRange` (`4:00 – 5:30 PM`), which collapses the shared meridiem and picks the locale’s own separator rather than a hand-joined en dash. A formatted time needs no `dir="ltr"` wrapper — the string carries its own direction.
- **Wherever a session is listed, its date rides with its time.** A time alone answers “when in the day”, not “which day”. The two today-only surfaces — the dashboard’s *Today* rail and Reception — are the exception: there the date is the screen’s premise.
- **Scale:**
  | Use | Size / weight |
  |---|---|
  | Page title | 24px / 700 |
  | Section heading | 18px / 600 |
  | Card title | 16px / 600 |
  | Body | 14px / 400 |
  | Table cell | 14px / 400 |
  | Label / caption | 12px / 500, `--text-muted` |
  | KPI figure | 30–36px / 700 |
- Arabic needs slightly more line-height than Latin: use `leading-relaxed` for Arabic body copy.

---

## 4. Shape, spacing & elevation

- **Radius:** cards & panels `12px`; buttons, inputs, badges `8px`; pills & avatars `full`.
  In Tailwind: `--radius: 0.5rem` makes `rounded-lg` = 8px (buttons/inputs/badges) and `--radius-xl` is pinned to `0.75rem` = 12px (cards). Use `rounded-lg` and `rounded-xl`; don't hand-write radii.
- **Spacing scale:** 4 / 8 / 12 / 16 / 24 / 32 px. Card padding `24px` desktop, `16px` mobile.
- **Shadows:** soft and minimal — `0 1px 3px rgba(15,23,42,.06)` at rest, `0 4px 12px rgba(15,23,42,.08)` on hover/elevated. Available as the `shadow-card` / `shadow-card-hover` utilities. No heavy drop shadows.
- **Borders:** 1px `--border` at rest, `--border-strong` on hover for anything interactive. Prefer a border over a shadow for table and list separation.
- **Floating surfaces** (popover, dropdown, calendar) use `shadow-popover` — deeper than a card, because they sit *above* the page rather than in it.

**Motion.** Short, consistent, and always in answer to something the user did.

```css
--motion-fast: 120ms; /* hover, press, small state flips */
--motion-base: 160ms; /* the default for every interactive element */
--motion-slow: 200ms; /* drawers, popovers, anything that travels */
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

Apply them through the `transition-ui` / `transition-ui-fast` utilities rather than per-component `transition-colors`, so hover, press and focus feel identical everywhere. Nothing bounces, nothing lingers, and **nothing animates at all under `prefers-reduced-motion: reduce`** — one global rule in `globals.css`, so a component added later cannot forget it.

**Interaction states are not optional.** Every interactive element has a visible **hover**, **active**, **focus-visible** and **disabled** state. `Button` carries all four on its base class, so no variant can ship without them; everything that is not a `Button` — links, list rows, calendar days, menu items — applies the `focus-ring` utility (`focus-ring-inverse` on the dark sidebar) instead of writing its own ring. Focus rings are keyboard-only (`:focus-visible`) and always drawn from `--ring`.

**Content width.** One rule, applied by the app shell and nothing else: `--content-max: 96rem`, centred, via the `content-shell` utility. The header bar and the page body share it, so they align. A 1280px laptop is unchanged; a wide monitor gets a wider working area instead of a narrow column stranded in grey.

---

## 5. Core component patterns

**Sidebar** — dark (`--bg-sidebar`), fixed, 240px (`w-60`), or a **72px icon rail (`w-18`) when collapsed** (M3). Logo + center name at top, nav items with icon + label, active item highlighted with the brand color, user block + sign-out pinned at the bottom, and a collapse toggle (`PanelLeftClose`/`PanelLeftOpen`) above it. Collapsed: labels hide (kept in the accessibility tree via `sr-only`, not unmounted) and the native `title` attribute gives a hover tooltip — no separate tooltip library for a single-line label. The preference is a plain (non-httpOnly) cookie (`lib/ui/sidebar-cookie.ts`, `kayedu_sidebar_collapsed`) written directly by the client on toggle and read server-side by each experience layout before the first paint, so there is no expand-then-snap-shut flash. Mirrors correctly in RTL: the toggle icon flips with `rtl:-scale-x-100`, and the content area's padding uses the logical `ps-*` property so it always tracks the sidebar's actual edge. **Collapses to a full-screen drawer under `lg`** regardless of the collapse preference — a full-screen sheet has no need for an icon rail — hamburger in the header, overlay + slide-in panel, Escape and overlay-tap close it, body scroll locked while open. Implemented in `components/shell/app-shell.tsx`; a single item is `components/shell/nav-item.tsx` (icon + label, brand fill plus a logical start-edge indicator when active, 44px minimum height, a `collapsed` variant, and a `Soon` badge for routes a later milestone owns). Items come from `components/shell/nav.ts`, filtered by `can(role, permission)` so a receptionist never sees a link they can't open.

**Dialog** (M3) — the standard pattern for "Add X" on every list-first entity screen (students, teachers, and every later one). A centered card (`max-w-lg`, rounded, `shadow-card-hover`) from `sm` up; **a full-screen sheet below `sm`**, per the modal→sheet rule in §6. Implemented in `components/ui/dialog.tsx` wrapping Base UI's `Dialog` primitives (already a dependency — `components/ui/button.tsx` uses the same package), exporting `Dialog`/`DialogTrigger`/`DialogContent`/`DialogHeader`/`DialogBody`/`DialogFooter`/`DialogTitle`/`DialogDescription`/`DialogClose`. Backdrop fades and the popup scales in on open using Base UI's `data-starting-style`/`data-ending-style` attributes — plain CSS transitions, no animation library. A visible close button sits at the popup's logical end corner (`end-3 top-3`) and is always present unless explicitly suppressed. Centering uses `-translate-x-1/2`/`-translate-y-1/2`, which needs no RTL mirroring — moving to the exact center is the same operation in either direction. The list page composes it as a small client wrapper (e.g. `add-student-dialog.tsx`) that controls `open` state itself so the form inside can close the dialog on success (`onCreated` callback) while staying open on a duplicate-match result so staff can confirm the link. **Settings master data (R1):** `components/settings/entity-manager.tsx` takes `addVia="dialog"` to put its create form behind an "Add" button in the list card's header (`CardAction`) instead of the always-open add card above the list — used by Settings → Payment methods; rooms keep the original inline card. Rename/deactivate/delete stay inline on each row either way.

**KPI / stat card** — white surface, label (12px muted) above a large figure, trend chip below (`▲ 12.4%` in success/danger). Optional colored top border or icon chip to differentiate. Implemented in `components/shared/stat-card.tsx`: `trend` takes a direction plus an already-localized label, with `invertColor` for metrics where a rise is bad news (expenses, absences) so the color follows the meaning rather than the arrow; `accent` paints the top border; the icon sits in a tinted chip. The figure itself is never colored. **A zero gets its own treatment** (`zero` + `zeroLabel`): the figure dims and a one-line "no activity in this range" sits under it, because a wall of bold `EGP 0` reads as a broken screen rather than as an answer.

**Data table** — subtle header background, 1px row borders, generous row height (~56px), hover highlight, status as a badge in its own column, avatar+name as a combined cell. **On mobile, tables become stacked cards** — never horizontally scroll a primary table. A column's fixed width is *table* layout, so it is scoped `md:` and up: a card column has no column width, and an unscoped `w-28` truncated money and dates inside a card that had room to spare. The configuration screens share one implementation: `components/settings/entity-manager.tsx` takes a field-descriptor list and drives the create form, the row display and an inline edit panel from it, so a new master-data screen is a page file rather than another table. Editing expands in place instead of opening a modal — one behavior on phone and on desktop.

**Status badge** — pill, 12px medium, tinted background + matching text color from the semantic set (e.g. `--success-bg` + `--success`). Live states get a pulsing dot.

**Attendance control** (M5, revised R1) — three segmented buttons, **Present / Late / Absent** (green / amber / red). R1 removed the fourth segment the M5 build had added (spec §5.1 "Excused removed"), returning to the original three-state mockup. Unselected = neutral outline; selected = the semantic tint. Large touch targets — this is used hundreds of times a day. Implemented in `components/center/attendance-control.tsx` as one `<form>` with three named submit buttons (`name="status" value="PRESENT"`, …) rather than client selection state, so a click is a single round trip with no separate "confirm" step. The status order and tints are exported (`ATTENDANCE_STATUS_ORDER`/`ATTENDANCE_STATUS_TINT`). **R2:** the control is for *corrections* only — an unmarked roster row shows a single **Check in** button instead (Present or Late is decided by the server from the arrival time), and neither Reception's check-in form nor the add-attendee panel offers a status at all; Reception shows a one-line muted note under the payment method saying the status is automatic. `interceptStatus`/`onIntercept` turn one segment into a plain button that opens a confirmation instead of submitting — the roster uses it for **Absent on a paid student**, whose row also says, in muted text, that switching to Absent voids the payment.

**Payment method selector** (M5, revised R1) — icon + label buttons in a row, wrapping, selected state uses a brand-colored ring. The options are **the centre's own active methods** (R1 — Settings → Payment methods), passed in by the page, not a hardcoded list; the centre's first (oldest) method is preselected. Because the names are centre-entered, every button shares one generic wallet icon and a long name truncates inside its button rather than widening the row. Implemented in `components/center/payment-method-selector.tsx` — client selection state (unlike the Attendance control), because the method is chosen before the surrounding form's own single submit records the payment; it submits `paymentMethodId`. A recorded payment always displays its frozen `methodLabelSnapshot`, never the method's current name.

**Receipt / money summary** (M5) — bordered panel, right-aligned figures, clear label→value rows (Total collected / Center share / Teacher share), with counts (present / late / absent — three equal columns at every width) alongside. Implemented in `app/[locale]/(center)/sessions/[id]/session-receipt.tsx`; center/teacher share rows are hidden entirely — not just visually de-emphasized — for a role without `center.profit.view` (spec §7 acceptance criterion 9). **R2:** below the counts, a **Closed** row (time in the centre's timezone + who, or "automatically, end of day"), or for a session still open a muted "not closed yet — figures can still change" line; then, only when something changed, a **"Changes during session"** list — one muted tile per change: student, *from → to*, time · who, the optional reason, and a red **Payment voided** pill when the change voided one. No empty section is ever drawn.

**ID card** — landscape credit-card proportions (85.6 × 54 mm), dark gradient surface, center logo + name, student photo, name, grade, student code, QR block, and a brand-colored band along the bottom edge. Layout positions come from `CenterSettings.cardLayout`. The built-in starting layout lives in `lib/card-layout.ts` and is laid out so no two elements collide in either direction — the M3 gate asserts it. Rendered by `lib/id-card.ts` as a single self-contained SVG on a 320 × 202 unit face: `x`/`y`/`width` are percentages of that face and `fontSize` is in card units, so one layout is correct on screen and at print DPI. `x` is a **logical start** offset — an Arabic card mirrors the whole layout, per §7 — and a missing logo or photo falls back to an initial rather than a gap. The preview (`components/center/id-card-preview.tsx`), the print view (`/students/[id]/card`) and the file stored in `id-cards/` are the same string. The paper printout (`/students/[id]/paper`) is the A4 companion: registration details, parent contacts, enrolments and the same card artwork. Both print views live in the `(print)` route group — the center role gate without the app shell — and their on-screen controls are `print:hidden`.

**App bar** — the header is a real bar, not a strip of text links: `content-shell`-aligned, 64px, sticky, translucent over the canvas. It carries, from the start edge, the mobile drawer trigger and the **branch switcher** (§11.1); from the end edge, the **language toggle** and the **user menu**. Implemented across `components/shell/app-shell.tsx`, `components/shell/branch-switcher.tsx`, `components/shell/user-menu.tsx` and `components/shared/locale-switcher.tsx`. The user menu exists because below `lg` the sidebar is a drawer, and *who am I signed in as* / *sign out* must not live behind a navigation drawer. The language toggle is a two-segment track with a filled active segment — two states are a segmented control, not a dropdown.

**Avatar** (`components/shared/brand-avatar.tsx`) — a centre's logo when one is set, otherwise its initial on the centre's own theme colour. The sidebar, the branch switcher and the centre-selection cards all render this one component, so a branch looks the same in all three. The initial comes from `lib/initials.ts` — `centerInitial` for an organisation/branch (code-point aware, skips punctuation and a leading generic word such as `مركز` / "Academy"), `nameInitial` / `personInitials` for a person. Never `name.charAt(0)`: it returns half a surrogate pair on an astral character and happily takes a quote mark as the initial.

**Select** (`components/ui/select.tsx`) — the product's one dropdown, built on Base UI's `Select`. It replaces the native `<select>`: the old control styled the *closed* box but handed the open list to the browser, so the most-used control in the ERP dropped out of the design system the moment anyone clicked it, and the option list ignored the app's direction in Arabic. This renders the list itself — 44px rows, brand-tinted selection, a check on the chosen item, keyboard and type-ahead support, correct RTL alignment — and still posts a real form value from `name`, so no form's payload changed. Accepts the list either as an `options` array or as plain `<option>` children. `submitOnChange` reproduces the filter bars' "re-query on change", fired from an effect so the hidden input is written before the form serialises.

**Checkbox & switch** (`components/ui/checkbox.tsx`, `components/ui/switch.tsx`) — replace `<input type="checkbox" className="accent-…">`, which tinted the OS control but left its size, radius, focus ring and disabled treatment to the browser. A **checkbox** is a value that will be true when you save (the permission matrix, which saves on Apply); a **switch** is a setting that is on *now* (`ToggleRow` on the configuration screens). The switch's thumb travels on a logical inset, so it slides toward the end edge in both directions.

**Date control** (`components/ui/calendar.tsx`, `components/ui/date-picker.tsx`) — the app's own month grid, replacing `<input type="date">` everywhere. The browser's calendar ignores the app's locale and direction, renders Latin digits inside an Arabic screen, and looks different in every browser the desk happens to run. This one formats its month heading, weekday initials and day numbers through `lib/format.ts` (so Arabic-Indic in `ar`), opens the week on Saturday in `ar` and Sunday in `en`, does all arithmetic in UTC to match every stored date, and supports single and range selection with the span highlighted between the two ends and previewed under the pointer. Full arrow-key navigation, with left/right reversed in a right-to-left grid. `DatePicker` is the single-date form control: same 44px height as `Input`, same `"YYYY-MM-DD"` value posted, an optional inline clear for a filter with an "any date" state.

**Every floating surface is portalled to `<body>`, without exception.** `Card` sets `overflow-hidden` for its rounded corners, and almost every filter, search box and form in the product sits inside a card — so an absolutely-positioned panel gets clipped at the card's edge. Select, DatePicker, DateFilter, Dialog, Popover and the type-ahead dropdown all portal out and position in viewport coordinates. A new dropdown that positions itself with `absolute` inside the page flow is a bug waiting for the first card it lands in.

**Popover** (`components/ui/popover.tsx`) — one floating-surface pattern for the branch switcher, the user menu and the date control, opening with the same `data-starting-style`/`data-ending-style` CSS transition the dialog established. Base UI's `align="start"`/`"end"` are logical, so a popover anchored to the start edge stays there in Arabic. **`components/shell/ui-direction.tsx` wraps the app in Base UI's `DirectionProvider`** — `<html dir>` alone is not enough, and without it every popover, select and dropdown anchored to the left in Arabic.

**Empty state** (`components/shared/empty-state.tsx`) — an icon in a tinted chip, a short title naming the absence, a line explaining what *would* appear here, and, where the screen has one, the action that creates the first item. It replaced thirty-odd single dimmed sentences floating in cards, which read as a screen that failed to load rather than a screen with nothing in it yet. `tone` carries meaning: `info` for "nothing here yet", `warning` for "nothing matched what you asked for" (something is filtered, and the action is *clear the filter*), `success` for a queue that is legitimately empty, `muted` for a secondary panel.

**Loading state** (`components/shared/skeleton.tsx`) — skeletons compose into the layout the real screen uses (`SkeletonPageHeader`, `SkeletonStatRow`, `SkeletonList`, `SkeletonPage`), never a single grey bar standing in for a page. Every route group has a `loading.tsx` built from these, so nothing shifts when the data lands. The pulse is plain CSS, stopped by the global reduced-motion rule.

**Error state** (`components/shared/error-state.tsx`) — what every `error.tsx` renders. Says what happened in the interface's voice, offers the retry React's boundary already gives us, and shows the raw message **only in development** (an ORM error string can name a table, a column, or an id from another tenant). Each route group has its own boundary so the shell — sidebar, branch context, language — stays usable while one screen has failed; `app/[locale]/not-found.tsx` and `app/[locale]/error.tsx` are the backstops outside any shell.

**Button & link button** — `Button` (`components/ui/button.tsx`) carries hover/active/focus-visible/disabled on its base class. A *link* that acts as a button is `LinkButton` / `AnchorButton` (`components/shared/link-button.tsx`), same variants and sizes, default size `touch` (44px). Twenty-five screens had hand-written this as a bare `<Link>` with a copied class string — each slightly different, none with a focus ring — so the most common navigation affordance in the ERP was the one control a keyboard user could not see.

**Request card** (`components/shared/request-card.tsx`) — one pending request in an approvals queue; see §11.3.

**KPI grid** (`components/shared/stat-grid.tsx`) — a KPI row's column count is chosen for the number of cards in it, not left at a fixed `sm:2 / xl:4`. Above five cards there is no arrangement that divides cleanly at every breakpoint; that is the signal to split the row by meaning, which is what Analytics now does (money in / what it left behind; students / teachers).

**Alert note** — amber-tinted panel with icon for operational warnings (e.g. "absent 3 sessions in a row — consider contacting the guardian").

**Form fields (mandatory, M3).** Two rules apply to every text input in the product, retroactively:
1. **A field that is genuinely, unconditionally optional gets a dimmed "(optional)"** beside its label (`Shared.optional` in `messages/*.json`) — never leave staff to guess or hit a validation error to find out. Don't apply it to a field that is only *conditionally* required (e.g. "phone or email, at least one") — a hint sentence explains that correctly where a flat "(optional)" tag would lie. `components/shared/field.tsx`'s `Field` takes an `optional` prop that renders this consistently; `components/settings/entity-fields.tsx` derives it automatically from `required`/`emptyLabel` for the five master-data screens.
2. **Every text input gets a dimmed placeholder showing the expected format** — a phone field shows `01012345678`, an email field shows `name@example.com`, a name field shows a real example name. Placeholders are translated strings (never hardcoded, CLAUDE.md rule 5) so they read naturally in both locales; keep them as literal, plausible examples, not instructions like "enter your phone."

---

## 6. Responsive rules (mandatory)

Every screen must work on a phone. Breakpoints: `sm 640` / `md 768` / `lg 1024` / `xl 1280`.

- **Mobile-first**: build the small layout, then enhance upward.
- Sidebar → hamburger drawer below `lg`.
- Multi-column grids → single column below `md`.
- Tables → stacked cards below `md` (label/value pairs), never a horizontal scroll for primary data.
- KPI rows → 2-up on `sm`, 1-up on very small screens, and the wide arrangement chosen for the card count (`StatGrid`, §5) — never a fixed four-wide grid that leaves an orphan row.
- Touch targets **min 44×44px**; reception/attendance controls larger still.
- Modals → full-screen sheets on mobile.
- Test at **375px** width as the floor, and at **2560px** as the ceiling: content is centred and capped at `--content-max` by the `content-shell` utility (§4), applied by the app shell only.

---

## 7. RTL rules

- Logical properties only: `ps-*/pe-*`, `ms-*/me-*`, `text-start/end`, `start-*/end-*`. **Never** `left/right`, `pl/pr`, `ml/mr`.
- Icons that imply direction (arrows, chevrons, back) must mirror in RTL; icons that don't (calendar, user, money) must not.
- Charts: axis and legend placement follow reading direction; numeric axes stay conventional.
- Every screen is reviewed in **both** `ar` and `en` before it's considered done.

---

## 8. Reference screens

The approved direction is exemplified by: **Reception Desk** (search + student card + payment/attendance selectors + live session rail), **Today's Sessions** (KPI row + filters + data table), **Session Detail** (session panel + roster + receipt summary + absence alert), **Student Profile** (header stats + per-subject weekly attendance chips + ID card preview), **Analytics** (KPI cards with trends + revenue chart + per-teacher breakdown).

When building any of these, match this structure and these tokens. Deviations need a reason.

---

## 9. Class Schedule Builder (M4 reference, revised)

Used when editing a `ClassGroup`'s `ClassSchedule` rows. Header shows read-only class context (subject+grade, teacher, room, active-status badge) in a bordered panel above the slot list — same panel style as a KPI card border, not a data table.

**No per-slot room picker.** The original mockup showed a room dropdown on every row; the shipped data model keeps one room **set** per class (`ClassGroup.roomId` + combined extra rooms, R3, docs/01 §2) rather than adding one to `ClassSchedule`, so the rooms are fixed context in the header panel above ("Room 1 + Room 2", plus a Seats row: enrolled of the set's summed capacity), not a per-row field. Conflict detection checks every room of the set rather than per slot — since R4 against the real dated sessions of every other class across this class's **whole period**, so one notice (and one "I understand") covers the entire range.

**Weekly Time Slots list:** one row per slot — day dropdown, start/end time pickers, remove (×) icon at the row end. A slot-count summary sits top-right of the section header (e.g. "3 slots this week"); a conflict, when one exists, is shown as the banner below the row it belongs to rather than a header count.

**Conflict display:** when a slot's room/teacher is double-booked, `SlotConflictNotice` (§11.12) renders directly beneath that slot's row — never a modal or toast — previewed live while the day/time is edited, with the "I understand, create anyway" checkbox the row's Save waits for under WARN, and red with no override under DENY.

**Add slot:** a `+ Add time slot` text-button below the last row, full-width tap target on mobile.

**After a save (R4):** adding, moving or removing a slot resyncs the class's upcoming sessions, and `SessionSyncNotice` sits under the row — a green line ("12 sessions created · 11 upcoming sessions removed") and, when any were kept, an amber one ("3 upcoming sessions were kept because they already have records or custom changes"). See §11.13.

**Mobile (< md):** slot rows stack into single cards (day/time/room as label→value pairs, matching the existing table→card responsive rule in §6) rather than a row grid. Remove control and Add button stay 44px+.

---

## 10. Student Discover / Browse (M8 reference)

Marketplace-style grid for browsing published classes. Filter bar: grade / subject / day as pill-style dropdowns, result count right-aligned ("N classes found").

**Class card:** white surface, `12px` radius, a 4px colored top border using the rotating subject-accent palette from §2 (assigned per subject, consistent app-wide — not per center). Contents: subject name (bold) + subject name in second locale beneath in muted text, status badge top-right (`Open` = info blue, `Requires Approval` = amber, `Pending` = amber, matching `ReservationStatus`), teacher avatar (initials, subject-accent color) + name, grade as a small outline chip, price right-aligned (never colored — money display rule from §2 still applies), schedule summary line with a calendar icon. **As of M17, the teacher's rating** sits beside their name as `4.6 ★` — an **average out of 5 only**, with **no count and no distribution**, and omitted entirely when the teacher has no ratings yet (§11.5).

**Action button (bottom of card, full width):**

- Instant enroll (`requiresConfirmation = false`) → solid brand-blue button, label "Enroll."
- Needs approval (`requiresConfirmation = true`) → outlined brand-blue button, label "Request to Join."
- After a request is sent, the button is replaced by a `Pending` badge (amber) in the same position — no button shown.

**Grid:** 3-up desktop, collapses to single column below `md` per §6. Filter bar collapses to a single "Filters" trigger opening a bottom sheet on mobile, per the existing modal→sheet rule.

> **Note:** currency in all mockups must read **EGP**, not SAR — Phase 1 is Egypt-only per `00-master-product-spec.md` §1. Money still displays via `lib/format.ts`, never inline formatting.

---

## 11. New and changed surfaces (M11–M19)

Every pattern here inherits §2's tokens, §6's responsive rules and §7's RTL rules without exception. What follows is only what is *specific* to each surface — where a rule is not restated, the general one applies unchanged.

### 11.1 Branch switcher (M11)

Lives in the header, beside the centre logo, **not** in the sidebar — it changes the scope of everything below it, so it must stay visible when the sidebar collapses to a rail or a drawer (§5).

- A single control: the active branch name plus a chevron. Opens a list of the branches this user resolves to (`02-architecture.md` §4), with **"Whole Management"** pinned at the top when the user holds more than one.
- **Hidden entirely for a single-branch user.** No disabled control, no dropdown with one item — the same reasoning `/select-center` already follows for a single-centre user.
- **"Whole Management" must look different from a branch, not merely be first.** It is a scope, not a place: give it an icon and a divider below it, so nobody reads it as another branch name.
- **Roll-up is analytics-only** (`00-master-product-spec.md` §4.1). When "Whole Management" is active, operational nav items (Reception, Sessions, Approvals) are **disabled with a one-line reason** — "pick a branch to use the desk" — never silently missing. A nav item that vanishes reads as a permission problem.
- Mobile: the switcher moves into the drawer header, full-width, 44px minimum.

**Delivered** as `components/shell/branch-switcher.tsx`, in the app bar (§5). It replaced a plain "Switch branch" text link that showed no branch context at all — the one thing a switcher exists to show. The trigger *is* the context (the branch's mark plus its name); the panel is the list, with "Whole Management" pinned above a divider under a `Layers` icon so it cannot be read as one more branch name, and a check on whatever is currently in scope. Each row submits the same `selectCenterAction` the `/select-center` hub uses — the switch itself is unchanged, only where it can be reached from. Hidden entirely below two branches, per the rule above. Below `sm` the trigger collapses to the mark and chevron alone; the branch name is in the panel.

### 11.2 Permissions matrix screen (M12)

The densest screen in the product, and the one most likely to become an unreadable grid.

- **Roles as columns, actions as rows**, grouped by area (People / Classes / Money / Settings / Approvals) with sticky group headers. The role header row is sticky too — a matrix you have to scroll blind is a matrix that gets misconfigured.
- A cell is a checkbox with three visual states: **granted**, **denied**, and **not grantable** (the platform ceiling, `02-architecture.md` §6.1). Not-grantable renders as a dimmed dash with a `title` explaining why — **never an unchecked box**, which would imply an Owner could tick it.
- **OWNER-only screen.** Anyone else does not see the nav item and is redirected at the loader.
- **Below `md` the grid becomes one card per action**, listing the roles as label→value toggle rows — the standard table→card rule (§6), applied to a matrix. Do **not** horizontally scroll it; this is primary data.
- Changes save explicitly (an Apply button with a dirty-state count), never per-cell-on-click: a permission grid that writes on every tick is a grid where a mis-click is a silent privilege change.

**Delivered, with one part of this section still outstanding.** The header row and the action column are both sticky (`app/[locale]/(center)/settings/permissions/permissions-form.tsx`), inside an explicit max-height scroll box — sticky needs a scroll container, and `overflow-x: auto` alone had made the page's own scrolling the wrong one to stick against. Cells are the shared `Checkbox` (§5); not-grantable still renders as a dimmed dash, never an unchecked box. **Grouping the rows by area with sticky group headers has not shipped** — that is a content decision (which action belongs to People vs Money) rather than a presentation one, and it is the remaining gap against this section.

### 11.3 Teacher approvals (M15)

Same card queue as the centre `/approvals` screen — deliberately, since a teacher and a manager are reading the same kind of request and should not have to learn two layouts.

- One card per pending student: avatar + local name, class, requested-at, and the two actions.
- **A refusal states its reason in the card, not in a toast.** "Blocked from this class", "class is full — move it to a bigger room or combine another room with it" (R3: the cap is the room set's), "rejected 3 days ago, can re-request in 4 days" (§11.7's copy rule). A toast disappears; the reason needs to stay next to the thing it explains.
- Empty state is a real state, not a blank panel — most teachers have an empty queue most days.

**Delivered as `components/shared/request-card.tsx`, shared by `/approvals` and `/teacher/approvals`.** The centre queue carries four genuinely different asks — a teacher proposing a **new class**, a teacher asking for a one-off **session**, a student requesting a **place**, and a teacher asking to work at this branch at all (**onboarding**) — and all four used to render as the same anonymous bordered box, so a manager could not tell what kind of decision they were about to make until they read the body text.

- **The kind is the first thing the card says**: a distinct icon, a named badge, and a detail grid holding the fields that kind actually turns on (day/time/attendance/late-threshold — no capacity since R3 — for a class; date/time for a session; price for a reservation).
- `kind` is a *category, not a status*, so it takes no semantic colour (§2 reserves those). The icon and the label carry it; the badge stays neutral.
- **Onboarding is derived, not stored**: a `NEW_CLASS` request from a requester with no local `Membership` is a teacher asking to work here, which is the same database row but a different decision. It gets its own kind and an info note saying so — approving is a decision about the class, not about hiring.
- Requester, requested-on, note and the two actions are identical across kinds on purpose: those parts of the decision genuinely are the same and should not have to be re-learned per queue.
- Below `lg` the actions move under the card, full-width; from `lg` they pin to the card's end edge.

### 11.4 Parent portal (M16)

Visually the **student portal**, with exactly one addition and one subtraction.

- **Addition: the child selector**, in the header where the branch switcher sits for staff. Avatar + name per child; if a parent has one child, **the selector is hidden** and the child's name appears as plain header context.
- **Subtraction: every write control.** No enrol button, no cancel, no rating prompt. Do not render them disabled — remove them. A disabled control tells a parent the feature exists for them and is broken.
- Where a child attends more than one centre, the per-centre grouping the student portal already uses carries over unchanged.

### 11.5 Rating pop-up (M17)

A modal on login (full-screen sheet below `sm`, per §6), and the interaction most at risk of being annoying.

- One row per session from the **last 7 days**: subject + teacher + date, and a 5-star control with 44px targets. **Delivered as real stars** (`app/[locale]/(student)/rating-popup.tsx`), not numbered buttons: the run up to the pointer fills as a preview, so the score is legible before it is committed, and each star is still a single submit — a click is the whole interaction, with no separate confirm step.
- **Skip is a first-class action, not a dismissal.** A visible "Skip" button of equal weight to "Submit", plus the standard close affordance. It must never be re-shown in the same session after a skip.
- **Partial submission is allowed** — rate two of five, submit, done. Never gate submit on completeness.
- **Never show a count anywhere** — not in the prompt, not in the confirmation. Where an aggregate appears (the Discover class card, §10, and the teacher's own view), it is `4.6 ★` and nothing else. No "(23 ratings)", no distribution bar: a count is what lets a teacher infer who rated them from a small sample.

### 11.6 ID-card layout editor (delivered M18)

Replaces the raw `cardLayout` JSON textarea. **A centre never sees JSON** — that is the whole point of the change.

- **Direct manipulation on a live card preview** at true proportions (85.6 × 54 mm, matching §5's ID card): drag to move, handles to resize, an element **palette** to add from, an **×** to remove.
- Selection shows a small properties strip (font size, alignment) — not a separate panel that hides the card.
- **Snap and bounds:** elements snap to a light grid and cannot be dragged off the face. The M3 gate already asserts the default layout has no collisions; the editor should make a colliding layout hard to produce rather than merely detectable.
- **`x` stays a logical start offset** (§5, `02-architecture.md` §10) — an Arabic card mirrors the whole layout, so the editor previews in the **active locale** and says so.
- Below `md`, editing is a stacked list of elements with numeric position controls rather than a drag surface. Dragging a 320-unit card on a 375px screen is not editing.

**Delivered, with two corrections to this section's own draft assumptions.** `app/[locale]/(center)/settings/card/card-form.tsx` — drag-to-move is real pointer-based dragging on the preview, snapped to a 2% grid, clamped 0–100%, using logical `insetInlineStart`/`top` so the RTL mirror needs no special-case code. **"Resize" is the properties strip's numeric field, not a drag handle** — `lib/id-card.ts`'s `CardElement` has no `width` on four of the seven elements (`centerName`/`studentName`/`grade`/`studentCode`), only `fontSize`, so a corner-handle would have nothing to resize on most elements; one shared numeric control (width for the three image elements, font size for the rest) covers all seven the same way. **"Alignment" is not a control at all** — this section's draft assumed one, but nothing in `CardElement` stores an alignment; text anchor is *always* derived from `dir` (`lib/id-card.ts`'s `text()`), so there is nothing for a per-element alignment toggle to write to. The palette/× map onto a real, new distinction in `resolveCardLayout`: a JSON `null` for an element key means "removed" (never rendered), separate from "absent" (still means "use the built-in default") — previously there was no way to express "removed" at all.

### 11.7 Date filter (delivered M18) — one component, everywhere

Replaces every ad-hoc date filter in the product. Analytics, Expenses, Sessions and every later screen use **this** and nothing else.

- A segmented button row: **Day** · **Week** (today −7) · **Month** (1st → today), plus a **specific-date** picker and a **range** picker, an **Apply**, and a **reset to today's default**.
- **Buttons apply immediately; the pickers wait for Apply.** A range that re-queries on the first of the two dates is a range that queries a nonsense window.
- The active selection is always readable as text next to the control ("1–6 Sep") — a highlighted segment alone is not enough once a specific date or range is in play.
- **State lives in the URL** (`02-architecture.md` §14), like pagination, so a filtered view is shareable and back-button-safe.
- Below `md` the segments stay a row (they are short) and the two pickers stack.

**Delivered** as `components/shared/date-filter.tsx`, on Analytics, Expenses and Sessions.

**Revised presentation: one control, not five.** The first delivery put a segmented row, two separate picker toggles, two native `<input type="date">` fields and a stray Reset link on four different baselines — three date affordances for one job, two of them drawn by the browser. It is now a **single trigger** reading the active selection ("Range: 1–6 Sep"), opening **one panel** that holds the presets beside one range calendar: pick a start, pick an end, the span highlights between them and previews under the pointer, and **a start with no end *is* the specific-date case**. One Apply, in the panel's footer, disabled until there is something to apply. Reset is an icon button beside the trigger, on the same baseline. The presets still apply on click; the calendar still waits for Apply.

**The URL contract is unchanged** — `range` / `date` / `from` / `to`, same schema, same parser — so a bookmarked filtered view resolves exactly as it did. Every visible control writes to the same four hidden inputs and nothing else, so there is exactly one `range` value in the query; Apply fires from an effect, after those inputs are written, and submits the page's real form so the screen's other filters ride along untouched.

**Single-date filters use the same calendar, not the same component**: `/student/schedule`, `/parent` and `/teacher/sessions` filter by one `?date=`, so they render `DatePicker` (§5) — the same month grid, the same locale and direction, an inline clear for the "any date" state. The teacher session list keeps its own forward-looking day/week/month for the reason recorded below. **One deliberate exception, not an oversight**: the teacher's own session list (`/teacher/sessions`) keeps its own bespoke day/week/month filter rather than adopting this component, because its "week"/"month" are forward-looking (today → today+6/+29, "what's coming up," spec §4.2 item 2) while this component's are backward-looking by definition (today−7 → today, 1st-of-month → today) — the two are answering different questions, and unifying them would have silently turned an upcoming-sessions view into a recent-sessions one.

### 11.8 Live search dropdown (delivered M18)

Every search input in the product becomes a type-ahead. This is the most-used interaction in the app after attendance, so the details matter more than usual.

- Results appear in a panel below the input: avatar + local name + the matched field (code / phone), **highlighting the matched substring**.
- **Minimum query length before anything fires**, debounced, and bounded to a small result count (`02-architecture.md` §14). A dropdown that loads every student to filter in the browser is the loader that section warns about, in nicer clothes.
- Three states are all real and all need a design: **loading** (a subtle inline spinner in the input, never a layout shift), **no results** (with the "add new" action inline, since at Reception that is the likely next step), and **too short** (silent — no panel at all).
- **Full keyboard support**: ↑/↓ to move, Enter to select, Escape to close. Reception uses a hardware barcode scanner, which types fast and presses Enter — the dropdown must not swallow or reorder that. **Scanner contract (R7):** a submit reads the input element's own value, cancels the pending debounce and any in-flight search, and Enter selects a suggestion **only after an arrow-key highlight** — hovering a row never arms Enter and typing clears the highlight, so a scan can never select a stale suggestion under a resting mouse.
- **The QR/scan path bypasses the dropdown entirely**: a scanned `KAYEDU|…` payload resolves straight to the selected-student panel (`lib/id-card.ts`'s `parseScannedStudentInput` — the one tolerant reader), and that panel **must show the student's photo** — it is the anti-impersonation control the static-QR decision rests on (`00-master-product-spec.md` §5.1), delivered in the same milestone (§7.1).
- Below `md`, the dropdown becomes a full-width sheet under the input, not a floating panel.

**Delivered as `components/center/type-ahead-search.tsx`: 300ms debounce, a 2-character minimum, 8 results.** Loading/no-results/too-short are all real, distinct states exactly as specified. Two details landed narrower than this section's draft: rows show **name + the matched field as plain text**, not an avatar and not a highlighted substring — no avatar image exists to show for most of these lists (teachers/students have no thumbnail beyond the ID-card photo, which reception's own selected-student panel already covers separately, §7.1), and substring-highlighting was left for a follow-up pass rather than blocking the rest of the sweep on it. The "add new" inline action in the empty state is supported by the component (an `emptyAction` slot) but not yet wired into any screen — none of the nine screens converted pass one today. Below `md` the dropdown is a `w-full` panel directly under the input; on Reception and the other single-column mobile layouts this already reads as the full-width sheet the spec calls for, so no separate mobile variant was needed.

**Fixed after the presentation pass: the panel was being clipped.** It positioned itself with `absolute` inside the form, and the form sits inside a `Card`, whose `overflow-hidden` cut the list off a few pixels below the input — on Reception, Students, Teachers, Classes, the session and class detail pages, and both teacher lists. It now renders through `createPortal` into `<body>` as a `fixed` panel measured against the input's own bounding rect, so no ancestor's `overflow` can clip it and no ancestor's `transform` can re-anchor it. `left`/`width` come from the measured rect, which is correct in both reading directions with no special case. It follows scroll (capture-phase, so nested scroll containers count) and resize, flips above the input only when there is genuinely more room there, and the outside-click handler checks the portalled panel as well as the form — otherwise every click on a result would have read as a click outside.

### 11.9 Settlements & refunds (M14)

- **Settlement status** uses the existing semantic set (§2) and adds no new colours: `DRAFT` = neutral/muted, `APPROVED` = info blue, `PAID` = success green. There is **no partially-paid state** and therefore no amber — do not invent one.
- **A refund is shown alongside its original payment, never in place of it.** The original row stays legible with a `REFUNDED` badge (danger tint, matching Void's treatment) and the refund appears as a linked child row. Replacing the original would misrepresent an append-only ledger as an editable one.
- **Void and refund must never look the same.** They are different events with different analytics effects (`00-master-product-spec.md` §5); give the badges distinct labels and keep both visible.
- Money figures stay uncoloured (§2) — the badge carries the meaning, not the number.

### 11.10 Out-of-window empty state (M19)

When a read is refused because it falls outside the data-visibility window, the screen shows a **named** empty state, not a blank chart or a zero.

- Copy pattern: *"Data older than 30 days isn't shown at this centre."* Plus, for a role that can change it, a link to `/settings/visibility`.
- **A zero is the wrong answer here** — a chart rendering 0 EGP for last quarter reads as "we earned nothing", not "you can't see this", and that is a genuinely dangerous ambiguity on a money screen.
- Uses the **Alert note** pattern (§5), info-tinted rather than amber: nothing is wrong, something is simply out of view.

---

### 11.11 Session lifecycle (R2)

- **End session** — a destructive-tinted button (`Lock` icon) with a one-line hint beside it ("End the session when the class is over…"), shown only on a LIVE session to a role with `session.close`. It opens the standard Dialog (a full-screen sheet below `sm`): title, what ending does, then an amber note stating it **cannot be undone**; Cancel is the outline button, the destructive confirm is last. `EndSessionButton` takes only a session id so R7 can drop it into the reception desk unchanged.
- **Closed banner** — a neutral, full-width strip above the two columns (`Lock` icon, `bg-surface-subtle`): when and by whom the session was closed, or "closed automatically at the end of the day because it was not closed manually", then "attendance and payments are locked". Not a semantic colour — a closed session is a normal end state, not an error.
- **Closed layout** — every attendance/payment control disappears (statuses render as neutral badges, as for a cancelled session), the add-student panel and cancel/reschedule are hidden, and the **receipt card moves to the top of the side column** with a **Print receipt** link button under it. Below `xl` the column stacks under the roster, so on a phone the banner is the first thing seen and the receipt follows the roster.
- **Void-on-absent confirmation** — the same Dialog: "Mark {name} absent?", a sentence naming the amount and saying it is a void, not a cash refund, an optional reason field (dimmed "(optional)", placeholder example), and a destructive "Mark absent and void payment" confirm.
- **Print** — `/sessions/[id]/print` reuses the teacher print sheet (`components/shared/session-print-sheet.tsx`) and toolbar: A4, `print:hidden` toolbar, the receipt block identical to the screen's, including the changes section.

### 11.12 Room sets & double-booking (R3)

- **`SlotConflictNotice`** (`components/center/slot-conflict-notice.tsx`) — the one presentation of a double-booking, in every form that writes a slot (class create and edit, schedule rows and add-slot, reschedule, session "Rooms", reactivating a class from the list, NEW_SESSION approval, and — R5 — the New session dialog; R4 removed the generator result). Under the centre's **WARN** policy: an amber panel (`--warning-bg`, `--warning` text, `AlertTriangle`) — a title, then one line per clash in full: "**Room 1** is already booked by **Maths · Grade 5**, 4:00–6:00 PM on 12 Nov" / "…every Monday" for a weekly slot / "**Ms. Salma** is already teaching …" for the teacher — and an **"I understand, create anyway"** checkbox (`Checkbox`, 44px row) with a muted line saying the confirmation is audited. The form's submit stays **disabled** until it is ticked; changing the slot or rooms changes the list and clears the tick. Under **DENY**: the danger pair (`--danger-bg`/`--danger`, `Ban` icon), the same list, a hint to pick another day/time/room/teacher, **no** checkbox. Purely presentational — the live preview behind it is advisory, the server decides. `useSlotConflicts` (same file) is the debounced preview hook every form uses.
- **Combine-rooms control** (`components/center/room-set-picker.tsx`, `RoomSetPicker`) — the primary-room `Select` (each option shows its seats), then a bordered fieldset **"Combine with another room"**: one checkbox row per room the centre has linked **to the chosen primary** — nothing else is offered, and changing the primary drops extras not linked to it. Before a primary is chosen it says so; with no linked rooms it says none can be combined yet. Under it a live line: "Room 1 + Room 2 = 50 seats" (or "no seat limit" when a room has none set). Used by the class form and the New session dialog (primary required) and by the session's reschedule and "Rooms" forms (primary optional). Full width on a phone; rows are 44px.
- **Settings → Rooms, "Rooms that can be combined"** (`room-links-manager.tsx`) — a card under the room list: one bordered block per active room with "Can be combined with" checkboxes for every other active room (two columns from `sm`, one on a phone), a preview line per ticked pairing ("Room 1 + Room 2 = 50 seats"), and a Save button that stays disabled until something changed. A refusal (pair still in use) shows as the block's own error message naming how many classes/sessions use it.
- **Seats, not capacity.** Class lists show "enrolled / seats" from the room set; the class and session context panels show the rooms joined with " + " and a Seats row. No screen offers a class capacity input any more.

### 11.13 Class period & Terms (R4)

- **Class period** (`components/center/class-period-fields.tsx`, `ClassPeriodFields`) — a bordered section inside the class form (create dialog and edit card), below the room set, titled "Class period" with a calendar-range icon. Its header carries a **two-segment control** — **Choose a term** · **Custom dates** — styled exactly like the language toggle (§5 "App bar": a 44px track, the active segment filled with `--surface` and `shadow-card`); two states are a segmented control, not a dropdown. *Choose a term* shows a `Select` of the centre's **active** terms, each option "Semester 1 · 1 Sep 2026 – 31 Jan 2027"; picking one **fills** the two date fields below. The two shared `DatePicker`s (§5 "Date control") are always visible — start and end side by side from `sm`, stacked on a phone — and editing either after a term filled them switches the control to *Custom dates* (the term no longer describes them). With **no terms configured**, the term segment is disabled and a muted hint links to Settings → Terms. A muted footnote says sessions are created for every weekly slot from today until the end date, skipping holidays. Errors (`endBeforeStart`, `periodTooLong`, `required`) sit under the end/start field like every other field error. Nothing about the term is posted — only the two dates.
- **Period on lists and detail.** A class row shows, under its subject, one muted line "9 Oct 2026 – 1 Apr 2027 · 48 sessions" (`formatDayRange`, always the stored calendar day — `lib/format.ts` formats date-only markers in UTC). The class page's **Sessions** card (it replaced the generator card) shows the period, the session count, a muted note when the class is deactivated, and — when any upcoming session no longer matches the class but was kept — an amber panel listing up to ten of them (date · time, each linking to the session) with "…and N more" and a hint to cancel or reschedule them by hand.
- **`SessionSyncNotice`** (`components/center/session-sync-notice.tsx`) — what a class write did to its sessions: one success line joining "N sessions created · N upcoming sessions removed · N moved to the new teacher or rooms · N cancelled" ("Saved. No sessions needed to change." when nothing moved), plus a separate **amber** line for the kept count. Used under the class edit form, the schedule builder rows, the list's activate/deactivate control and the holiday calendar.
- **Delete refused → Deactivate.** A class that already ran cannot be deleted: the refusal is a red panel (`--danger-bg`) titled "This class cannot be deleted because:" with one bullet per blocker and its count (sessions started, attendance records, payments, settlements, ratings, rescheduled sessions, enrolments, enrolment requests), and — on an active class — a 44px outline **Deactivate** button beside the explanation that its upcoming sessions are removed and its history kept.
- **Reactivating from the list** may come back with a double-booking: the row grows a full-width `SlotConflictNotice` and an "Activate anyway" button that waits for the tick under WARN (none under DENY); a period that has already ended comes back as a plain error asking to extend the end date first.
- **Settings → Terms** (`app/[locale]/(center)/settings/terms/page.tsx`) — the R1 add-via-dialog `EntityManager`, three fields: **Name** (text, placeholder "Semester 1"), **Starts** and **Ends** (the shared `DatePicker` — `EntityFields` gained a `date` kind for this). Rows show the name and both dates (stacked label/value cards below `md`, a table row from `md`); inline edit, activate/deactivate and delete exactly like payment methods. The page and list descriptions say plainly that a class **copies** a term's dates, so editing or deleting a term never moves a class, and that terms may overlap. Errors: `duplicateName` (any case), `endBeforeStart`, `periodTooLong`.

### 11.14 New session, extra and one-time sessions (R5)

- **"New session" button** — the Sessions tab's page-header action (a 44px primary `Button` with `CalendarPlus`), shown only to who holds `session.manage`. It opens the shared `Dialog` (a centred modal from `sm`, a **full-screen sheet below `sm`**, §6). *R6 re-laid the dialog out in the shared shell with sectioned cards, a searchable class and teacher picker and the `TimePicker` — see §11.15 and §11.16; where the field list below and §11.15 differ on layout, §11.15 wins.*
- **The dialog** (`app/[locale]/(center)/sessions/new-session-dialog.tsx`) opens with a **two-segment control** — **For a class** · **One-time session** — styled exactly like the class period control (§11.13: a 44px track, the active segment `--surface` + `shadow-card`; *For a class* is disabled when the branch has no active class), and a muted one-line hint under it saying what the mode means. Fields, one column on a phone and two from `sm`, all through `Field` with errors under each:
  - *For a class*: **Class** (`Select` of active classes, "Subject · Grade"); choosing one **fills** the teacher, the room set and the start/end of the class's slot on the chosen weekday (else its first slot). Then **Teacher** (prefilled; picking another shows the hint "Substitute — not the class's usual teacher"), **Date** (the shared `DatePicker`, defaults to today in the centre's timezone, hint "Today or later…"), **Start/End** (time inputs, `dir="ltr"`), and the **room set** (`RoomSetPicker`, primary required, combine control). A muted footnote says price and centre cut come from the class.
  - *One-time session*: **Title** (required, `maxLength` 80, with an example hint), optional **Subject** and **Grade** (the branch's active catalog picks, "(optional)"), then Teacher, Date, Start/End and the room set as above, then the same **money panel** the class form uses (bordered: Price · Centre cut type · Value, with the live centre/teacher split line from `lib/money.ts` and a footnote that the cut is frozen onto each payment). The cut defaults to the branch's default.
  - Below the fields: an **info** `FormMessage` when the date is on the holiday calendar ("…The session will still be created" — never a block), then `SlotConflictNotice` (§11.12) previewing the same conflict list the save checks. The submit ("Create session", full width on a phone) stays disabled under DENY and until a WARN list is ticked. On success the dialog closes and opens the new session's page.
- **Kind badge** (`components/shared/session-kind-badge.tsx`, `SessionKindBadge`) — next to the session's name on the Sessions list rows (it wraps under the name in the stacked mobile card), the session detail header (before the status badge), and the teacher's session list and detail: **"One-time"** in the `brand` badge, **"Extra session"** in the `neutral` badge; a session the class's own schedule made shows nothing. Never a semantic status colour (§2) — those keep meaning present/late/absent/upcoming.
- **A one-time session's name** everywhere is its title, followed by its subject and grade when set ("Exam revision day · Physics · Grade 10"); in two-line cards (student/parent schedule and history) the title leads the subject line. The roster of a one-time session has no "enrolled" rows — everyone is a drop-in — and the list's "Marked" column shows a single count with no "/ enrolled".
- **Delete session** — on the session detail's context card, under the reschedule/rooms/cancel controls, only while the session is a manual or one-time session that has not started and has nothing recorded on it: a 44px outline button in `--danger` text with `Trash2`, a muted hint ("Only possible while nothing has been recorded on it. Otherwise, cancel it."), and a confirmation `Dialog` (title, one-line body, "Keep it" / destructive "Delete session"). Success returns to the Sessions list; a refusal shows inline (`sessionInUse`).

### 11.15 Dialog shell, sections, action bar, time control (R6)

R6 re-laid out the class and session dialogs around one shell and a handful of shared parts, so the five dialogs (New class, Edit class, New session, Edit rooms, Reschedule) cannot drift apart.

- **The shell** (`components/shared/dialog-shell.tsx`, `DialogShell`) wraps the existing `Dialog` primitives (no new library). **Desktop:** a wide card, `max-w-4xl` (~896px), `max-h-[90vh]`; the popup clips and **only the body scrolls** between a **fixed header** (title, description, close) and a **fixed footer** — the title and the actions never scroll away. **Below `sm`:** the full-screen sheet of §6, same three bands, the footer's buttons stacked full-width. The footer is identical everywhere and is passed as labels, not markup: **Cancel** (outline) and one **primary** action, both `h-11` (44px), `w-full` on a phone and `sm:min-w-28` from `sm` (`DIALOG_ACTION_CLASS`); on a phone the primary is on top (`flex-col-reverse`). A dialog that only confirms (End session, Delete session) uses `size="narrow"` (`max-w-lg`) and a destructive primary. `formProps` makes header-body-footer one `<form>` so the footer's submit button submits it. `DialogLauncher` mounts a **fresh instance on every open** (a new `key`), so a dialog never shows the last attempt's errors; closing leaves it mounted for the exit transition.
- **Sections** (`FormSection`, `DialogSections`) — titled cards inside the body (a bordered `rounded-xl` panel, a 14px semibold title with a muted icon, an optional one-line description). **Two columns from `lg`, one below**; a section that needs the full width takes `wide`. **New class** (`ClassFields`): *Basics* (subject · grade · education system, three across from `sm`, wide) → left column *Teacher* + *Room(s)*, right column *Class period* → *Weekly schedule* (wide) → *Pricing & branch cut* beside *Attendance & enrollment*. **New session** and **Reschedule** use the same pattern (*Session / Teacher / Date & time / Room(s) / Price & branch cut*). Related fields sit side by side so the common path needs little or no scrolling at 1280px.
- **Teacher section of New class** — a two-segment control (the §11.13 look: a 44px track, the active segment `--surface` + `shadow-card`): **Select teacher** (the searchable picker, §11.16) · **New teacher** (the Add teacher form's own fields — phone lookup, name, phone/email/alt phone — and its `MatchPanel`). Both panes stay mounted, so toggling never loses what was typed. A phone that already belongs to a person shows the info `MatchPanel` with its explicit **Use this person** button (the dialog's primary is held back while a match waits); a person who already teaches here gets an info panel with **Select {name}**; a staff member's or administrator's phone is refused in the error banner. After any refusal the banner names the half that failed — "The teacher could not be created: …" / "The class could not be created: …" — and the form keeps everything typed (it submits through `startTransition`, not a `<form action>`, which React 19 resets).
- **Weekly schedule rows** (`components/center/weekly-schedule-rows.tsx`) — one bordered row per weekly slot: a weekday `Select`, the paired time control, a 44px remove button (off on the last row — at least one is required) and **Add row** below (the next unused weekday, the previous row's times copied). Two rows on one weekday that overlap are rejected inline on the second, in the danger colour. The **conflict notice sits inside this card**, directly under the rows (R3's `SlotConflictNotice`, §11.12, unchanged: amber under WARN with the one confirm tick, red under DENY), and the dialog's primary stays disabled until a WARN list is ticked and always under DENY. On **Edit class** the notice sits full-width right under the teacher/rooms/period cards it concerns (`placementNotice`).
- **Edit class** is a dialog opened from the class page's header (it replaced the inline "Class record" card); same sectioned fields, no schedule card — an existing class keeps its weekly-slot editor on its own page (each slot resyncs the period). Delete and Deactivate live in its footer's start side (destructive, separated from the primary) with the R4 blockers panel in the body.
- **Action bar** (`components/shared/action-bar.tsx`, `ActionBar` + `ActionBarButton`) — the row of verbs on a detail page or card (session detail: **Reschedule · Edit rooms · Cancel session · Delete session**). A **two-column grid on a phone** (375px stays two clean columns, never a ragged flow), a wrapping flex row from `sm`. Every button is `h-11 px-4 gap-2` with a 16px icon; a destructive verb differs by **colour only** (`variant="destructive"`), never by size. A refusal message spans the bar's full width beneath it. Use it for any class-detail bar you touch.
- **Time control** (`components/ui/time-picker.tsx`, `TimePicker`) — replaces every native time field. A 44px text field plus a clock button opening a popover (the date control's pattern, §5): an **hour list** (1–12), a **minute column** with **00 / 15 / 30 / 45 as quick picks** above the full 00–59 list, and an **AM/PM toggle** (ص / م in Arabic), then **Done**. The text field is typeable and parsed on blur or Enter by `lib/time-input.ts` (`4`, `4pm`, `16:30`, `4:30 pm`, Arabic-Indic digits, ص/م); it is shown back in the locale's 12-hour form by `lib/format.ts`. **Invalid text shows an inline error under the field and posts nothing** — it is never guessed at. It posts the stored 24-hour `"HH:mm"` through a hidden input. A bare hour that could be either meridiem ("4") takes the meridiem of the value being edited, else is read on the 24-hour clock; a leading zero ("04:30") or an hour above 12 is always 24-hour.
- **Paired start/end** (`components/center/time-range-fields.tsx`, `TimeRangeFields`) — the one start/end control (class rows, New session, Reschedule, the schedule builder, the teacher portal's request forms). Choosing a **start suggests the end** as start + the previous duration (one hour when there was none, held inside the day); an end that is not after the start is an inline error on the pair.

### 11.16 Searchable combobox (R6)

`components/ui/combobox.tsx` (`Combobox`) is the one searchable picker; `components/center/teacher-picker.tsx` (`TeacherPicker`) is its teacher form, used in **every** class and session dialog, and the New session dialog's class picker is the same component. A 44px input with a clear button and a chevron that opens the whole list; the list is portalled (a dialog's scrolling body never clips it), rows are `min-h-11` with the **name** and, beneath it, the **phone** (`dir="ltr"`, muted), the highlighted row `--brand` at 10%, a check on the chosen one, and a muted **"No teachers match…"** row when nothing does. **Type to filter** — no minimum length — by name **and** phone: a phone-looking query (`+20 100 123 4567`, `0100…`, `100…`, a tail of digits, Arabic-Indic digits) is matched against the phone through `lib/phone.ts` (`phoneMatchesQuery` — the single normalizer's family, no second implementation); anything with letters is split into words that must each be in the name or the phone (`lib/picker-search.ts`, which also ignores case, accents and Arabic diacritics). Up/Down move, Enter picks, Escape closes; built on Base UI's Combobox (`role="combobox"`, a `listbox` of `option`s, `aria-activedescendant`), so the accessibility is the primitive's. The list is the centre's **active** teachers, scoped by `centerId` on the server — the client only filters it. It posts the chosen value under its `name`. The **room picker** keeps R3's `RoomSetPicker` unchanged and simply fits the new section.

### 11.17 Reception desk (R7)

- **Layout.** Page header (Add student, All sessions), then **Find a student** as a full-width card, then **Today's sessions** as a second full-width card — *below*, never beside. The search input is autofocused on load and refocused after every completed action (the search id is `reception-search-input`).
- **Session card.** `rounded-xl` surface card, `p-4`: the session name (a link to the session page, two lines max) and a status badge — **Live** (success, pulsing dot), **Upcoming** (info), **Ended** or **Auto-closed** (neutral) — then icon rows for teacher, time range (LTR run), rooms ("A + B") and **Checked in** (Present + Late, formatted through `lib/format.ts`). Actions sit in the R6 **action bar** (§11.15; 44px, two columns on a phone): **Start attending** (primary, `Play`), **End session** (destructive, R2's component; *disabled* before the session starts with the hint "You can end this session once it has started", hidden without `session.close`), and on an ended card **View receipt** (outline, `Receipt`) in place of both. The card being attended gets a brand ring and an "Attending now" chip instead of Start attending.
- **Grid.** One column below `md`, two at `md`, three at `lg`. Above it, a filter row — **All · Live · Upcoming · Ended** (44px toggle buttons, a 2×2 grid on a phone) and a text filter on name/teacher (`ps-9` with a leading search icon). Filters only hide cards; the order (Live, upcoming by start, ended) never changes.
- **Session mode.** A **sticky banner** under the 64px app bar (`top-16`): `Radio` icon, "Attending: *name · teacher · time*", **Change session** (jumps to the cards) and **Exit** (44px, side by side on a phone). The search placeholder becomes "Scan card or search student". A resolved student opens the **confirm panel** in the Find card: `border-brand/30 bg-brand/5` like the student-first panel, an 80px round **photo** (placeholder icon if none), name (`text-lg font-semibold`), code (LTR), an **Enrolled / Drop-in** badge (success / warning), the **session price** row, the payment-method buttons (§5, default = last used this visit), "Present or Late is set automatically…", and Cancel + **Check in**; "Press Enter to confirm" sits at the start edge from `sm`. Escape cancels. Results of a scan that cannot be confirmed are a single `FormMessage` — info for already-checked-in, warning for not found / inactive / unreadable, error for blocked and another branch's card — and the input is already empty and focused for the next card. A successful check-in shows a success message with the stored status ("Mona checked in — Late") for a few seconds.
- **Recent check-ins.** Under the confirm area, separated by a hairline: title and the running count, then up to eight rows — 36px photo thumbnail (or icon), name, code, Present/Late badge and the time (centre timezone, LTR) — and a **Full roster** link button.
- **Student-first picker.** Each option reads "name · teacher" with the start time at the end edge (44px, `aria-pressed`); only open sessions are offered; with no preselection the submit is disabled. After a check-in the form is replaced by the success message and **Next student**, and the keyboard returns to the search input with its text selected.
- **Receipt dialog.** The shared `DialogShell` (narrow): a full-screen sheet below `md`. Title "Receipt — *session*", the teacher and time as the description, R2's receipt card as the body, **Close** and **Print** (opens the A4 print route in a new tab) in the footer.

## 12. Auth surfaces (presentation pass)

The four signed-out screens — `/login`, `/register`, `/invite/[token]`, `/select-center` — are the first thing anyone sees, and they shipped as a bare white card floating on the app canvas with a header of two loose text links.

- **`(auth)/layout.tsx` is a two-column page from `lg`**: a branded panel on the product's own dark navy (mark, one line of positioning, one soft brand wash anchored to the *logical* end corner so it mirrors), and the form on the light working canvas beside it. The panel carries no information the form needs, so it is the half that disappears below `lg`.
- **Fields go through `Field`** (§5), so label size, hint placement, error placement and the "(optional)" convention are the same here as inside the ERP. Every text input has a format placeholder.
- **Submit buttons show pending state** via `SubmitButton` — spinner plus disabled, so a slow sign-in cannot be double-submitted.
- **`/select-center`'s zero-relation case is a designed empty state** (§5) with both next steps as real buttons — browse classes as a student, or find a branch to teach at — rather than an info banner followed by two links. Branch cards use the shared `BrandAvatar`, which is also what fixed the wrong-initial bug on this screen.

---

## 13. What each screen owes this system

Every route in the product has, without exception:

1. A **designed empty state** for each region that can be empty — icon, title, one line of explanation, and the creating action where one exists (§5).
2. A **loading state** that matches the real layout's shape (`loading.tsx` per route group, §5).
3. An **error state** inside its own shell (`error.tsx` per route group), plus `not-found.tsx` and a locale-level backstop.
4. **Four states on every interactive element** — hover, active, focus-visible, disabled (§4).
5. **No raw browser-default control**: no unstyled `<select>`, no native `<input type="date">` chrome, no `accent-color` checkbox. The design-system components in §5 cover all three.
6. **Both locales and four widths** verified: 375px, tablet, laptop, and a wide monitor capped by `content-shell`.

A screen that does not is not finished, and this list is the checklist to run against it.
