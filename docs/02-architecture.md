# KayEdu — Architecture (Phase 1)

> How the system is wired. Read after `00-master-product-spec.md` and `01-data-model.md`. This is the reference for *how* we build; the build *order* is in `03-build-order.md`.

---

## 1. High-level shape

```
Browser (Next.js RSC + client islands)
      │
      ▼
Next.js App Router  ──►  Server Actions / Route Handlers
      │                        │
      │                        ├─ getTenantContext()  (who + which center + role)
      │                        ├─ lib/db/*  (tenant-scoped Prisma access)
      │                        └─ lib/money.ts, zod validation
      ▼
Supabase:  Postgres (Prisma) + Auth + Storage
      │
      └─ RLS policies on tenant tables (defense-in-depth)
```

One deployment, one database, many centers. A request resolves the current center, the current user's role in that center, and every data read/write is scoped to that center.

---

## 2. Folder structure

```
app/
  [locale]/                     # next-intl locale segment: "ar" | "en"
    page.tsx                    # entry point: redirects by role
    (auth)/
      login/  register/  invite/[token]/  select-center/
      actions.ts                # sign in/up/out, select center, accept invite
    (center)/                   # Owner / Manager / Receptionist — owns the root
      dashboard/
      teachers/  teachers/[id]/
      classes/   classes/[id]/
      students/  students/[id]/
      sessions/  sessions/[id]/
      reception/
      analytics/
      expenses/
      approvals/
      settings/                 # the configuration shell + its sub-nav
        branches/  rooms/       # general (default cut, timeout, late, tz) is /settings
        education-systems/
        grades/  subjects/
        card/                   # cardLayout JSON editor
        permissions/            # receptionist grant toggles
        staff/                  # users & roles: invite, change role, deactivate
    (teacher)/teacher/          # /teacher/dashboard, /teacher/sessions, ...
    (student)/student/          # /student/schedule, /student/discover, ...
    (admin)/admin/              # /admin/centers, /admin/platform
  api/                          # webhooks / edge handlers if needed
components/
  ui/                           # shadcn primitives
  shell/                        # app shell: sidebar, drawer, header, nav config
  settings/                     # entity-manager (shared config CRUD), settings nav
  center/  teacher/  student/   # experience-specific composed components
  shared/                       # tables, filters, receipt, id-card, kpi-card
lib/
  auth/
    session.ts                  # Supabase auth user + User mirror
    active-center.ts            # the active-center cookie
    tenant.ts                   # getTenantContext(), route-group gates
    permissions.ts              # can(role, action) map
  supabase/
    server.ts  client.ts  proxy.ts  env.ts
  db/
    client.ts                   # Prisma singleton
    tenant-scope.ts             # pure scoping primitives (no runtime imports)
    scoped.ts                   # tenant-scoped query helpers
    audit.ts                    # writeAuditLog()
    students.ts  classes.ts  sessions.ts  payments.ts  analytics.ts ...
  money.ts                      # the ONLY center-cut math + piastre helpers
  card-layout.ts                # the default ID-card layout the editor offers
  routes.ts                     # locale-less pathnames + role home paths
  format.ts                     # locale-aware number/date formatting
  i18n/  request.ts  routing.ts  navigation.ts
  validation/                   # zod schemas per entity
  utils.ts
messages/
  ar.json  en.json
prisma/
  schema.prisma  migrations/  seed.ts
scripts/
  isolation-check.ts            # the cross-center acceptance gate (M1)
  config-check.ts               # the center-configuration acceptance gate (M2)
proxy.ts                        # Next 16's middleware file: i18n + auth refresh
docs/
```

**Route groups don't add URL segments**, so the four experiences are separated by an explicit path prefix. The center ERP owns the root (`/dashboard`, `/students`, …) because it is the primary app; teacher, student and admin live under `/teacher`, `/student` and `/admin`. Without this, `(center)/dashboard` and `(teacher)/dashboard` would both resolve to `/dashboard` and collide.

**Route groups map 1:1 to the four experiences.** A user only ever renders inside the group their role permits; the layout for each group enforces the role at the top.

---

## 3. Identity & auth flow

