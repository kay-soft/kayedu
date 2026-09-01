# CLAUDE.md — KayEdu

You are working on **KayEdu**, a multi-tenant ERP for Egyptian education centers, with connected teacher and student web portals. This file is your standing context.

## Before implementing anything
Read the relevant docs first — they are the source of truth, not your assumptions:
- `docs/00-master-product-spec.md` — scope, roles, business rules, acceptance criteria
- `docs/01-data-model.md` — entities, financial ledger, tenant isolation
- `docs/02-architecture.md` — folder structure, auth, permissions, i18n, theming
- `docs/03-build-order.md` — milestones and their "Done when" gates
- `docs/04-design-system.md` — colors, typography, components, responsive + RTL rules

If the docs are silent on something that touches **money, permissions, or tenant isolation**, ask instead of assuming.

---

## Working rules (how to operate in this repo)

**1. No browser testing.** Do NOT launch a browser, run headless browser automation, take screenshots, or curl pages in a loop to verify UI. This burns budget for little value. Verify with **static checks only**: `npx tsc --noEmit`, `npx eslint .`, `npx prisma validate`, and unit tests. For anything visual or interactive, **write a short numbered list of what the user should check themselves** and stop.

**2. Always end with staged changes + a commit message.** After any code change: run `git add -A`, then print a suggested commit message (conventional-commit style, e.g. `feat(auth): add membership resolution and center selection`) in a copyable block. **Do not commit or push** — the user reviews and commits.

**3. Keep the docs in sync.** If you change behavior, schema, architecture, or design tokens, update the matching file in `docs/` in the same session. Docs drifting from code is a bug. Mention which docs you updated.

**4. Everything must be responsive.** Every UI must work on phone, tablet, and desktop — not just a laptop monitor. Follow `docs/04-design-system.md` §6: mobile-first, sidebar collapses to a drawer below `lg`, tables become stacked cards below `md` (never horizontal-scroll primary data), min 44×44px touch targets, modals become full-screen sheets on mobile, and 375px width is the floor. A screen that only looks right on desktop is not done.

**5. Stay in scope.** Implement the current milestone only. If a task drifts into Phase 2 territory or another milestone, stop and flag it.

---

## Stack
- **Next.js (App Router) + TypeScript** — one language front to back
- **PostgreSQL via Supabase** (Auth + Storage + Postgres), **Prisma v6** ORM
- **Vercel** hosting, Frankfurt region
- **shadcn/ui + Tailwind** (base-nova style, `rtl: true`), **next-intl** for AR/EN + RTL

## Non-negotiable rules (violating these breaks the product)

1. **Tenant isolation.** Every tenant-scoped query MUST be filtered by `centerId` from the resolved session context. Never query a tenant table without a center scope. Use `getTenantContext()` and the scoped helpers in `lib/db/`. A missing `centerId` filter is a bug.

2. **Money is frozen and append-only.** When recording a `Payment`, compute and store `priceSnapshot`, `centerShareSnapshot`, `teacherShareSnapshot` at that instant. NEVER recompute historical money from current class config. Corrections VOID (with reason + `AuditLog`) and re-create — never UPDATE money fields in place. Money is **integer piastres (EGP × 100)**, never floats.

3. **Center cut logic** lives in exactly one place (`lib/money.ts`) — never inline it:
   ```
   centerShare = shareType === "FIXED"
     ? shareValue
     : Math.round(amount * shareValue / 100);
   teacherShare = amount - centerShare;
   ```

4. **Identity vs membership.** A `User` is global (one per person) and holds only the auth credential (`authId`/`email`/`phone`) plus a platform-wide default name — it is the thing duplicate-matching keys on (verified phone/email only, never name). Their center relationship is a `Membership` (staff/teacher) or `StudentProfile`/`Enrollment` (student), and **that relationship owns its own local name and contact record** (`firstName`/`lastName`/`email`/`phone`/`altPhone`) — seeded from the `User` when the relationship is created, then editable at that center immediately and independently of any other center, with no lock of any kind. Attendance/payments/analytics attach to the scoped record, never the raw `User`. An existing person joining a new center = new membership, not a new user.

5. **i18n / RTL always.** No hardcoded UI strings — everything through `next-intl` (`messages/ar.json`, `messages/en.json`). Logical CSS properties only (`ps-`/`pe-`, `start`/`end`) — never `left`/`right`. Every screen works in both locales.

6. **Roles are hardcoded for now:** OWNER, MANAGER, RECEPTIONIST, TEACHER (via `Membership`) + Super Admin (`user.isPlatformAdmin`) + Student (via `StudentProfile`). No dynamic permission engine yet.

7. **Audit the sensitive stuff.** Financial changes, permission changes, and attendance corrections write an `AuditLog` row.

8. **Design system compliance.** Use the tokens in `docs/04-design-system.md`. Don't invent colors, radii, or spacing per screen. Semantic colors are fixed: present/paid = green, late/pending = amber, absent/void = red, upcoming = blue.

## Architecture conventions
- Route groups by experience: `(center)`, `(teacher)`, `(student)`, `(admin)`, `(auth)` under `app/[locale]/`
- Server Components + Server Actions by default; client components only where interactivity demands
- Data access lives in `lib/db/` behind tenant-scoped functions — components never call Prisma directly
- `zod` validation on every Server Action input
- Every action: `getTenantContext()` → permission check → validate → scoped write → audit if sensitive → `revalidatePath`
- One product, configured. Never fork behavior per center — differences are settings + theming

## Out of scope (Phase 1 — do not build)
Mobile apps · online teaching · homework · exams · AI features · parent portal · online payment gateways · student debt/balances · packages/subscriptions/discounts · SMS/WhatsApp notifications.
