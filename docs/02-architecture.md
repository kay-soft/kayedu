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
      classes/   classes/[id]/     # CRUD, Schedule Builder, roster, session generator (M4)
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
    cron/generate-sessions/       # Vercel Cron entry point for lib/db/sessions.ts (M4, §11)
components/
  ui/                           # shadcn primitives, incl. dialog.tsx (docs/04 §5)
  shell/                        # app shell: sidebar (collapsible, docs/04 §5), drawer, header, nav config
  settings/                     # entity-manager (shared config CRUD), settings nav
  center/                       # person-fields, contact-fields, student-fields, pagination, add-entity dialogs
  teacher/  student/            # experience-specific composed components
  shared/                       # tables, filters, receipt, id-card, kpi-card, field.tsx
lib/
  auth/
    session.ts                  # Supabase auth user + User mirror
    active-center.ts            # the active-center cookie
    tenant.ts                   # getTenantContext() (request-cached, §14), route-group gates
    permissions.ts              # can(role, action) map
  supabase/
    server.ts  client.ts  proxy.ts  env.ts
  ui/
    sidebar-cookie.ts           # the sidebar-collapsed cookie name (docs/04 §5)
  db/
    client.ts                   # Prisma singleton
    tenant-scope.ts             # pure scoping primitives (no runtime imports)
    scoped.ts                   # tenant-scoped query helpers
    audit.ts                    # writeAuditLog()
    identity.ts                 # global-identity reads/writes (findPeopleByContact, createPerson, …)
    students.ts                 # lean list selects, search, claimStudentCode, delete-blockers
    classes.ts                  # lean list select, delete-blockers, conflict-row → pure-slot mapping (M4)
    sessions.ts                 # the session generator — Prisma client injected, no @/ imports (M4, §11)
    payments.ts  analytics.ts ...
  money.ts                      # the ONLY center-cut math + piastre helpers
  scheduling.ts                 # pure time-overlap, conflict-detection and rolling-window date math (M4)
  card-layout.ts                # the default ID-card layout the editor offers
  id-card.ts                    # renders the card SVG from that layout
  qr.ts                         # QR modules -> an SVG path
  identity.ts                   # duplicate-match predicate + contact normalizing (pure)
  storage-paths.ts              # pure storage-path primitives (no runtime imports)
  routes.ts                     # locale-less pathnames + role home paths
  format.ts                     # locale-aware number/date formatting
  i18n/  request.ts  routing.ts  navigation.ts
  validation/                   # zod schemas per entity, incl. pagination helpers (people.ts, §14)
  utils.ts
messages/
  ar.json  en.json
prisma/
  schema.prisma  migrations/  seed.ts
scripts/
  isolation-check.ts            # the cross-center acceptance gate (M1)
  config-check.ts               # the center-configuration acceptance gate (M2)
  people-check.ts               # the teachers/students/blocks/storage gate (M3)
  classes-check.ts              # classes/schedules/conflicts/session-generation gate (M4)
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

As of **M3** this is real on the add-teacher and add-student forms. `lib/identity.ts` owns the predicate (`contactMatchWhere()`), free of runtime imports so the acceptance gate exercises it, and normalizes contact details first — email lower-cased, Egyptian mobiles to `01XXXXXXXXX` — so `+201012345678` and `01012345678` are one person. `lib/db/identity.ts` resolves it into one of three outcomes:

| Outcome | What happens |
|---|---|
| **none** | Nobody matches — create the person, then their membership/profile here. |
| **matched** | The action writes **nothing** and returns the candidate. The UI shows who they are and what matched ("this person already exists"), and only a confirmed submit — now carrying `linkUserId` — attaches this center's record to them. Already connected here? The panel points at the existing record instead of offering to link. |
| **conflict** | The email belongs to one person and the phone to another. Refused with an explanation: merging two identities is the manual admin action above, not something an add form decides. |

