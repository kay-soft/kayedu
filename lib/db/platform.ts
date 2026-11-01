import type { Center, CenterLifecycleState, Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:admin` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/payments.ts,
// lib/db/approvals.ts, lib/db/analytics.ts).
import { provisionCenterBaseline } from "./provision.ts";
import { runInTransaction } from "./session-lifecycle.ts";
import { writeAuditRow } from "./audit-row.ts";
import { MAX_BRANCH_LIMIT, type BranchCopyKey } from "../branch-setup.ts";
import { copyBranchSetup } from "./branches.ts";

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
 * **The one "may this branch be resolved, listed or counted" filter** (U5):
 * an accessible lifecycle state *and* not deleted by a platform admin. Every
 * place a branch is resolved (`resolveCenterRelations`, branch grants), listed
 * (switcher, hub, Discover, the teacher directory, every portal) or rolled up
 * (Analytics) spreads this — a soft-deleted branch must vanish from all of
 * them at once, so there is no second spelling of it.
 */
export const ACCESSIBLE_CENTER = {
  lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] },
  deletedAt: null,
} satisfies Prisma.CenterWhereInput;

/** The same rule for a centre row already in hand (an invitation's, say). */
export function isAccessibleCenter(center: {
  lifecycleState: CenterLifecycleState;
  deletedAt: Date | null;
}): boolean {
  return ACCESSIBLE_LIFECYCLE_STATES.includes(center.lifecycleState) && center.deletedAt === null;
}

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
  /**
   * The new organization this branch founds (F1). Its name defaults to the
   * branch's own and its branch limit to 1 — the shape every caller had
   * before F1, and what a caller that passes no organization still gets.
   */
  organization?: { name: string; nameEn?: string | null; maxBranches?: number };
};

export type CreateCenterResult =
  | { ok: true; center: Center }
  | { ok: false; error: "slugTaken" };

/** The branch columns every way of creating one takes (F1). */
type BranchRowInput = {
  organizationId: string;
  name: string;
  nameEn: string | null;
  slug: string;
  themeColor: string;
  lifecycleState: CenterLifecycleState;
  /** Only the founding branch of a new organization carries one. */
  founderInvite?: CenterInvite;
};

/**
 * **The one way a branch row is born** (F1): the `Center` row, then
 * `provisionCenterBaseline` (`lib/db/provision.ts`) for everything it needs to
 * work — its CenterSettings row, the baseline permission matrix and the
 * default payment methods. Super Admin's "New organization" and "Add to an
 * existing organization" and an Owner's own Add branch (`lib/db/branches.ts`)
 * all call this on the caller's transaction; none re-lists the baseline (P1:
 * the demo seed once had its own copy of "create a centre" that forgot the
 * grants, and its Owner saw only the Dashboard).
 */
export async function provisionBranch(
  tx: Prisma.TransactionClient,
  input: BranchRowInput,
): Promise<Center> {
  const invite = input.founderInvite;
  const created = await tx.center.create({
    data: {
      name: input.name,
      nameEn: input.nameEn,
      slug: input.slug,
      themeColor: input.themeColor,
      lifecycleState: input.lifecycleState,
      organizationId: input.organizationId,
      ...(invite
        ? {
            invitations: {
              create: {
                email: invite.email,
                role: "OWNER",
                token: invite.token,
                invitedBy: invite.invitedBy,
                expiresAt: invite.expiresAt,
              },
            },
          }
        : {}),
    },
  });
  await provisionCenterBaseline(tx, created.id);
  return created;
}

/**
 * Creates a Center + its organization + the founding Owner invitation, then
 * hands the centre to `provisionBranch` — all in one transaction. The M9
 * equivalent of how `configureCenter` (M2's gate) provisions a fresh center's
 * config in one call, no per-center branching. Adding a branch to an
 * organization that already exists is `addBranchToOrganization` below (F1,
 * OD-12 (a)); an Owner's own Add branch is `lib/db/branches.ts` (OD-12 (b)).
 */
export async function createCenterWithSettings(
  db: Db,
  input: CreateCenterInput,
): Promise<CreateCenterResult> {
  const existing = await db.center.findUnique({ where: { slug: input.slug } });
  if (existing) return { ok: false, error: "slugTaken" };

  const center = await runInTransaction(db, async (tx) => {
    // A platform-created center founds its own organization (M11) — the
    // same shape the M11 migration's backfill gave every pre-existing center.
    const organization = await tx.organization.create({
      data: {
        name: input.organization?.name ?? input.name,
        nameEn: input.organization ? (input.organization.nameEn ?? null) : (input.nameEn ?? null),
        maxBranches: input.organization?.maxBranches ?? 1,
      },
    });
    return provisionBranch(tx, {
      organizationId: organization.id,
      name: input.name,
      nameEn: input.nameEn ?? null,
      slug: input.slug,
      themeColor: input.themeColor,
      // A freshly admin-provisioned center hasn't done anything yet — no
      // staff signed in, no config touched — so it starts ONBOARDING rather
      // than ACTIVE (docs/00 §5.1 "Centre lifecycle"). ONBOARDING already
      // permits sign-in (`ACCESSIBLE_LIFECYCLE_STATES` above), so the invited
      // Owner can still accept the invite and set the center up; moving it to
      // ACTIVE once setup is real is a deliberate lifecycle transition an
      // admin makes from `/admin/centers/[id]`, not an automatic flip.
      lifecycleState: "ONBOARDING",
      founderInvite: input.invite,
    });
  });

  return { ok: true, center };
}

// ── Organizations and their branch limit (F1, OD-12 (a)+(b)) ────────────

/**
 * Branches that count against `Organization.maxBranches`: every non-ARCHIVED
 * centre that is not deleted (U5 — a soft delete frees its slot).
 */
export const COUNTED_BRANCHES = {
  lifecycleState: { not: "ARCHIVED" },
  deletedAt: null,
} satisfies Prisma.CenterWhereInput;

export type BranchLimitLock = { maxBranches: number; used: number };

/**
 * Locks the organization's row (`SELECT … FOR UPDATE`) and then counts its
 * branches **in a second statement**, so the count is taken after the lock
 * is held and sees a branch a concurrent add has just committed (under READ
 * COMMITTED a statement's snapshot is taken before it blocks — docs/07 §2.5).
 * Two adds racing for the last slot therefore serialize here: the second
 * waits, recounts, and is refused. `null` when the organization is gone.
 */
export async function lockOrganizationBranches(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<BranchLimitLock | null> {
  const rows = await tx.$queryRaw<{ maxBranches: number }[]>`
    SELECT "maxBranches" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
  if (rows.length === 0) return null;
  const used = await tx.center.count({ where: { organizationId, ...COUNTED_BRANCHES } });
  return { maxBranches: rows[0].maxBranches, used };
}

