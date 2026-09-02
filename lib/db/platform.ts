import type { Center, Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:admin` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/payments.ts,
// lib/db/approvals.ts, lib/db/analytics.ts).

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

const STAFF_ROLES: readonly Role[] = ["OWNER", "MANAGER", "RECEPTIONIST"];
const TEACHER_ROLE: Role = "TEACHER";

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
  logoUrl?: string | null;
  themeColor: string;
  plan?: string | null;
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
 * Creates a Center + its CenterSettings row + the founding Owner invitation
 * in one nested write — the M9 equivalent of how `configureCenter` (M2's
 * gate) provisions a fresh center's config in one call, no per-center
 * branching. Settings defaults mirror `prisma/seed.ts`'s (percentage cut
 * 15%, 10-minute late threshold, Cairo timezone) — a new tenant should start
 * from the same sane defaults the seeded demo center does.
 */
export async function createCenterWithSettings(
  db: Db,
  input: CreateCenterInput,
): Promise<CreateCenterResult> {
  const existing = await db.center.findUnique({ where: { slug: input.slug } });
  if (existing) return { ok: false, error: "slugTaken" };

  const center = await db.center.create({
    data: {
      name: input.name,
      nameEn: input.nameEn ?? null,
      slug: input.slug,
      logoUrl: input.logoUrl ?? null,
      themeColor: input.themeColor,
      plan: input.plan ?? null,
      active: true,
      settings: {
        create: {
          defaultShareType: "PERCENTAGE",
          defaultShareValue: 15,
          defaultLateThreshold: 10,
          timezone: "Africa/Cairo",
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

  return { ok: true, center };
}

export async function setCenterActive(
  db: Db,
  centerId: string,
  active: boolean,
): Promise<Center> {
  return db.center.update({ where: { id: centerId }, data: { active } });
}

/** `Center.plan` is loose onboarding/plan metadata (docs/01 §2) — free text. */
export async function updateCenterPlan(
  db: Db,
  centerId: string,
  plan: string | null,
): Promise<Center> {
  return db.center.update({ where: { id: centerId }, data: { plan } });
}

// ── Center list (the /admin/centers table) ──────────────────────────────

export type PlatformCenterRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  themeColor: string;
  plan: string | null;
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
        active: true,
        themeColor: true,
        plan: true,
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

export type PlatformCenterCounts = { total: number; active: number; suspended: number };

export async function platformCenterCounts(db: Db): Promise<PlatformCenterCounts> {
  const [total, active] = await Promise.all([
    db.center.count(),
    db.center.count({ where: { active: true } }),
  ]);
  return { total, active, suspended: total - active };
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
  await db.auditLog.create({
    data: {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "platform.support.access",
      entityType: "Center",
      entityId: input.centerId,
    },
  });
}
