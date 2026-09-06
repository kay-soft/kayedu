import type { Prisma, PrismaClient, Role } from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/teacher-portal.ts).
import { fullName, localName } from "../identity.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * Discover/Browse read helpers (M8, docs/04-design-system.md §10). A class
 * card is inherently a **cross-center** read — the entire point of discovery
 * is browsing centers a student has no relationship with yet — so this module
 * does not take one `centerId` from a resolved `TenantContext` the way
 * `lib/db/scoped.ts` does. Instead every query here still takes one explicit
 * `centerId` and still goes through `scopedWhere` (never a `where` spanning
 * more than one center at the database layer); the caller loops over every
 * active `Center` and unions the per-center results in memory — the exact
 * "union of independently-scoped per-center queries" pattern M7's teacher
 * portal already established (docs/01-data-model.md §4), just keyed by a
 * loop over centers instead of by a teacher's own memberships.
 */

/** Fields a Discover card actually renders — never a full include. */
export const DISCOVER_CLASS_SELECT = {
  id: true,
  price: true,
  capacity: true,
  acceptsNewStudents: true,
  requiresConfirmation: true,
  teacherId: true,
  subject: { select: { id: true, name: true } },
  grade: { select: { id: true, name: true } },
  room: { select: { name: true } },
  schedules: {
    select: { dayOfWeek: true, startTime: true, endTime: true },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  },
  _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
} satisfies Prisma.ClassGroupSelect;

export type DiscoverClassRow = Prisma.ClassGroupGetPayload<{
  select: typeof DISCOVER_CLASS_SELECT;
}>;

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER: Role = "TEACHER";

/**
 * Every discoverable class at one center: active, and `acceptsNewStudents`
 * (docs/00-master-product-spec.md §5 "Reservations / enrollment" — a class
 * with the flag off is hidden from new enrollment while it keeps running for
 * students already in it). Subject/grade/day filtering happens in the caller,
 * in memory, after the per-center results are combined — `Subject`/`Grade`
 * are center-local master data (docs/01 §2), so a single subject *id* has no
 * meaning across two different centers; filtering by name post-union is the
 * only way a "Math" pill means the same thing everywhere it's offered.
 */
export function discoverClassesForCenter(
  db: PrismaClient,
  centerId: string,
): Promise<DiscoverClassRow[]> {
  return db.classGroup.findMany({
    where: scopedWhere(centerId, { active: true, acceptsNewStudents: true }),
    select: DISCOVER_CLASS_SELECT,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
}

/**
 * A class card shows the teacher's name **as this center knows them**
 * (docs/01 §6 — the local `Membership` record, not the raw global `User`),
 * batched once per center rather than once per class (docs/02 §14).
 */
export async function teacherDisplayNames(
  db: PrismaClient,
  centerId: string,
  teacherUserIds: string[],
): Promise<Map<string, string>> {
  if (teacherUserIds.length === 0) return new Map();

  const rows = await db.membership.findMany({
    where: scopedWhere(centerId, { userId: { in: teacherUserIds }, role: TEACHER }),
    select: {
      userId: true,
      firstName: true,
      lastName: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

  return new Map(
    rows.map((row) => [row.userId, fullName(localName(row, row.user))]),
  );
}