export type AddBranchInput = {
  organizationId: string;
  name: string;
  nameEn?: string | null;
  slug: string;
  themeColor: string;
  /**
   * "Copy setup from <branch>" (moved here from the Owner's retired Settings →
   * Branches, U5): a non-deleted branch of the **same** organization, and the
   * ticked parts. Omitted or `null`: the provisioning baseline only.
   */
  copyFrom?: { centerId: string; keys: readonly BranchCopyKey[] } | null;
};

export type AddBranchResult =
  | { ok: true; center: Center; copied: BranchCopyKey[] }
  | {
      ok: false;
      error: "slugTaken" | "organizationNotFound" | "branchLimitReached" | "sourceNotFound";
    };

/**
 * Super Admin's "Add to an existing organization" (F1, OD-12 (a)) — since U5
 * the **only** way a branch joins an existing organization: no centre role can
 * create one. Respects the limit — refused with `branchLimitReached` until the
 * admin raises it — and creates no Owner invitation: the organization's Owner
 * already resolves every branch under it through the read-time widening
 * (docs/02 §4). The copy source is re-checked under the organization lock: it
 * must belong to this organization and not be deleted (`sourceNotFound`).
 */
export async function addBranchToOrganization(
  db: Db,
  input: AddBranchInput,
): Promise<AddBranchResult> {
  const existing = await db.center.findUnique({ where: { slug: input.slug } });
  if (existing) return { ok: false, error: "slugTaken" };

  return runInTransaction(db, async (tx): Promise<AddBranchResult> => {
    const lock = await lockOrganizationBranches(tx, input.organizationId);
    if (!lock) return { ok: false, error: "organizationNotFound" };
    if (input.copyFrom) {
      const source = await tx.center.findFirst({
        where: { id: input.copyFrom.centerId, organizationId: input.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!source) return { ok: false, error: "sourceNotFound" };
    }
    if (lock.used >= lock.maxBranches) return { ok: false, error: "branchLimitReached" };
    const center = await provisionBranch(tx, {
      organizationId: input.organizationId,
      name: input.name,
      nameEn: input.nameEn ?? null,
      slug: input.slug,
      themeColor: input.themeColor,
      lifecycleState: "ONBOARDING",
    });
    const copied = input.copyFrom
      ? await copyBranchSetup(tx, input.copyFrom.centerId, center.id, input.copyFrom.keys)
      : [];
    return { ok: true, center, copied };
  });
}

export type BranchLimitUpdateResult =
  | { ok: true; before: number; after: number }
  | { ok: false; error: "notFound" | "invalidLimit" };

/**
 * The admin's branch-limit editor (F1). Platform admin only — the caller has
 * run `requirePlatformAdmin()`. Audited `platform.organization.limit.update`
 * on the same transaction, with no centre (the organization sits above the
 * tenant) and before/after numbers only. Lowering it below the current count
 * is allowed and only blocks new branches — nothing existing is touched.
 */
export async function updateOrganizationBranchLimit(
  db: Db,
  input: { organizationId: string; maxBranches: number; actorUserId: string },
): Promise<BranchLimitUpdateResult> {
  if (
    !Number.isInteger(input.maxBranches) ||
    input.maxBranches < 1 ||
    input.maxBranches > MAX_BRANCH_LIMIT
  ) {
    return { ok: false, error: "invalidLimit" };
  }
  return runInTransaction(db, async (tx): Promise<BranchLimitUpdateResult> => {
    const lock = await lockOrganizationBranches(tx, input.organizationId);
    if (!lock) return { ok: false, error: "notFound" };
    await tx.organization.update({
      where: { id: input.organizationId },
      data: { maxBranches: input.maxBranches },
    });
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId: input.actorUserId,
      action: "platform.organization.limit.update",
      entityType: "Organization",
      entityId: input.organizationId,
      before: { maxBranches: lock.maxBranches },
      after: { maxBranches: input.maxBranches },
    });
    return { ok: true, before: lock.maxBranches, after: input.maxBranches };
  });
}

