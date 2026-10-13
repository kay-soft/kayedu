import type { EnrollmentStatus, Prisma, PrismaClient, SessionStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/teacher-portal.ts and lib/db/discover.ts).
import { scopedWhere } from "./tenant-scope.ts";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";

/**
 * Cross-center read helpers for the student's own data (M8, mirroring
 * `lib/db/teacher-portal.ts`'s doc-comment almost exactly): a student's
 * blocks, reservations and enrollments legitimately span every center they
 * have ever touched — including a center where a `Reservation` exists but no
 * `StudentProfile` has been created yet (a PENDING request before it is
 * confirmed). That is a different shape than the teacher portal's "one
 * `TenantContext` per center, unioned by the caller": there is no per-center
 * context to loop over here until a `StudentProfile` exists, so these three
 * lookups are filtered by `studentUserId` — the caller's own, server-resolved
 * identity — directly, exactly like `lib/auth/tenant.ts`'s
 * `getUserCenterRelations` already does for `Membership`/`StudentProfile`.
 * That is identity-scoping, not a missing center scope: it can only ever
 * return rows that belong to this one person, across however many centers,
 * never another student's data (docs/02-architecture.md §5).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Every block against this student, grouped by the center it was placed at. */
export async function studentBlockedRefsByCenter(
  db: Db,
  studentUserId: string,
): Promise<Map<string, { teacherIds: Set<string>; classGroupIds: Set<string> }>> {
  const rows = await db.studentBlock.findMany({ where: { blockedUserId: studentUserId } });

  const byCenter = new Map<string, { teacherIds: Set<string>; classGroupIds: Set<string> }>();
  for (const row of rows) {
    const entry = byCenter.get(row.centerId) ?? { teacherIds: new Set(), classGroupIds: new Set() };
    if (row.scope === "TEACHER") entry.teacherIds.add(row.refId);
    else entry.classGroupIds.add(row.refId);
    byCenter.set(row.centerId, entry);
  }
  return byCenter;
}

/** This student's reservation status per class, across every center. */
export async function studentReservationStatusByClass(
  db: Db,
  studentUserId: string,
): Promise<Map<string, "PENDING" | "CONFIRMED" | "REJECTED" | "CANCELLED">> {
  const rows = await db.reservation.findMany({
    where: { studentId: studentUserId },
    select: { classGroupId: true, status: true },
  });
  return new Map(rows.map((row) => [row.classGroupId, row.status]));
}

/** Every class this student is actively enrolled in, across every center. */
export async function studentActiveEnrollmentClassIds(
  db: Db,
  studentUserId: string,
): Promise<Set<string>> {
  const rows = await db.enrollment.findMany({
    where: { status: "ACTIVE", studentProfile: { userId: studentUserId } },
    select: { classGroupId: true },
  });
  return new Set(rows.map((row) => row.classGroupId));
}

/**
 * "My reservations" (spec §4.3): every request this student has ever made.
 *
 * This is the one catalog-display read in this module that genuinely can't
 * push a `selections: { where: { centerId } }` filter into the query itself
 * (M13): it's identity-scoped across every centre the student ever
 * reserved at, so there is no single `centerId` to filter the nested
 * include by. Instead it batch-resolves the distinct (centre, catalog id)
 * pairs actually present in the result — one extra query, not one per row —
 * and attaches a `selections` array to each subject/grade matching the same
 * shape a single-centre nested include would have produced, so
 * `lib/catalog.ts`'s `catalogLabelWithSelection` reads it back identically.
 */