**Name is center-local too — nothing about a person's record stays global-locked.** `matched`/`none` above decide *which* `User` a center's `StudentProfile`/`Membership` attaches to; they never decide who may rename anyone, because renaming isn't gated at all as of the identity-model revision. Whichever outcome fires, the local `firstName`/`lastName` is seeded once — from the form for a brand-new person, from the matched person's actual name otherwise (`seedLocalName()` in `lib/db/identity.ts`) — and is then editable at that center immediately, independently of any other center, exactly like `email`/`phone`/`altPhone` (`01-data-model.md` §6). The global `User.firstName`/`User.lastName` stay the platform-wide default and are never written back to.

---

## 4. Tenant resolution & `getTenantContext()`

**URL strategy:** path-based for simplicity now — `app.kayedu.com` with the active center in the session, and center branding applied from it. (Subdomains like `centerx.kayedu.com` can be layered on later via middleware without schema change; both resolve to the same `centerId`.)

`getTenantContext()` is called at the top of every Server Action and protected loader — often several times in one request (a layout, then the page it wraps). It is wrapped in React's `cache()`, so one request resolves the user, the center relations and the `CenterSettings` row **once** no matter how many call sites ask (§14). It takes `experience` as a plain optional string (`getTenantContext("center")`), not an options object — `cache()` keys object arguments by reference, so a fresh `{ experience: "center" }` literal at every call site would never hit the cache. It returns:
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

`npm run check:people` (`scripts/people-check.ts`) is the M3 gate, covering the paths that milestone added (revised for the center-local-contacts and system-assigned-codes rework). It registers **one person at two throwaway centers** and asserts a single `User` with two `StudentProfile` rows; that a `+20`-prefixed phone and a capitalised email still match that person; that editing one center's local contact leaves the global `User` and every other center's local record untouched; that a contact which exists **only** on another center's local record (never the global `User`) still produces a match, proving the search covers all three tables; that **12 concurrent registrations** in one center produce 12 unique, contiguous student codes — no duplicates, no gaps; that Center A resolves neither Center B's `StudentProfile`, teacher `Membership` nor `StudentBlock` by id; that a **teacher shared by both centers** who blocks a student at one has not blocked them at the other, and that their local contact is independent per center too; that grade promotion moves only its own center's students; that the storage primitives refuse an unscoped path, a traversal segment, a prefix collision and a foreign center's path; that a card renders with its QR, escapes its text and mirrors in Arabic; and that the schemas reject what the UI must not store (including asserting the student schema carries no `studentCode` field and the teacher schema carries no `canSeeEarnings` field at all). Then it cleans up.

`npm run check:config` (`scripts/config-check.ts`) is the M2 gate. It configures **two** throwaway centers through one `configureCenter(centerId)` — no per-center branching anywhere — using the same zod schemas the settings actions parse with and the same scoping primitives, then asserts the two configurations are independent, that neither center resolves the other center's config rows by id, that the permission-grant seam widens a receptionist and nobody else, and that the center-cut split is right in both modes. That is the "a second center needs zero code changes" claim, executed.