export type PlatformOrganizationRow = {
  id: string;
  name: string;
  nameEn: string | null;
  maxBranches: number;
  /** Non-ARCHIVED, non-deleted branches — what the limit counts. */
  usedBranches: number;
  /** Every non-deleted branch, archived included. */
  totalBranches: number;
  createdAt: Date;
};

/** Every organization with its branch usage — `/admin/organizations` and the create form's picker. */
export async function platformOrganizationList(db: Db): Promise<PlatformOrganizationRow[]> {
  const [organizations, grouped] = await Promise.all([
    db.organization.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, nameEn: true, maxBranches: true, createdAt: true },
    }),
    db.center.groupBy({
      by: ["organizationId", "lifecycleState"],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ]);
  const used = new Map<string, number>();
  const total = new Map<string, number>();
  for (const row of grouped) {
    total.set(row.organizationId, (total.get(row.organizationId) ?? 0) + row._count._all);
    if (row.lifecycleState !== "ARCHIVED") {
      used.set(row.organizationId, (used.get(row.organizationId) ?? 0) + row._count._all);
    }
  }
  return organizations.map((organization) => ({
    ...organization,
    usedBranches: used.get(organization.id) ?? 0,
    totalBranches: total.get(organization.id) ?? 0,
  }));
}

/** One organization row — `/admin/organizations/[id]`. */
export function platformOrganizationById(db: Db, id: string) {
  return db.organization.findUnique({ where: { id } });
}

// ── Center list (the /admin/centers table) ──────────────────────────────

export type PlatformCenterRow = {
  id: string;
  name: string;
  nameEn: string | null;
  organizationId: string;
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
export async function platformCenterList(
  db: Db,
  /** F1: one organization's branches only — `/admin/organizations/[id]`. */
  organizationId?: string,
): Promise<PlatformCenterRow[]> {
  // U5: a deleted branch is listed only in its organization's own "Deleted
  // branches" section (`lib/db/branch-admin.ts`), never here.
  const inOrganization = { center: { deletedAt: null, ...(organizationId ? { organizationId } : {}) } };
  const [centers, membershipCounts, studentCounts] = await Promise.all([
    db.center.findMany({
      where: { deletedAt: null, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        nameEn: true,
        organizationId: true,
        slug: true,
        lifecycleState: true,
        themeColor: true,
        createdAt: true,
      },
    }),
    db.membership.groupBy({
      by: ["centerId", "role"],
      where: { active: true, ...inOrganization },
      _count: { _all: true },
    }),
    db.studentProfile.groupBy({
      by: ["centerId"],
      where: { active: true, ...inOrganization },
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
  // U5: a deleted branch is not a tenant any more — counted nowhere.
  const [total, grouped] = await Promise.all([
    db.center.count({ where: { deletedAt: null } }),
    db.center.groupBy({ by: ["lifecycleState"], where: { deletedAt: null }, _count: { _all: true } }),
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
  return db.membership.count({ where: { role: TEACHER_ROLE, active: true, center: { deletedAt: null } } });
}

export async function platformStudentCount(db: Db): Promise<number> {
  return db.studentProfile.count({ where: { active: true, center: { deletedAt: null } } });
}

export async function platformSessionCount(db: Db): Promise<number> {
  return db.session.count({ where: { center: { deletedAt: null } } });
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
  const centers = await db.center.findMany({ where: { deletedAt: null }, select: { createdAt: true } });

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

/** Every centre that may operate (ONBOARDING/ACTIVE/GRACE, not deleted), for the directories. */
export function listAccessibleCenters(db: Db) {
  return db.center.findMany({
    where: ACCESSIBLE_CENTER,
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

/** Sets (or clears) a centre's logo key — the branch's own Branding page (F8). */
export function setCenterLogoPath(db: Db, centerId: string, logoPath: string | null) {
  return db.center.update({ where: { id: centerId }, data: { logoPath }, select: { id: true } });
}

/** An invitation by its token, with its centre — the accept page (the token is the only link). */
export function invitationByToken(db: Db, token: string) {
  return db.invitation.findUnique({ where: { token }, include: { center: true } });
}