export async function listReservationsForStudent(db: Db, studentUserId: string) {
  const rows = await db.reservation.findMany({
    where: { studentId: studentUserId },
    orderBy: { requestedAt: "desc" },
    include: {
      center: { select: { id: true, name: true, logoUrl: true, themeColor: true } },
      classGroup: {
        select: {
          id: true,
          centerId: true,
          subjectId: true,
          gradeId: true,
          subject: { select: { nameAr: true, nameEn: true } },
          grade: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
  });

  type Pair = { kind: "SUBJECT" | "GRADE"; centerId: string; catalogId: string };
  const pairsByKey = new Map<string, Pair>();
  for (const row of rows) {
    if (row.classGroup.subjectId) {
      const pair: Pair = { kind: "SUBJECT", centerId: row.classGroup.centerId, catalogId: row.classGroup.subjectId };
      pairsByKey.set(`${pair.kind}:${pair.centerId}:${pair.catalogId}`, pair);
    }
    if (row.classGroup.gradeId) {
      const pair: Pair = { kind: "GRADE", centerId: row.classGroup.centerId, catalogId: row.classGroup.gradeId };
      pairsByKey.set(`${pair.kind}:${pair.centerId}:${pair.catalogId}`, pair);
    }
  }
  const pairs = [...pairsByKey.values()];

  const selections = pairs.length
    ? await db.centerCatalogSelection.findMany({
        where: {
          OR: pairs.map((pair) =>
            pair.kind === "SUBJECT"
              ? { kind: "SUBJECT" as const, centerId: pair.centerId, subjectId: pair.catalogId }
              : { kind: "GRADE" as const, centerId: pair.centerId, gradeId: pair.catalogId },
          ),
        },
        select: { centerId: true, kind: true, subjectId: true, gradeId: true, displayName: true },
      })
    : [];

  const displayNameByKey = new Map<string, string | null>();
  for (const selection of selections) {
    const catalogId = selection.kind === "SUBJECT" ? selection.subjectId : selection.gradeId;
    if (catalogId) {
      displayNameByKey.set(`${selection.kind}:${selection.centerId}:${catalogId}`, selection.displayName);
    }
  }

  const withDisplayName = (
    kind: "SUBJECT" | "GRADE",
    centerId: string,
    catalogId: string | null,
  ) => {
    const displayName = catalogId ? (displayNameByKey.get(`${kind}:${centerId}:${catalogId}`) ?? null) : null;
    return [{ displayName }];
  };

  return rows.map((row) => ({
    ...row,
    classGroup: {
      ...row.classGroup,
      subject: row.classGroup.subject
        ? {
            ...row.classGroup.subject,
            selections: withDisplayName("SUBJECT", row.classGroup.centerId, row.classGroup.subjectId),
          }
        : null,
      grade: row.classGroup.grade
        ? {
            ...row.classGroup.grade,
            selections: withDisplayName("GRADE", row.classGroup.centerId, row.classGroup.gradeId),
          }
        : null,
    },
  }));
}

// ── Schedule: one center's slice, unioned by the caller (getStudentContexts) ─

/**
 * Fields a schedule card renders — never a full include. A function of
 * `centerId`, not a static object (M13): `subject`/`grade` each carry a
 * nested, centre-scoped `selections` lookup so a student sees this centre's
 * own rename when it has one.
 */
function studentUpcomingSessionInclude(centerId: string) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return {
    classGroup: { include: { subject: withSelection, grade: withSelection, room: true } },
    // R5 — a one-time session's own subject/grade (no class).
    subject: withSelection,
    grade: withSelection,
    room: true,
  } satisfies Prisma.SessionInclude;
}

/**
 * Every future, non-cancelled session for this student's active enrollments
 * at one center. R4: never a deactivated class's — its enrolments stay
 * ACTIVE so reactivating restores it, but it is off every forward-looking
 * list meanwhile.
 */
export function studentUpcomingSessions(
  db: Db,
  centerId: string,
  studentProfileId: string,
  fromDate: Date,
) {
  return db.session.findMany({
    where: scopedWhere(centerId, {
      date: { gte: fromDate },
      status: { not: CANCELLED_STATUS },
      classGroup: { active: true, enrollments: { some: { studentProfileId, status: ACTIVE_ENROLLMENT } } },
    }),
    include: studentUpcomingSessionInclude(centerId),
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: 100,
  });
}

/**
 * Past attendance for this student at one center — read from `SessionAttendee`
 * rather than the enrollment's schedule, because "past" must show what
 * actually happened (attended/absent/paid), not just what was scheduled.
 * Covers drop-in sessions too, since a `SessionAttendee` row exists for those
 * as well (docs/01 §1 principle 4).
 */
export function studentPastAttendance(
  db: Db,
  centerId: string,
  studentProfileId: string,
  uptoDate: Date,
) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      studentProfileId,
      session: { date: { lt: uptoDate } },
    }),
    include: {
      session: {
        include: {
          classGroup: { include: { subject: withSelection, grade: withSelection } },
          // R5 — a one-time session's own subject/grade (no class).
          subject: withSelection,
          grade: withSelection,
          room: true,
        },
      },
      payments: { where: { voided: false }, orderBy: { recordedAt: "desc" }, take: 1 },
    },
    orderBy: { session: { date: "desc" } },
    take: 100,
  });
}
