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
    (auth)/
      login/  register/  invite/[token]/  select-center/
    (center)/                   # Owner / Manager / Receptionist
      dashboard/
      teachers/  teachers/[id]/
      classes/   classes/[id]/
      students/  students/[id]/
      sessions/  sessions/[id]/
      reception/
      analytics/
      expenses/
      approvals/
      settings/                 # education systems, subjects, grades, rooms,
                                # roles, teacher-timeout, card, users
    (teacher)/
      dashboard/  sessions/  students/  classes/  analytics/
    (student)/
      schedule/  discover/  reservations/  classes/
    (admin)/                    # KayEdu super admin (platform)
      centers/  centers/[id]/  platform/
  api/                          # webhooks / edge handlers if needed
components/
  ui/                           # shadcn primitives
  center/  teacher/  student/   # experience-specific composed components
  shared/                       # tables, filters, receipt, id-card, kpi-card
lib/
  auth/
    session.ts                  # current user from Supabase
    tenant.ts                   # getTenantContext()
    permissions.ts              # can(role, action) map
  db/
    client.ts                   # Prisma singleton
    scoped.ts                   # tenant-scoped query helpers
    students.ts  classes.ts  sessions.ts  payments.ts  analytics.ts ...
  money.ts                      # the ONLY center-cut math + piastre helpers
  i18n/  request.ts  routing.ts
  validation/                   # zod schemas per entity
  utils/
messages/
  ar.json  en.json
prisma/
  schema.prisma  migrations/  seed.ts
docs/
```

**Route groups map 1:1 to the four experiences.** A user only ever renders inside the group their role permits; the layout for each group enforces the role at the top.

---

## 3. Identity & auth flow

**Supabase Auth** owns credentials (email/password, later phone OTP). Our `User` table mirrors the auth user via `authId` and holds the profile. Flow:

1. **Register / login** through Supabase Auth → we ensure a matching `User` row exists (create on first login).
2. **Resolve memberships:** look up all `Membership` rows (and `StudentProfile` rows) for that user.
3. **Select center:** if the user belongs to >1 center, they hit **`/select-center`** (the home hub). If exactly one, auto-select. The chosen `centerId` is stored in the session (cookie) and drives everything.
4. **Role gate:** each route group's layout checks the membership role for the active center and redirects if not allowed.

**Invites (staff):** Owner/Manager invites by email → `Invitation` row + token link → invitee registers/logs in → membership created on accept. Teachers & students self-register and connect to centers (teachers by center invite/trust; students by discovery/enroll).

**Duplicate prevention:** on register, match on verified phone/email. If found, link a new membership/enrollment to the existing `User` instead of creating a person. Merge is a manual, audited admin action.

---

## 4. Tenant resolution & `getTenantContext()`

**URL strategy:** path-based for simplicity now — `app.kayedu.com` with the active center in the session, and center branding applied from it. (Subdomains like `centerx.kayedu.com` can be layered on later via middleware without schema change; both resolve to the same `centerId`.)

`getTenantContext()` is called at the top of every Server Action and protected loader. It returns:
```ts
type TenantContext = {
  user: User;
  center: Center;         // the active center
  membership: Membership; // role + visibility flags for this center
  role: Role | "STUDENT" | "PLATFORM_ADMIN";
};
```
It throws/redirects if there's no valid membership for the requested center. **No data-access function runs without it.**

---

## 5. Tenant isolation — two layers

**Layer 1 (primary): application scoping.**
All reads/writes go through `lib/db/*` functions that take the `TenantContext` and inject `centerId` into every `where`. Direct `prisma.*` calls in components/actions are forbidden (enforce by review + a lint rule). Example:
```ts
// lib/db/scoped.ts
export function scoped(ctx: TenantContext) {
  const where = { centerId: ctx.center.id };
  return {
    students: () => prisma.studentProfile.findMany({ where }),
    // ...always spreads `where`
  };
}
```

**Layer 2 (backstop): Postgres RLS.**
Enable RLS on every tenant table. Policy shape: a row is visible only if its `center_id` is in the caller's memberships. The catch: **Prisma connects as a role that can bypass RLS unless configured.** Two acceptable setups:
- **(Recommended for a solo dev):** rely on Layer 1 as the enforced boundary, and enable RLS with policies as a *safety net* for any direct/SQL access and for Supabase client reads (Storage, realtime). Keep the Prisma connection role non-superuser.
- **(Stricter):** pass the authenticated user's JWT down so Postgres evaluates `auth.uid()` in policies for every query. More setup; revisit if a security audit demands it.

Either way, **write the two isolation tests early** (shared-teacher no-leak; cross-center-by-ID denied) and run them in CI.

---

## 6. Permissions

Hardcoded map, not a dynamic engine:
```ts
// lib/auth/permissions.ts
can(role, "center.profit.view")        // OWNER, MANAGER (RECEPTIONIST: false)
can(role, "student.delete")            // OWNER, MANAGER
can(role, "attendance.correct")        // OWNER, MANAGER, (RECEPTIONIST configurable)
can(role, "payment.void")              // OWNER, MANAGER
can(role, "settings.edit")             // OWNER, MANAGER
```
A few center settings toggle edge cases (e.g. whether receptionists may correct attendance, the teacher session-edit deadline). Checked both server-side (authoritative) and client-side (to hide controls).

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
- Arabic-Indic vs Latin numerals: pick one convention for display (recommend Arabic-Indic in AR, Latin in EN) via an Intl formatter helper.
- Fonts: an Arabic-first family (e.g. IBM Plex Sans Arabic / Cairo) with a Latin fallback; load via `next/font`.

---

## 9. Per-tenant theming

Branding is data, not code. `Center` carries `logoUrl` + `themeColor`. On load, inject the center's color as CSS variables on the layout root:
```
:root { --brand: <center.themeColor>; --brand-fg: <computed contrast>; }
```
shadcn components read the brand variable. The logo renders in the header/sidebar and on the ID card. **Result: "Center X" and their logo appear across the app with zero code change** — this is the demo trick and the real feature.

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
