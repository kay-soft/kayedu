import type { Prisma, PrismaClient, Role } from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/teacher-portal.ts).
import { fullName, localName } from "../identity.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { CATALOG_OVERRIDE_SELECT } from "../catalog.ts";

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

/**
 * Fields a Discover card actually renders — never a full include. A function
 * of `centerId`, not a static object (M13): `subject`/`grade` each carry a
 * nested, centre-scoped `selections` lookup so a browsing student sees this
 * centre's own rename when it has one, not just the canonical catalog name.
 */
export function discoverClassSelect(centerId: string) {
  return {
    id: true,
    price: true,
    acceptsNewStudents: true,
    requiresConfirmation: true,
    teacherId: true,
    // Global catalog ids (M13) — a single subjectId/gradeId now means the
    // same thing at every centre, so filtering can be a real `where` instead
    // of the pre-M13 in-memory name match (see the page's filter logic).
    subject: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    grade: {
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    // A card's "full" state is hard-capped by the class's room set (M15,
    // revised R3 — the summed capacity of primary + extra rooms,
    // `lib/db/room-sets.ts`'s `classRoomSetFrom`).
    roomId: true,
    room: { select: { id: true, name: true, capacity: true } },
    extraRooms: {
      select: { room: { select: { id: true, name: true, capacity: true } } },
      orderBy: { createdAt: "asc" },
    },
    schedules: {
      select: { dayOfWeek: true, startTime: true, endTime: true },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    },
    _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
  } satisfies Prisma.ClassGroupSelect;
}

export type DiscoverClassRow = Prisma.ClassGroupGetPayload<{
  select: ReturnType<typeof discoverClassSelect>;
}>;

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER: Role = "TEACHER";

/**
 * Every discoverable class at one center: active, and `acceptsNewStudents`
 * (docs/00-master-product-spec.md §5 "Reservations / enrollment" — a class
 * with the flag off is hidden from new enrollment while it keeps running for
 * students already in it). Day filtering still happens in the caller, in
 * memory, after the per-center results are combined — a schedule slot is a
 * child row, not a scalar `where` can cheaply express alongside everything
 * else here. Subject/grade filtering, though, **is** a real scoped `where`
 * as of M13: `CatalogSubject`/`CatalogGrade` are global, so a single id means
 * the same thing at every centre (the in-memory name-match this replaced is
 * gone — docs/02-architecture.md §14).
 */
export function discoverClassesForCenter(
  db: PrismaClient,
  centerId: string,
  filters?: { subjectId?: string; gradeId?: string },
): Promise<DiscoverClassRow[]> {
  return db.classGroup.findMany({
    where: scopedWhere(centerId, {
      active: true,
      acceptsNewStudents: true,
      ...(filters?.subjectId ? { subjectId: filters.subjectId } : {}),
      ...(filters?.gradeId ? { gradeId: filters.gradeId } : {}),
    }),
    select: discoverClassSelect(centerId),
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