`npm run check:classes` (`scripts/classes-check.ts`) is the M4 gate: "a class with two weekly slots generates correct future sessions; a room/teacher double-book is prevented or warned per rule; enrolling past capacity is blocked." It first exercises `lib/scheduling.ts`'s pure primitives with no database at all (time-overlap, `findScheduleConflicts`, `generateOccurrenceDates`'s rolling-window/holiday math, `findSessionConflicts`), then a database-backed pass against one throwaway center: `classGroupSchema`/`classScheduleSchema` reject an out-of-range percentage, a negative capacity, an inverted time range and an out-of-range day; two classes sharing a teacher (or a room) with overlapping schedules are flagged by `findScheduleConflicts`; `generateSessions` (the real production generator, `lib/db/sessions.ts`, called with the script's own `PrismaClient` since the function takes one as a parameter rather than importing the app singleton) produces exactly 12 sessions for a class with two weekly slots across the 6-week window, snapshotting the class price onto every one; regenerating the identical window a second time creates **zero** new rows (the `(classGroupId, date, startTime)` unique constraint); a date added to the holiday calendar is skipped; a generation-time conflict is created-and-flagged under `WARN` and skipped-and-flagged under `DENY`; a capacity-1 class's second concurrent enrollment attempt is caught by the same count-then-compare the Server Action uses; a duplicate enrollment and a `StudentBlock` (scope CLASS) are both detected before the row would be created; and Center A cannot resolve Center B's `ClassGroup`, `ClassSchedule` or `Enrollment` by id. Then it cleans up.

All four gates import only modules free of `@/` aliases and of Next-runtime imports — which is why `lib/db/tenant-scope.ts`, `lib/money.ts`, `lib/auth/permissions.ts`, `lib/validation/settings.ts`, `lib/scheduling.ts` and `lib/db/sessions.ts` are written that way. `lib/db/sessions.ts` takes its `PrismaClient` as a parameter rather than importing `lib/db/client.ts`'s singleton for exactly this reason — the app passes the shared instance, the gate script passes its own. Keep it so.

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
can(role, "analytics.own.view")   // TEACHER (baseline — see the note below)
```
- **OWNER** = MANAGER + `center.ownership.manage` (the only owner-exclusive action).
- **RECEPTIONIST** = `reception.use`, `attendance.record`, `payment.record`, `student.manage`. Profit and corrections are **denied by default** (spec §3).
- **TEACHER** = `analytics.own.view`, `changeRequest.create`, `student.block`. `analytics.own.view` is a **baseline** permission, not a grant — a teacher sees their own earnings/analytics by default (spec §3, M3). `Membership.canSeeEarnings` exists in the schema for a possible future per-center toggle, defaults `true`, and `can()` never reads it.
- **PLATFORM_ADMIN** = `platform.manage`, `audit.view`.

**Grants (the configurable edge cases).** `can(role, permission, grants)` can only *widen* a role, never narrow it, and only for permissions listed as grantable for that role (`RECEPTIONIST → attendance.correct, center.profit.view`). Grants come from `permissionGrantsFromSettings(ctx.settings)` — the single seam. Nothing else reads the toggle columns. (An earlier draft also listed `TEACHER → analytics.own.view` here — removed as of M3, since that permission was already unconditionally true in `TEACHER`'s baseline and the grant entry could never fire.)

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

Buckets: `logos/` (center branding), `avatars/` (users/students), `id-cards/` (generated), `session-uploads/` (Phase-1 placeholder for teacher file uploads). Paths namespaced by `centerId`. Access controlled by storage policies mirroring tenant isolation.

**`avatars/` and `id-cards/` exist as of M3**; `logos/` and `session-uploads/` land with the milestones that need them. Both are **private** buckets, with size and MIME limits set on the bucket itself (5 MB images for `avatars/`, 2 MB `image/svg+xml` for `id-cards/`).

**Layer 1 — the app.** Files are scoped exactly like queries. `lib/storage-paths.ts` is to Storage what `lib/db/tenant-scope.ts` is to Prisma: no runtime imports, `centerObjectPath()` refuses to build a path without a `centerId` (and refuses a traversal segment), and `assertPathInCenter()` re-checks any path read back from the database before it is signed, downloaded or deleted. `lib/db/storage.ts` composes those into upload/sign/download/remove and is the only module that touches the Storage API. Layout is `{centerId}/{studentProfileId}.{ext}` — the filename **stem is the profile id**, which is what the read policy matches a student's own file on.

**Layer 2 — Postgres.** Policies on `storage.objects` mirror the membership rules: read for any active member of that center folder (or the student whose own file it is), write for `OWNER`/`MANAGER`/`RECEPTIONIST` only. They read three no-argument `SECURITY DEFINER` helpers (`kayedu_member_center_ids()`, `kayedu_write_center_ids()`, `kayedu_own_student_profile_ids()`) that filter strictly on `auth.uid()`, execute granted to `authenticated` alone. The app itself writes with the service role, so these policies are the backstop for direct Supabase-client access — the same belt-and-braces shape as §5.

**ID cards** render from the center's `cardLayout` JSON through `lib/id-card.ts` into a self-contained **SVG** — vector, so it is crisp on screen and at print DPI, and printable straight from the browser at true credit-card size (85.6 × 54 mm) with no headless-browser step. The preview, the print view and the file uploaded to `id-cards/` are the *same string*, so a center cannot preview one card and print another. Images are inlined as data URIs precisely because a stored card must not depend on a signed URL that expires, and every text value is XML-escaped. `x` is a **logical start offset**: an Arabic card mirrors the whole layout, the same rule as `ps-/pe-` on screen (docs/04 §7). The QR encodes `KAYEDU|{centerId}|{studentCode}` for the M5 reception scanner.

---

## 11. Session generation & scheduling conflicts (M4)

`generateSessions()` (`lib/db/sessions.ts`) materializes `Session` rows from every active `ClassGroup`'s `ClassSchedule`s on a rolling **42-day (`GENERATION_WINDOW_DAYS`) window starting today**, skipping any date on the center's `Holiday` calendar, and snapshotting `Session.priceSnapshot` from the class's current price at generation time (§3's snapshot rule applies here too — a later price change never rewrites an already-generated session). It takes a `PrismaClient` as its first argument rather than importing the app's singleton, so `npm run check:classes` can call the *real* generator with its own client, outside the Next.js runtime (§5's "no `@/` aliases" rule, extended to this module).

**Idempotent regeneration.** `Session` is unique on `(classGroupId, date, startTime)`; the generator inserts with `createMany({ skipDuplicates: true })` against that key, so running it twice over the same window creates zero duplicate rows the second time — the count Prisma reports back **is** the "how many new sessions" answer.

**Conflict detection, twice.** The same shape of check runs at two moments, both via `lib/scheduling.ts`'s pure `findScheduleConflicts`/`findSessionConflicts` (day/date + overlapping time + same teacher, or same non-null room):
- **At `ClassSchedule` save time** (`createScheduleAction`/`updateScheduleAction`, `app/[locale]/(center)/classes/actions.ts`): the candidate slot is checked against every *other* class's schedule rows in the center (`db.classSchedules.listForConflictCheck`).
- **At generation time** (`generateSessions`): each candidate occurrence is checked against every other class's already-known sessions in the window — including ones generated earlier in the *same* run, so generating the whole center in one call still catches two classes conflicting with each other.

Which of these **denies** the save/occurrence versus merely **warns and proceeds** is `CenterSettings.scheduleConflictPolicy` (`WARN` default | `DENY`), configured at `/settings` (general) and read fresh on every check — never hardcoded (docs/00 §5 "Scheduling").

**Triggering it.** Three ways, all calling the same `generateSessions()`:
1. A manual button on a class's detail page (`GenerateSessionsButton`, one class only).
2. A manual button on `/classes` (the whole center at once).
3. `app/api/cron/generate-sessions/route.ts` — a `GET` route intended for **Vercel Cron**, guarded by comparing `Authorization: Bearer $CRON_SECRET` (Vercel signs cron-triggered requests this way once `CRON_SECRET` is set as a project env var). It loops every active `Center` and regenerates all of them. **Registering the actual cron schedule** (a `vercel.json`/`vercel.ts` `crons` entry pointing at this route) and setting `CRON_SECRET` are deployment steps, not yet wired — tracked in `00-master-product-spec.md` §2.1.C.

Managers can still cancel/reschedule/edit individual sessions once the daily-loop UI lands (M5) — nothing here prevents a manually-edited session from being touched by a later regeneration, since `skipDuplicates` only ever *adds* rows for occurrences that don't already exist.

---

## 12. Non-functional checklist (from the blueprint)

Security by design + least privilege · strict tenant isolation (§5) · audit logging (financial/permission/attendance) · encryption in transit + protected storage · backups + tested restore · responsive web (desktop/tablet/mobile browsers) · AR/EN + RTL · performance under attendance/registration rush · monitoring + error logging · data import/export for onboarding & responsible offboarding · QA coverage for permissions, money math, duplicate identities, cross-center leakage · privacy/legal review before handling minors' data in production.

---

## 13. Deployment

Vercel (Frankfurt) + Supabase (Frankfurt). Preview deploys for demos; **production only after the first center contract**. Migrations via `prisma migrate deploy` in CI. Secrets in Vercel env. Cron for session generation. Add error monitoring (e.g. Sentry) before pilot.

**Before the first production deploy, work the [Pre-deployment checklist](./00-master-product-spec.md#21-pre-deployment-checklist) (`00-master-product-spec.md` §2.1).** It is the standing inventory of every deliberate dev-only shortcut currently standing in for a production requirement — disabled email confirmation, manually shared invite links, the seeded owner credential, the RLS policies this document's §5 layer 2 calls for, monitoring, backups. Add to it whenever a new shortcut is taken.

---

## 14. Performance & pagination conventions

Introduced during the M3 hardening pass, after navigation had grown noticeably slow. These are standing rules for every later milestone, not a one-off fix — a list screen or a data loader that skips them is a bug.

**List pages are paginated, never "load everything."** A center can have 5,000+ students. Every list screen (`/students`, `/teachers`, and every future one — sessions, payments, expenses) takes `page`/`pageSize` from the URL (`lib/validation/people.ts`: `parsePageParam`, `parsePageSizeParam`, `DEFAULT_PAGE_SIZE = 25`), bounds the query with `take`/`skip`, and renders `components/center/pagination.tsx` — prev/next driven by real `<Link>` hrefs, not client state, so a page is shareable and back-button-safe. Search narrows the same paginated query; it never fetches the full table into memory to filter client-side.

**List queries `select` only what a row renders — never `include` a whole related row.** `lib/db/students.ts` exports `STUDENT_LIST_SELECT`/`TEACHER_LIST_SELECT`, lean field lists the `scoped(ctx).students.search()` / `.teachers.search()` helpers use; the detail-page loaders (`findDetailById`) are the ones allowed a full `include`, because a detail page actually renders every field. Aggregate counts needed by a list (e.g. a teacher's block count) come from one grouped query — `scoped(ctx).studentBlocks.countByRef()` uses Prisma `groupBy` — scoped to just the rows on that page, never "fetch every block in the center and count in memory."

**`getTenantContext()` is request-cached.** It is wrapped in React's `cache()` (§4) so the user, the center relations, and the `CenterSettings` row are resolved once per request no matter how many layouts/pages call it. This is why it takes `experience` as a primitive argument rather than an options object — `cache()` keys object arguments by reference, and a fresh literal at every call site would defeat it. `getUserCenterRelations()` and `getCurrentUser()`/`getAuthUser()` are cached the same way, for the same reason.

**Money/identity writes that must not leave a gap run in one transaction.** The clearest example is student registration: claiming the next `studentCode` (a race-free atomic counter, `01-data-model.md` §6) and creating the `StudentProfile` (and the `User`, when there is one) happen inside a single `prisma.$transaction()`, so any failure rolls back the claim too — a crash never burns a code into a permanent gap. Reach for this pattern whenever a sequence or a uniqueness guarantee is involved, not just for payments.

**`revalidatePath` is targeted, not broad.** Every mutation revalidates only the paths it actually changed — a list, a detail page, and (for students) the card/paper printables are three separate helpers (`revalidateStudentList`, `revalidateStudentDetail`, `revalidateStudentPrintables` in `app/[locale]/(center)/students/actions.ts`) rather than one function every action calls unconditionally. Deactivating a student, for instance, doesn't touch the printables — nothing on the card or the paper sheet depends on active/inactive.

**Indexes exist for the query shapes actually run.** Every hot scoped lookup is `centerId`-first (`01-data-model.md` §2); compound indexes are added when a second column is filtered or ordered on in the same query — `Membership(centerId, role)` for the teacher list, `StudentProfile(centerId, active)` for status filtering. Substring search (`contains`, used for name/phone/code search) cannot use a plain btree index — that is a known limitation for now; a `pg_trgm` trigram index is the documented upgrade path if search latency becomes a problem at real center scale, not yet built because it isn't yet needed.

**Prefetching stays on.** Next.js `<Link>` (via `next-intl`'s wrapper) prefetches viewport-visible destinations by default — list rows linking to detail pages get this for free. Don't pass `prefetch={false}` without a specific reason; the default is the right behavior for this app's navigation-heavy UI.
