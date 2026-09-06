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
`--background: var(--bg-canvas)` · `--card: var(--bg-surface)` · `--muted: var(--bg-subtle)` · `--primary`/`--ring`/`--sidebar-primary`: `var(--brand)` · `--destructive: var(--danger)` · the sidebar family maps to `--bg-sidebar` / `--bg-sidebar-hover` / `--text-on-dark`. The semantic set is exposed as Tailwind utilities too: `bg-success-bg text-success`, `text-text-muted`, `bg-canvas`, `bg-surface-subtle`.

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
- **Borders:** 1px `--border`. Prefer a border over a shadow for table and list separation.

---

## 5. Core component patterns

**Sidebar** — dark (`--bg-sidebar`), fixed, 240px (`w-60`), or a **72px icon rail (`w-18`) when collapsed** (M3). Logo + center name at top, nav items with icon + label, active item highlighted with the brand color, user block + sign-out pinned at the bottom, and a collapse toggle (`PanelLeftClose`/`PanelLeftOpen`) above it. Collapsed: labels hide (kept in the accessibility tree via `sr-only`, not unmounted) and the native `title` attribute gives a hover tooltip — no separate tooltip library for a single-line label. The preference is a plain (non-httpOnly) cookie (`lib/ui/sidebar-cookie.ts`, `kayedu_sidebar_collapsed`) written directly by the client on toggle and read server-side by each experience layout before the first paint, so there is no expand-then-snap-shut flash. Mirrors correctly in RTL: the toggle icon flips with `rtl:-scale-x-100`, and the content area's padding uses the logical `ps-*` property so it always tracks the sidebar's actual edge. **Collapses to a full-screen drawer under `lg`** regardless of the collapse preference — a full-screen sheet has no need for an icon rail — hamburger in the header, overlay + slide-in panel, Escape and overlay-tap close it, body scroll locked while open. Implemented in `components/shell/app-shell.tsx`; a single item is `components/shell/nav-item.tsx` (icon + label, brand fill plus a logical start-edge indicator when active, 44px minimum height, a `collapsed` variant, and a `Soon` badge for routes a later milestone owns). Items come from `components/shell/nav.ts`, filtered by `can(role, permission)` so a receptionist never sees a link they can't open.

**Dialog** (M3) — the standard pattern for "Add X" on every list-first entity screen (students, teachers, and every later one). A centered card (`max-w-lg`, rounded, `shadow-card-hover`) from `sm` up; **a full-screen sheet below `sm`**, per the modal→sheet rule in §6. Implemented in `components/ui/dialog.tsx` wrapping Base UI's `Dialog` primitives (already a dependency — `components/ui/button.tsx` uses the same package), exporting `Dialog`/`DialogTrigger`/`DialogContent`/`DialogHeader`/`DialogBody`/`DialogFooter`/`DialogTitle`/`DialogDescription`/`DialogClose`. Backdrop fades and the popup scales in on open using Base UI's `data-starting-style`/`data-ending-style` attributes — plain CSS transitions, no animation library. A visible close button sits at the popup's logical end corner (`end-3 top-3`) and is always present unless explicitly suppressed. Centering uses `-translate-x-1/2`/`-translate-y-1/2`, which needs no RTL mirroring — moving to the exact center is the same operation in either direction. The list page composes it as a small client wrapper (e.g. `add-student-dialog.tsx`) that controls `open` state itself so the form inside can close the dialog on success (`onCreated` callback) while staying open on a duplicate-match result so staff can confirm the link.

**KPI / stat card** — white surface, label (12px muted) above a large figure, trend chip below (`▲ 12.4%` in success/danger). Optional colored top border or icon chip to differentiate. Implemented in `components/shared/stat-card.tsx`: `trend` takes a direction plus an already-localized label, with `invertColor` for metrics where a rise is bad news (expenses, absences) so the color follows the meaning rather than the arrow; `accent` paints the top border; the icon sits in a tinted chip. The figure itself is never colored.

**Data table** — subtle header background, 1px row borders, generous row height (~56px), hover highlight, status as a badge in its own column, avatar+name as a combined cell. **On mobile, tables become stacked cards** — never horizontally scroll a primary table. The configuration screens share one implementation: `components/settings/entity-manager.tsx` takes a field-descriptor list and drives the create form, the row display and an inline edit panel from it, so a new master-data screen is a page file rather than another table. Editing expands in place instead of opening a modal — one behavior on phone and on desktop.

**Status badge** — pill, 12px medium, tinted background + matching text color from the semantic set (e.g. `--success-bg` + `--success`). Live states get a pulsing dot.

