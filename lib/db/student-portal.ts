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

/** "My reservations" (spec §4.3): every request this student has ever made. */
export function listReservationsForStudent(db: Db, studentUserId: string) {
  return db.reservation.findMany({
    where: { studentId: studentUserId },
    orderBy: { requestedAt: "desc" },
    include: {
      center: { select: { id: true, name: true, logoUrl: true, themeColor: true } },
      classGroup: {
        select: {
          id: true,
          subject: { select: { nameAr: true, nameEn: true } },
          grade: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
  });
}

// ── Schedule: one center's slice, unioned by the caller (getStudentContexts) ─

/** Fields a schedule card renders — never a full include. */
export const STUDENT_UPCOMING_SESSION_INCLUDE = {
  classGroup: { include: { subject: true, grade: true, room: true } },
  room: true,
} satisfies Prisma.SessionInclude;

/** Every future, non-cancelled session for this student's active enrollments at one center. */
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
      classGroup: { enrollments: { some: { studentProfileId, status: ACTIVE_ENROLLMENT } } },
    }),
    include: STUDENT_UPCOMING_SESSION_INCLUDE,
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
  return db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      studentProfileId,
      session: { date: { lt: uptoDate } },
    }),
    include: {
      session: { include: { classGroup: { include: { subject: true, grade: true } }, room: true } },
      payments: { where: { voided: false }, orderBy: { recordedAt: "desc" }, take: 1 },
    },
    orderBy: { session: { date: "desc" } },
    take: 100,
  });
}
