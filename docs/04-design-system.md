# KayEdu — Design System (Phase 1)

> Derived from the approved visual direction (the five reference screens: Reception Desk, Today's Sessions, Session Detail, Student Profile + ID Card, Analytics). This is the authority for look and feel. Build every screen against these tokens — do not invent new colors, radii, or spacing per screen.

---

## 1. Direction in one line

**Clean, trustworthy, data-dense SaaS** — light working canvas, white cards, a dark sidebar for anchoring, one confident blue as the brand, and color used *only* to carry meaning (status, money, alerts). Calm enough to stare at for eight hours, sharp enough that an owner trusts it with their money.

---

## 2. Color tokens

Define these as CSS variables on `:root` in `globals.css`. The **brand** value is overridden per center at runtime (see architecture §9) — everything else stays fixed.

```css
--brand:            #2563EB;  /* primary blue — per-center overridable */
--brand-fg:         #FFFFFF;

--bg-canvas:        #F5F6F8;  /* app background */
--bg-surface:       #FFFFFF;  /* cards, tables, panels */
--bg-sidebar:       #0F172A;  /* dark navy sidebar */
--bg-sidebar-hover: #1E293B;
--bg-subtle:        #F8FAFC;  /* table header, inset rows */

--text-primary:     #0F172A;
--text-secondary:   #475569;
--text-muted:       #94A3B8;
--text-on-dark:     #E2E8F0;

--border:           #E5E7EB;
--border-subtle:    #F1F5F9;

--success:          #16A34A;  /* present, paid, positive trend */
--success-bg:       #DCFCE7;
--warning:          #F59E0B;  /* late, pending, attention */
--warning-bg:       #FEF3C7;
--danger:           #DC2626;  /* absent, negative trend, destructive */
--danger-bg:        #FEE2E2;
--info:             #3B82F6;  /* upcoming, neutral badge */
--info-bg:          #DBEAFE;
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

**Sidebar** — dark (`--bg-sidebar`), fixed, 240px (`w-60`). Logo + center name at top, nav items with icon + label, active item highlighted with the brand color, user block + sign-out pinned at the bottom. **Collapses to a drawer under `lg`** — hamburger in the header, overlay + slide-in panel, Escape and overlay-tap close it, body scroll locked while open. Implemented in `components/shell/app-shell.tsx`; nav items come from `components/shell/nav.ts`, filtered by `can(role, permission)` so a receptionist never sees a link they can't open.

**KPI / stat card** — white surface, label (12px muted) above a large figure, trend chip below (`▲ 12.4%` in success/danger). Optional colored top border or icon chip to differentiate.

**Data table** — subtle header background, 1px row borders, generous row height (~56px), hover highlight, status as a badge in its own column, avatar+name as a combined cell. **On mobile, tables become stacked cards** — never horizontally scroll a primary table.

**Status badge** — pill, 12px medium, tinted background + matching text color from the semantic set (e.g. `--success-bg` + `--success`). Live states get a pulsing dot.

**Attendance control** — three segmented buttons (حاضر / متأخر / غائب). Unselected = neutral outline; selected = the semantic tint. Large touch targets — this is used hundreds of times a day.

**Payment method selector** — icon + label buttons in a row (Cash / InstaPay / Wallet / Visa), selected state uses a brand-colored ring. Cash preselected by default.

**Receipt / money summary** — bordered panel, right-aligned figures, clear label→value rows (Total collected / Center share / Teacher share), with counts (present / absent / paid) alongside.

**ID card** — landscape credit-card proportions, dark gradient surface, center logo + name, student photo, name, grade, student code, QR block. Layout positions come from `CenterSettings.cardLayout`.

**Alert note** — amber-tinted panel with icon for operational warnings (e.g. "absent 3 sessions in a row — consider contacting the guardian").

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
