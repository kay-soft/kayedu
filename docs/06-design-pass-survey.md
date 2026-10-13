# KayEdu — Design pass survey (R10a)

> Written **before** any R10a code change, from the code as it stood at `c27448c` — not from the docs. Each entry says what was wrong visually and, in the last line, what R10a did about it. Entries marked **R10b** belong to the second design pass (add-student / add-teacher dialogs and the class, session, teacher and student detail pages) and were **not touched**.
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
Red "Total" KPI border (money going out is not an error); the date filter sat in a bare `<form>`; hand-copied list header. **R10a:** neutral KPI, `FilterBar`, `ListHeader`.

### `app/[locale]/(center)/settlements/page.tsx`
"No teachers" was a bare muted sentence in a card. **R10a:** compact `EmptyState`.

### `app/[locale]/(center)/refunds/page.tsx`
Consistent (PageHeader, card, empty state, bordered rows). No change.

### `app/[locale]/(center)/reception/page.tsx`
Page chrome already on the shared parts. Its "Recent check-ins" panel showed a bare muted sentence when empty. **R10a:** compact `EmptyState` there (`recent-check-ins.tsx`). Filter chips already use the single brand selected state.

### `app/[locale]/(center)/settings/page.tsx` (General)
Section header under the settings layout's `PageHeader`; consistent. No change.

### `app/[locale]/(center)/settings/payment-methods/page.tsx`
Consistent (`EntityManager`). **R10a:** its list header uses `ListHeader` via the manager.

### `app/[locale]/(center)/settings/rooms/page.tsx`
Consistent; "needs two rooms" note inside the links manager is a muted sentence (kept — it is an explanation, not an empty list). No change.

### `app/[locale]/(center)/settings/terms/page.tsx`
Consistent (`EntityManager`). No change beyond `ListHeader`.

### `app/[locale]/(center)/settings/catalog/page.tsx`
Page stack used `gap-8` where every other settings page uses `gap-6`. **R10a:** `gap-6`.

### `app/[locale]/(center)/settings/card/page.tsx`
Consistent header; the editor itself is a canvas tool (R9) — no change.

### `app/[locale]/(center)/settings/permissions/page.tsx`
Consistent; matrix already collapses to cards below `md`. No change.

### `app/[locale]/(center)/settings/staff/page.tsx`
Hand-copied list header. **R10a:** `ListHeader`.

### `app/[locale]/(center)/classes/[id]/page.tsx` — **R10b**
Class detail. Not touched.

### `app/[locale]/(center)/sessions/[id]/page.tsx` — **R10b**
Session detail. Not touched.

### `app/[locale]/(center)/teachers/[id]/page.tsx` — **R10b**
Teacher detail. Not touched.

### `app/[locale]/(center)/students/[id]/page.tsx` — **R10b**
Student detail. Not touched.

(The **Add student** and **Add teacher** dialogs are also **R10b**.)

---

## Teacher experience (route group `(teacher)`)

### `app/[locale]/(teacher)/teacher/dashboard/page.tsx`
Hand-drawn `charAt(0)` initial per centre; 5-card KPI row stranded two tiles at `lg`; blue/brand/amber KPI borders. **R10a:** `BrandAvatar`; five-up grid built on a six-column track; neutral KPIs.

### `app/[locale]/(teacher)/teacher/sessions/page.tsx`
Blue KPI border; hand-labelled filter grid (in `session-filters.tsx`). **R10a:** neutral KPI, `FilterField`. (Its forward-looking day/week/month filter stays bespoke — docs/04 §11.7.)

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
Teacher session detail. Not touched.

### `app/[locale]/(teacher)/teacher/students/[id]/page.tsx` — **R10b**
Teacher view of a student. Not touched.

---

## Student experience (route group `(student)`)

### `app/[locale]/(student)/student/schedule/page.tsx`
Consistent. No change.

### `app/[locale]/(student)/student/discover/page.tsx`
Filter labels hand-built (in `discover-filters.tsx`). **R10a:** `FilterField`. The class card's subject-accent top border is the documented rotating subject palette (docs/04 §2), not a status colour.

### `app/[locale]/(student)/student/reservations/page.tsx`
`CardContent … pt-6` double padding. **R10a:** removed.

### `app/[locale]/(student)/student/profile/page.tsx`
Redirect only. No change.

---

## Parent experience (route group `(parent)`)

### `app/[locale]/(parent)/parent/page.tsx`
"No children linked" was a bare muted sentence in a padded card. **R10a:** `EmptyState`.

---

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
Entry redirect. No UI.

### `app/[locale]/(print)/sessions/[id]/print/page.tsx`
Print sheet — outside the shell by design. No change.

### `app/[locale]/(print)/students/[id]/card/page.tsx`
Print sheet. No change.

### `app/[locale]/(print)/students/[id]/paper/page.tsx`
Print sheet. No change.

### `app/[locale]/(print)/teacher/sessions/[id]/print/page.tsx`
Print sheet. No change.

### `app/[locale]/not-found.tsx` (not a `page.tsx`)
Carried its own copy of the locale switch. **R10a:** `LocaleToggle`.