**Supabase Auth** owns credentials (email/password, later phone OTP). Our `User` table mirrors the auth user via `authId` and holds the profile. Flow:

1. **Register / login** through Supabase Auth → we ensure a matching `User` row exists (create on first login).
2. **Resolve memberships:** look up all `Membership` rows (and `StudentProfile` rows) for that user.
3. **Select center:** if the user belongs to >1 center, they hit **`/select-center`** (the home hub). If exactly one, auto-select. The chosen `centerId` is stored in the session (cookie) and drives everything.
4. **Role gate:** each route group's layout checks the membership role for the active center and redirects if not allowed.

**Invites (staff):** Owner/Manager creates an invite → `Invitation` row + unguessable token link → invitee registers/logs in with the invited email → membership created on accept (audited as `membership.create`). Only an Owner may invite another Owner, and an outstanding invite for the same email+role is superseded. **Email delivery is out of Phase 1 scope** (notifications are deferred), so the accept link is shown to the inviter to share manually; it expires after 7 days. Teachers & students self-register and connect to centers (teachers by center invite/trust; students by discovery/enroll).

**Duplicate prevention:** on register, match on verified phone/email. If found, link a new membership/enrollment to the existing `User` instead of creating a person. Merge is a manual, audited admin action.

---

## 4. Tenant resolution & `getTenantContext()`

**URL strategy:** path-based for simplicity now — `app.kayedu.com` with the active center in the session, and center branding applied from it. (Subdomains like `centerx.kayedu.com` can be layered on later via middleware without schema change; both resolve to the same `centerId`.)

`getTenantContext()` is called at the top of every Server Action and protected loader. It returns:
```ts
type TenantContext = {
  user: User;
  center: Center;                     // the active center
  settings: CenterSettings | null;
  membership: Membership | null;      // null for STUDENT / platform-admin contexts
  studentProfile: StudentProfile | null;
  role: TenantRole;                   // Role | "STUDENT" | "PLATFORM_ADMIN"
  roles: TenantRole[];                // a person can be staff *and* teacher here
  grants: PermissionGrants;           // center-configurable extras (see §6)
  isPlatformAdmin: boolean;
};
```
It redirects (never returns) when there is no valid relationship: to `/login` with no user, and to `/select-center` when the cookie is stale or the user belongs to several centers. **No data-access function runs without it.**

**Active center resolution.** The chosen `centerId` lives in an httpOnly cookie (`kayedu_center`). Exactly one center → auto-selected, no hub. Cookies can only be *written* from a Server Action or Route Handler, so selecting persists the cookie while a Server Component simply resolves the single relation on the fly.

**Route-group gates.** Each group layout calls `requireExperience("center" | "teacher" | "student")` (or `requirePlatformAdmin()`), which resolves the context and bounces anyone whose roles don't include that experience to their own home path.

---

## 5. Tenant isolation — two layers

**Layer 1 (primary): application scoping.**
All reads/writes go through `lib/db/*` functions that take the `TenantContext` and inject `centerId` into every `where`. Direct `prisma.*` calls in components/actions are forbidden for tenant tables (enforce by review + a lint rule).

`lib/db/tenant-scope.ts` holds the pure primitives — deliberately free of runtime imports so the isolation check can exercise them outside Next:
```ts
scopedWhere(centerId, where)      // injects centerId; throws if centerId is empty
scopedData(centerId, data)        // same for writes
scopedFindById(delegate, centerId, id)     // → null for another center's id
requireScopedById(delegate, centerId, id)  // → throws TenantScopeError
assertInCenter(centerId, row, entity, id)
```
`lib/db/scoped.ts` composes them into per-model helpers:
```ts
const db = scoped(ctx);
await db.memberships.count({ active: true });   // where: { centerId, active: true }
await db.invitations.findById(id);              // null if it belongs elsewhere
```
**Never `findUnique({ where: { id } })` on a tenant table** — an id from another center must resolve to "not found", not to a row. That is what `scopedFindById` guarantees.