**Attendance control** (M5) — four segmented buttons, Present/Late/Absent/Excused (revised from the original three-state mockup — Excused ships as a fourth segment, per spec §5). Unselected = neutral outline; selected = the semantic tint. Large touch targets — this is used hundreds of times a day. Implemented in `components/center/attendance-control.tsx` as one `<form>` with four named submit buttons (`name="status" value="PRESENT"`, …) rather than client selection state, so a click is a single round trip with no separate "confirm" step.

**Payment method selector** (M5) — icon + label buttons in a row (Cash / InstaPay / Wallet / Visa), selected state uses a brand-colored ring. Cash preselected by default. Implemented in `components/center/payment-method-selector.tsx` — client selection state (unlike the Attendance control), because the method is chosen before the surrounding form's own single submit records the payment.

**Receipt / money summary** (M5) — bordered panel, right-aligned figures, clear label→value rows (Total collected / Center share / Teacher share), with counts (present / late / absent / excused) alongside. Implemented in `app/[locale]/(center)/sessions/[id]/session-receipt.tsx`; center/teacher share rows are hidden entirely — not just visually de-emphasized — for a role without `center.profit.view` (spec §7 acceptance criterion 9).

**ID card** — landscape credit-card proportions (85.6 × 54 mm), dark gradient surface, center logo + name, student photo, name, grade, student code, QR block, and a brand-colored band along the bottom edge. Layout positions come from `CenterSettings.cardLayout`. The built-in starting layout lives in `lib/card-layout.ts` and is laid out so no two elements collide in either direction — the M3 gate asserts it. Rendered by `lib/id-card.ts` as a single self-contained SVG on a 320 × 202 unit face: `x`/`y`/`width` are percentages of that face and `fontSize` is in card units, so one layout is correct on screen and at print DPI. `x` is a **logical start** offset — an Arabic card mirrors the whole layout, per §7 — and a missing logo or photo falls back to an initial rather than a gap. The preview (`components/center/id-card-preview.tsx`), the print view (`/students/[id]/card`) and the file stored in `id-cards/` are the same string. The paper printout (`/students/[id]/paper`) is the A4 companion: registration details, parent contacts, enrolments and the same card artwork. Both print views live in the `(print)` route group — the center role gate without the app shell — and their on-screen controls are `print:hidden`.

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
- KPI rows → 2-up on `sm`, 1-up on very small screens.
- Touch targets **min 44×44px**; reception/attendance controls larger still.
- Modals → full-screen sheets on mobile.
- Test at **375px** width as the floor.

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

**No per-slot room picker.** The original mockup showed a room dropdown on every row; the shipped data model keeps one room per class (`ClassGroup.roomId`, docs/01 §2) rather than adding one to `ClassSchedule`, so the room is fixed context in the header panel above, not a per-row field. Conflict detection checks it there — the class's single room against every other class's slots — rather than per slot.

**Weekly Time Slots list:** one row per slot — day dropdown, start/end time pickers, remove (×) icon at the row end. A slot-count summary sits top-right of the section header (e.g. "3 slots this week"); a conflict, when one exists, is shown as the banner below the row it belongs to rather than a header count.

**Conflict display:** when a slot's room/teacher is double-booked, an inline amber banner (`--warning-bg` background, `--warning` text/icon, ⚠ icon) renders directly beneath that slot's row — never a modal or toast. Text pattern: "Room conflict with [Class Name]."

**Add slot:** a `+ Add time slot` text-button below the last row, full-width tap target on mobile.

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

### 11.2 Permissions matrix screen (M12)

The densest screen in the product, and the one most likely to become an unreadable grid.

- **Roles as columns, actions as rows**, grouped by area (People / Classes / Money / Settings / Approvals) with sticky group headers. The role header row is sticky too — a matrix you have to scroll blind is a matrix that gets misconfigured.
- A cell is a checkbox with three visual states: **granted**, **denied**, and **not grantable** (the platform ceiling, `02-architecture.md` §6.1). Not-grantable renders as a dimmed dash with a `title` explaining why — **never an unchecked box**, which would imply an Owner could tick it.
- **OWNER-only screen.** Anyone else does not see the nav item and is redirected at the loader.
- **Below `md` the grid becomes one card per action**, listing the roles as label→value toggle rows — the standard table→card rule (§6), applied to a matrix. Do **not** horizontally scroll it; this is primary data.
- Changes save explicitly (an Apply button with a dirty-state count), never per-cell-on-click: a permission grid that writes on every tick is a grid where a mis-click is a silent privilege change.

### 11.3 Teacher approvals (M15)

Same card queue as the centre `/approvals` screen — deliberately, since a teacher and a manager are reading the same kind of request and should not have to learn two layouts.

