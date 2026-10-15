import type { Center, CenterLifecycleState, Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:admin` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/payments.ts,
// lib/db/approvals.ts, lib/db/analytics.ts).
import { provisionCenterBaseline } from "./provision.ts";
import { runInTransaction } from "./session-lifecycle.ts";
import { writeAuditRow } from "./audit-row.ts";

/**
 * Platform-admin data access (M9, docs/00-master-product-spec.md §4.4). This
 * is the one module in `lib/db/` that deliberately does **not** scope by
 * `centerId` — a super admin operates *across* centers by design (spec §3:
 * "Never browses tenant data casually", but its reach is the whole platform,
 * not one tenant). Authorization is the caller's job — every function here is
 * called only after `requirePlatformAdmin()` has already run, exactly like
 * `lib/db/approvals.ts`'s `resolveChangeRequest` carries no permission check
 * of its own and leaves that to the Server Action.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const STAFF_ROLES: readonly Role[] = ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"];
const TEACHER_ROLE: Role = "TEACHER";

// ── Centre lifecycle (M19, docs/00-master-product-spec.md §5.1) ─────────

export const CENTER_LIFECYCLE_STATES: readonly CenterLifecycleState[] = [
  "ONBOARDING",
  "ACTIVE",
  "GRACE",
  "SUSPENDED",
  "ARCHIVED",
];

/**
 * States in which a centre's members may sign in and use the app at all. The
 * old `active` boolean collapsed five real states into two; this is the
 * confirmed mapping going forward — ONBOARDING (setup in progress, an invited
 * Owner must still be able to accept and configure things) and GRACE (a
 * lapse under notice, not yet a hard stop) both permit access exactly like
 * ACTIVE; SUSPENDED and ARCHIVED both refuse it exactly like the old
 * `active: false` did. `getUserCenterRelations()` (`lib/auth/tenant.ts`) is
 * the sole place this gates sign-in — the same seam `center: { active: true
 * }` used to.
 */
export const ACCESSIBLE_LIFECYCLE_STATES: readonly CenterLifecycleState[] = [
  "ONBOARDING",
  "ACTIVE",
  "GRACE",
];

/**
 * The valid lifecycle transition graph. Two rules, stated once and enforced
 * everywhere through this table rather than ad hoc per-caller checks:
 * **ARCHIVED is terminal** (closing a centre is final — a resumed
 * relationship is a new Center, not a reactivation), and **SUSPENDED/ARCHIVED
 * are reachable directly from any non-terminal state** (an admin must always
 * be able to shut a problematic centre down immediately, regardless of where
 * it currently sits in the lifecycle, without forcing it through intermediate
 * states first). Recovery back to ACTIVE is otherwise only possible from
 * ONBOARDING (finishing setup), GRACE (resolved before a hard suspension) and
 * SUSPENDED (reinstated) — never from ARCHIVED.
 */
const LIFECYCLE_TRANSITIONS: Record<CenterLifecycleState, readonly CenterLifecycleState[]> = {
  ONBOARDING: ["ACTIVE", "SUSPENDED", "ARCHIVED"],
  ACTIVE: ["GRACE", "SUSPENDED", "ARCHIVED"],
  GRACE: ["ACTIVE", "SUSPENDED", "ARCHIVED"],
  SUSPENDED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export function isValidLifecycleTransition(
  from: CenterLifecycleState,
  to: CenterLifecycleState,
): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** The states `/admin/centers/[id]` may offer from a given current state. */
export function validNextLifecycleStates(
  from: CenterLifecycleState,
): readonly CenterLifecycleState[] {
  return LIFECYCLE_TRANSITIONS[from];
}

export type LifecycleTransitionResult =
  | { ok: true; center: Center }
  | { ok: false; error: "notFound" | "invalidTransition" };

/** The Server Action's real write path — validated here, not just in the UI. */
export async function transitionCenterLifecycle(
  db: Db,
  centerId: string,
  to: CenterLifecycleState,
): Promise<LifecycleTransitionResult> {
  const center = await db.center.findUnique({ where: { id: centerId } });
  if (!center) return { ok: false, error: "notFound" };
  if (!isValidLifecycleTransition(center.lifecycleState, to)) {
    return { ok: false, error: "invalidTransition" };
  }
  const updated = await db.center.update({
    where: { id: centerId },
    data: { lifecycleState: to },
  });
  return { ok: true, center: updated };
}

// ── Center tenant management ────────────────────────────────────────────

export type CenterInvite = {
  email: string;
  token: string;
  invitedBy: string;
  expiresAt: Date;
};

export type CreateCenterInput = {
  name: string;
  nameEn?: string | null;
  slug: string;
  themeColor: string;
  /**
   * The center's first Owner, invited the same way `/settings/staff` invites
   * anyone else (docs/00 §2.1.A: "The first real owner is provisioned
   * through the admin panel + invite flow"). Without this a freshly created
   * center has no member who could ever reach `/settings/staff` to invite
   * one — the normal invite screen requires already being a member.
   */
  invite: CenterInvite;
};

export type CreateCenterResult =
  | { ok: true; center: Center }
  | { ok: false; error: "slugTaken" };

/**
 * Creates a Center + its organization + the founding Owner invitation, then
 * hands the centre to `provisionCenterBaseline` (`lib/db/provision.ts`) for
 * everything it needs to actually work — its CenterSettings row, the baseline
 * permission matrix and the default payment methods — all in one transaction.
 * The M9 equivalent of how `configureCenter` (M2's gate) provisions a fresh
 * center's config in one call, no per-center branching. The baseline is owned
 * by that one function, not re-listed here (P1: the demo seed had its own copy
 * of "create a centre" that forgot the grants, and its Owner saw only the
 * Dashboard).
 */
export async function createCenterWithSettings(
  db: Db,
  input: CreateCenterInput,
): Promise<CreateCenterResult> {
  const existing = await db.center.findUnique({ where: { slug: input.slug } });
  if (existing) return { ok: false, error: "slugTaken" };

  const center = await runInTransaction(db, async (tx) => {
    const created = await tx.center.create({
      data: {
        name: input.name,
        nameEn: input.nameEn ?? null,
        slug: input.slug,
        themeColor: input.themeColor,
        // A freshly admin-provisioned center hasn't done anything yet — no
        // staff signed in, no config touched — so it starts ONBOARDING rather
        // than ACTIVE (docs/00 §5.1 "Centre lifecycle"). ONBOARDING already
        // permits sign-in (`ACCESSIBLE_LIFECYCLE_STATES` above), so the invited
        // Owner can still accept the invite below and set the center up; moving
        // it to ACTIVE once setup is real is a deliberate lifecycle transition
        // an admin makes from `/admin/centers/[id]`, not an automatic flip.
        lifecycleState: "ONBOARDING",
        // A platform-created center starts as its own single-branch
        // organization (M11) — the same shape the M11 migration's backfill
        // gave every pre-existing center. Nothing yet adds a branch to an
        // existing organization — how that should work is OD-12
        // (docs/00 §2.2), not something this provisioning step decides.
        organization: {
          create: {
            name: input.name,
            nameEn: input.nameEn ?? null,
          },
        },
        invitations: {
          create: {
            email: input.invite.email,
            role: "OWNER",
            token: input.invite.token,
            invitedBy: input.invite.invitedBy,
            expiresAt: input.invite.expiresAt,
          },
        },
      },
    });
    await provisionCenterBaseline(tx, created.id);
    return created;
  });

  return { ok: true, center };
}

// ── Center list (the /admin/centers table) ──────────────────────────────

export type PlatformCenterRow = {
  id: string;
  name: string;
  slug: string;
  lifecycleState: CenterLifecycleState;
  themeColor: string;
  createdAt: Date;
  staffCount: number;
  teacherCount: number;
  studentCount: number;
};

/**
 * Every center plus its basic stats (spec §4.4: "list all centers with
 * basic stats"). One `groupBy` per role-bearing relation instead of an
 * `_count` per center row, because a center's "staff" figure sums three
 * roles (OWNER/MANAGER/RECEPTIONIST) while "teachers" is a fourth — Prisma's
 * `_count.select` can only count a whole relation, not a role subset of it
 * (the same reasoning as `lib/db/analytics.ts`'s `revenueByTeacher`).
 */
export async function platformCenterList(db: Db): Promise<PlatformCenterRow[]> {
  const [centers, membershipCounts, studentCounts] = await Promise.all([
    db.center.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        lifecycleState: true,
        themeColor: true,
        createdAt: true,
      },
    }),
    db.membership.groupBy({
      by: ["centerId", "role"],
      where: { active: true },
      _count: { _all: true },
    }),
    db.studentProfile.groupBy({
      by: ["centerId"],
      where: { active: true },
      _count: { _all: true },
    }),
  ]);

  const staffByCenterId = new Map<string, number>();
  const teacherByCenterId = new Map<string, number>();
  for (const row of membershipCounts) {
    if ((STAFF_ROLES as readonly string[]).includes(row.role)) {
      staffByCenterId.set(
        row.centerId,
        (staffByCenterId.get(row.centerId) ?? 0) + row._count._all,
      );
    } else if (row.role === TEACHER_ROLE) {
      teacherByCenterId.set(row.centerId, row._count._all);
    }
  }
  const studentByCenterId = new Map(
    studentCounts.map((row) => [row.centerId, row._count._all]),
  );

  return centers.map((center) => ({
    ...center,
    staffCount: staffByCenterId.get(center.id) ?? 0,
    teacherCount: teacherByCenterId.get(center.id) ?? 0,
    studentCount: studentByCenterId.get(center.id) ?? 0,
  }));
}

// ── Platform KPIs (/admin/platform) ──────────────────────────────────────

export type PlatformCenterCounts = {
  total: number;
  /** In ONBOARDING/ACTIVE/GRACE — i.e. currently able to sign in and operate. */
  operational: number;
  byState: Record<CenterLifecycleState, number>;
};

export async function platformCenterCounts(db: Db): Promise<PlatformCenterCounts> {
  const [total, grouped] = await Promise.all([
    db.center.count(),
    db.center.groupBy({ by: ["lifecycleState"], _count: { _all: true } }),
  ]);

  const byState = Object.fromEntries(
    CENTER_LIFECYCLE_STATES.map((state) => [state, 0]),
  ) as Record<CenterLifecycleState, number>;
  for (const row of grouped) byState[row.lifecycleState] = row._count._all;

  const operational = ACCESSIBLE_LIFECYCLE_STATES.reduce(
    (sum, state) => sum + byState[state],
    0,
  );

  return { total, operational, byState };
}

export async function platformTeacherCount(db: Db): Promise<number> {
  return db.membership.count({ where: { role: TEACHER_ROLE, active: true } });
}

export async function platformStudentCount(db: Db): Promise<number> {
  return db.studentProfile.count({ where: { active: true } });
}

export async function platformSessionCount(db: Db): Promise<number> {
  return db.session.count();
}

export type AdoptionTrendPoint = { monthKey: string; count: number };

/**
 * Centers created per calendar month, most recent `months` months, oldest
 * first — the "adoption trend" the spec asks for (§4.4), read as a plain
 * table rather than a chart (Phase 1 metadata, not a dashboard product).
 * Fetches every `Center.createdAt` rather than aggregating in SQL: unlike a
 * per-tenant list (docs/02 §14's "never fetch-and-sum"), the *tenant
 * registry itself* is small by construction — a handful to a few hundred
 * rows at Phase 1 scale — so bucketing by month in memory is the simplest
 * correct thing, not a shortcut that will need revisiting at the same scale
 * a per-tenant list would.
 */
export async function platformAdoptionTrend(
  db: Db,
  months = 6,
): Promise<AdoptionTrendPoint[]> {
  const centers = await db.center.findMany({ select: { createdAt: true } });

  const counts = new Map<string, number>();
  for (const { createdAt } of centers) {
    const key = monthKey(createdAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const now = new Date();
  const points: AdoptionTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const bucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(bucket);
    points.push({ monthKey: key, count: counts.get(key) ?? 0 });
  }
  return points;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Center detail (/admin/centers/[id]) ──────────────────────────────────

export type CenterDetailStats = {
  staff: number;
  teachers: number;
  students: number;
  sessions: number;
};

export async function platformCenterDetailStats(
  db: Db,
  centerId: string,
): Promise<CenterDetailStats> {
  const [staff, teachers, students, sessions] = await Promise.all([
    db.membership.count({ where: { centerId, active: true, role: { in: [...STAFF_ROLES] } } }),
    db.membership.count({ where: { centerId, active: true, role: TEACHER_ROLE } }),
    db.studentProfile.count({ where: { centerId, active: true } }),
    db.session.count({ where: { centerId } }),
  ]);
  return { staff, teachers, students, sessions };
}

// ── Privileged support access (audited) ──────────────────────────────────

/**
 * Every time a platform admin opens a center's detail/support view, this
 * writes the audit trail the spec calls for (§4.4: "controlled privileged
 * support access... audited"). Deliberately just the write, not a whole
 * masquerade/impersonation system — a read-only view that is always logged
 * is enough for Phase 1 (docs/03-build-order.md M9).
 */
export async function recordSupportAccess(
  db: Db,
  input: { centerId: string; actorUserId: string },
): Promise<void> {
  await writeAuditRow(db, {
    centerId: input.centerId,
    actorUserId: input.actorUserId,
    action: "platform.support.access",
    entityType: "Center",
    entityId: input.centerId,
  });
}

// ── Plain lookups the pages used to make with `prisma.*` directly (SYS) ─────
// Global by nature (a platform admin's view, the invite page, the public
// directories), so they take no centre scope — but they live here, behind
// the injected client, rather than in a page (docs/02 §5, §7).

/** One centre row — the platform admin's support view. */
export function platformCenterById(db: Db, id: string) {
  return db.center.findUnique({ where: { id } });
}

/** A centre's newest audit rows (carved out of the visibility window — docs/01 §7). */
export function platformCenterAuditTrail(db: Db, centerId: string, take = 20) {
  return db.auditLog.findMany({
    where: { centerId },
    orderBy: { createdAt: "desc" },
    take,
    include: { actor: true },
  });
}

/** A centre's settings row (`null` before it was ever configured). */
export function centerSettingsFor(db: Db, centerId: string) {
  return db.centerSettings.findUnique({ where: { centerId } });
}

/** Every centre that may operate (ONBOARDING/ACTIVE/GRACE), for the public directories. */
export function listAccessibleCenters(db: Db) {
  return db.center.findMany({
    where: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    select: { id: true, name: true, logoPath: true, themeColor: true },
    orderBy: { name: "asc" },
  });
}

/** Centre names by id (a cross-centre list the caller already scoped by identity). */
export function centerNamesByIds(db: Db, ids: string[]) {
  return db.center.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
}

/** A centre's stored logo key, for the signing route (`/api/logos/[centerId]`). */
export function centerLogoPath(db: Db, centerId: string) {
  return db.center.findUnique({ where: { id: centerId }, select: { id: true, logoPath: true } });
}

/** An invitation by its token, with its centre — the accept page (the token is the only link). */
export function invitationByToken(db: Db, token: string) {
  return db.invitation.findUnique({ where: { token }, include: { center: true } });
}