**Layer 2 (backstop): Postgres RLS.**
Enable RLS on every tenant table. Policy shape: a row is visible only if its `center_id` is in the caller's memberships. The catch: **Prisma connects as a role that can bypass RLS unless configured.** Two acceptable setups:
- **(Recommended for a solo dev):** rely on Layer 1 as the enforced boundary, and enable RLS with policies as a *safety net* for any direct/SQL access and for Supabase client reads (Storage, realtime). Keep the Prisma connection role non-superuser.
- **(Stricter):** pass the authenticated user's JWT down so Postgres evaluates `auth.uid()` in policies for every query. More setup; revisit if a security audit demands it.

Either way, **write the two isolation tests early** (shared-teacher no-leak; cross-center-by-ID denied) and run them in CI.

`npm run check:isolation` (`scripts/isolation-check.ts`) is the cross-center-by-ID gate: it creates two throwaway centers, asserts that Center A cannot read a Center B row by id through the scoping primitives, that `requireScopedById` throws, that scoped lists never contain foreign rows, and that an unscoped `where` fails loudly — then cleans up. It needs a reachable database. The shared-teacher no-leak test arrives with the teacher portal in M7.

`npm run check:config` (`scripts/config-check.ts`) is the M2 gate. It configures **two** throwaway centers through one `configureCenter(centerId)` — no per-center branching anywhere — using the same zod schemas the settings actions parse with and the same scoping primitives, then asserts the two configurations are independent, that neither center resolves the other center's config rows by id, that the permission-grant seam widens a receptionist and nobody else, and that the center-cut split is right in both modes. That is the "a second center needs zero code changes" claim, executed.

Both gates import only modules free of `@/` aliases and of Next-runtime imports — which is why `lib/db/tenant-scope.ts`, `lib/money.ts`, `lib/auth/permissions.ts` and `lib/validation/settings.ts` are written that way. Keep it so.

---

## 6. Permissions

Hardcoded map, not a dynamic engine. `lib/auth/permissions.ts` owns one `Permission` union and one `Record<TenantRole, Permission[]>`:
```ts
can(role, "center.profit.view")   // OWNER, MANAGER          (RECEPTIONIST: false)
can(role, "student.delete")       // OWNER, MANAGER
can(role, "attendance.correct")   // OWNER, MANAGER          (RECEPTIONIST: grantable)
can(role, "payment.void")         // OWNER, MANAGER
can(role, "center.settings.edit") // OWNER, MANAGER
can(role, "reception.use")        // OWNER, MANAGER, RECEPTIONIST
can(role, "analytics.own.view")   // TEACHER
```
- **OWNER** = MANAGER + `center.ownership.manage` (the only owner-exclusive action).
- **RECEPTIONIST** = `reception.use`, `attendance.record`, `payment.record`, `student.manage`. Profit and corrections are **denied by default** (spec §3).
- **TEACHER** = `analytics.own.view`, `changeRequest.create`, `student.block`.
- **PLATFORM_ADMIN** = `platform.manage`, `audit.view`.

**Grants (the configurable edge cases).** `can(role, permission, grants)` can only *widen* a role, never narrow it, and only for permissions listed as grantable for that role (`RECEPTIONIST → attendance.correct, center.profit.view`). Grants come from `permissionGrantsFromSettings(ctx.settings)` — the single seam. Nothing else reads the toggle columns.

As of **M2** that function is real. It lives in `lib/auth/permissions.ts` (beside the map it feeds, and free of runtime imports so the acceptance gates can exercise it) and is re-exported from `lib/auth/tenant.ts`, where the context is assembled. It maps two `CenterSettings` columns:

| Column | Grants | To |
|---|---|---|
| `receptionistCanViewProfit` | `center.profit.view` | RECEPTIONIST |
| `receptionistCanCorrectAttendance` | `attendance.correct` | RECEPTIONIST |

Both default to `false` (spec §3). The grants object is keyed by *permission*, not by role, and the grantable map is what confines each one: a TEACHER carrying `center.profit.view` in grants still fails `can()`, because profit is not in TEACHER's grantable set. Centers flip these at **`/settings/permissions`**, which requires `center.settings.edit` **and** `staff.manage`, and writes a `center.permissions.update` audit row.

Server-side is authoritative (`requirePermission(ctx, perm)` in a loader, `ctxCan(ctx, perm)` in an action); client-side `can()` only hides controls.