- One card per pending student: avatar + local name, class, requested-at, and the two actions.
- **A refusal states its reason in the card, not in a toast.** "Blocked from this class", "class is full — change the room or increase its capacity", "rejected 3 days ago, can re-request in 4 days" (§11.7's copy rule). A toast disappears; the reason needs to stay next to the thing it explains.
- Empty state is a real state, not a blank panel — most teachers have an empty queue most days.

### 11.4 Parent portal (M16)

Visually the **student portal**, with exactly one addition and one subtraction.

- **Addition: the child selector**, in the header where the branch switcher sits for staff. Avatar + name per child; if a parent has one child, **the selector is hidden** and the child's name appears as plain header context.
- **Subtraction: every write control.** No enrol button, no cancel, no rating prompt. Do not render them disabled — remove them. A disabled control tells a parent the feature exists for them and is broken.
- Where a child attends more than one centre, the per-centre grouping the student portal already uses carries over unchanged.

### 11.5 Rating pop-up (M17)

A modal on login (full-screen sheet below `sm`, per §6), and the interaction most at risk of being annoying.

- One row per session from the **last 7 days**: subject + teacher + date, and a 5-star control with 44px targets.
- **Skip is a first-class action, not a dismissal.** A visible "Skip" button of equal weight to "Submit", plus the standard close affordance. It must never be re-shown in the same session after a skip.
- **Partial submission is allowed** — rate two of five, submit, done. Never gate submit on completeness.
- **Never show a count anywhere** — not in the prompt, not in the confirmation. Where an aggregate appears (the Discover class card, §10, and the teacher's own view), it is `4.6 ★` and nothing else. No "(23 ratings)", no distribution bar: a count is what lets a teacher infer who rated them from a small sample.

### 11.6 ID-card layout editor (M18)

Replaces the raw `cardLayout` JSON textarea. **A centre never sees JSON** — that is the whole point of the change.

- **Direct manipulation on a live card preview** at true proportions (85.6 × 54 mm, matching §5's ID card): drag to move, handles to resize, an element **palette** to add from, an **×** to remove.
- Selection shows a small properties strip (font size, alignment) — not a separate panel that hides the card.
- **Snap and bounds:** elements snap to a light grid and cannot be dragged off the face. The M3 gate already asserts the default layout has no collisions; the editor should make a colliding layout hard to produce rather than merely detectable.
- **`x` stays a logical start offset** (§5, `02-architecture.md` §10) — an Arabic card mirrors the whole layout, so the editor previews in the **active locale** and says so.
- Below `md`, editing is a stacked list of elements with numeric position controls rather than a drag surface. Dragging a 320-unit card on a 375px screen is not editing.

### 11.7 Date filter (M18) — one component, everywhere

Replaces every ad-hoc date filter in the product. Analytics, Expenses, Sessions and every later screen use **this** and nothing else.

- A segmented button row: **Day** · **Week** (today −7) · **Month** (1st → today), plus a **specific-date** picker and a **range** picker, an **Apply**, and a **reset to today's default**.
- **Buttons apply immediately; the pickers wait for Apply.** A range that re-queries on the first of the two dates is a range that queries a nonsense window.
- The active selection is always readable as text next to the control ("1–6 Sep") — a highlighted segment alone is not enough once a specific date or range is in play.
- **State lives in the URL** (`02-architecture.md` §14), like pagination, so a filtered view is shareable and back-button-safe.
- Below `md` the segments stay a row (they are short) and the two pickers stack.

### 11.8 Live search dropdown (M18)

Every search input in the product becomes a type-ahead. This is the most-used interaction in the app after attendance, so the details matter more than usual.

- Results appear in a panel below the input: avatar + local name + the matched field (code / phone), **highlighting the matched substring**.
- **Minimum query length before anything fires**, debounced, and bounded to a small result count (`02-architecture.md` §14). A dropdown that loads every student to filter in the browser is the loader that section warns about, in nicer clothes.
- Three states are all real and all need a design: **loading** (a subtle inline spinner in the input, never a layout shift), **no results** (with the "add new" action inline, since at Reception that is the likely next step), and **too short** (silent — no panel at all).
- **Full keyboard support**: ↑/↓ to move, Enter to select, Escape to close. Reception uses a hardware barcode scanner, which types fast and presses Enter — the dropdown must not swallow or reorder that.
- **The QR/scan path bypasses the dropdown entirely**: a scanned `KAYEDU|…` payload resolves straight to the selected-student panel (`lib/id-card.ts`'s `parseStudentQrPayload`), and that panel **must show the student's photo** — it is the anti-impersonation control the static-QR decision rests on (`00-master-product-spec.md` §5.1), and it is currently missing (§7.1).
- Below `md`, the dropdown becomes a full-width sheet under the input, not a floating panel.

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