---

## 7. Data access, actions & validation

- **Server Components** load data via `lib/db/*` (scoped). **Server Actions** handle mutations.
- **Every action:** `getTenantContext()` → `can(...)` check → `zod` parse of input → scoped Prisma write → `AuditLog` if sensitive → `revalidatePath`.
- **Money writes** run inside a **transaction** and call `lib/money.ts` for the split, freezing snapshots (see data-model §3).
- Never trust client-sent `centerId`; always use the context's.

---

## 8. i18n & RTL

- **next-intl** with a `[locale]` segment; `en` default, `ar` fully supported. All copy in `messages/ar.json` + `messages/en.json`, never hardcoded.
- `<html lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}>`.
- **Tailwind logical properties only:** `ps-*/pe-*`, `ms-*/me-*`, `text-start/text-end`, `start-0/end-0`. No `left/right`.
- Arabic-Indic vs Latin numerals: Arabic-Indic in `ar` (`ar-EG-u-nu-arab`), Latin in `en`. Always format through `lib/format.ts` (`formatNumber`, `formatDate`) — never `toLocaleString()` inline.
- Fonts: Cairo (Arabic + Latin) via `next/font`, bound to `--font-sans`.
- **Routing:** Next 16 names the middleware file `proxy.ts`. It runs the next-intl middleware first, then refreshes the Supabase session onto that same response (`lib/supabase/proxy.ts`), so the i18n rewrite/redirect survives.

---

## 9. Per-tenant theming

Branding is data, not code. `Center` carries `logoUrl` + `themeColor`. On load, inject the center's color as CSS variables on the layout root:
```
:root { --brand: <center.themeColor>; --brand-fg: <computed contrast>; }
```
In practice the app shell sets `--brand` inline on its root element from `center.themeColor`, so it cascades over the `:root` default without a stylesheet round-trip. shadcn components read the brand variable (`--primary`, `--ring`, `--sidebar-primary` all resolve to it). The logo renders in the sidebar and on the ID card. **Result: "Center X" and their logo appear across the app with zero code change** — this is the demo trick and the real feature.

---

## 10. File storage (Supabase Storage)

Buckets: `logos/` (center branding), `avatars/` (users/students), `id-cards/` (generated), `session-uploads/` (Phase-1 placeholder for teacher file uploads). Paths namespaced by `centerId`. Access controlled by storage policies mirroring tenant isolation. ID cards render from an HTML/CSS template (using the center's `cardLayout` JSON) → image/PDF for print.

---

## 11. Session generation

A scheduled job (Vercel Cron or a Supabase scheduled function) materializes `Session` rows from `ClassSchedule` on a rolling ~6-week window, skipping holiday-calendar dates. Each generated session snapshots the class price. Managers can cancel/reschedule/edit individual sessions. Regeneration is idempotent (don't duplicate existing sessions).

---

## 12. Non-functional checklist (from the blueprint)

Security by design + least privilege · strict tenant isolation (§5) · audit logging (financial/permission/attendance) · encryption in transit + protected storage · backups + tested restore · responsive web (desktop/tablet/mobile browsers) · AR/EN + RTL · performance under attendance/registration rush · monitoring + error logging · data import/export for onboarding & responsible offboarding · QA coverage for permissions, money math, duplicate identities, cross-center leakage · privacy/legal review before handling minors' data in production.

---

## 13. Deployment

Vercel (Frankfurt) + Supabase (Frankfurt). Preview deploys for demos; **production only after the first center contract**. Migrations via `prisma migrate deploy` in CI. Secrets in Vercel env. Cron for session generation. Add error monitoring (e.g. Sentry) before pilot.

**Before the first production deploy, work the [Pre-deployment checklist](./00-master-product-spec.md#21-pre-deployment-checklist) (`00-master-product-spec.md` §2.1).** It is the standing inventory of every deliberate dev-only shortcut currently standing in for a production requirement — disabled email confirmation, manually shared invite links, the seeded owner credential, the RLS policies this document's §5 layer 2 calls for, monitoring, backups. Add to it whenever a new shortcut is taken.
