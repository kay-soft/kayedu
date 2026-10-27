import type { EnrollmentStatus, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose: `check:people` and `check:isolation` call these
// directly outside Next, so the gates test the REAL promotion, not a copy.
import { centerGradeById } from "./catalog.ts";
import { writeAuditRow } from "./audit-row.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { isWithinUndoWindow, MAX_PROMOTION_STUDENTS } from "../promotion.ts";

/**
 * Bulk grade promotion (F4, docs/00 §4.1 item 4): previewable, partial and
 * undoable — and confined to **one branch's own record**.
 *
 * - It changes `StudentProfile.gradeId` for the students ticked, at this
 *   `centerId`, and nothing else: never an enrolment, class, session, money
 *   row, another branch, or `User.gradeId`.
 * - A confirm re-reads the world: only students who are *still* active and
 *   *still* in the From grade move (rows are locked `FOR UPDATE` first), so a
 *   stale preview cannot move someone who changed in the meantime.
 * - One transaction writes the grade changes, the `GradePromotionBatch` with
 *   one `GradePromotionItem` per student actually moved, and one audit row
 *   (`student.grade.promote`: batch id + counts, D-20).
 * - The latest not-yet-undone batch can be undone for `PROMOTION_UNDO_DAYS`,
 *   reverting only items whose grade still equals the batch's To grade.
 */

type Tx = Prisma.TransactionClient;

/** Typed so the `where` keeps the enum, not `string`. */
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export type PromotionRefusal = {
  ok: false;
  error: "notFound" | "samePromotionGrade" | "noStudentsToPromote" | "tooMany" | "notLatest" | "expired" | "alreadyUndone";
};

// ── Preview ──────────────────────────────────────────────────────────────

export type PromotionPreviewRow = {
  id: string;
  studentCode: string;
  firstName: string | null;
  lastName: string | null;
  user: { firstName: string; lastName: string };
  /** The student's own account grade when it is set and differs from the branch's. */
  accountGradeId: string | null;
  /** Active enrolments in classes of the From grade — kept as they are. */
  activeEnrollments: number;
};

/**
 * Every **active** student at this branch whose grade on file is `fromGradeId`,
 * with the two facts the preview shows beside each: a differing account grade
 * and the active enrolments in classes of the From grade. Read-only.
 */
export async function promotionPreview(
  db: PrismaClient | Tx,
  centerId: string,
  fromGradeId: string,
): Promise<PromotionPreviewRow[]> {
  const students = await db.studentProfile.findMany({
    where: scopedWhere(centerId, { gradeId: fromGradeId, active: true }),
    orderBy: { studentCode: "asc" },
    select: {
      id: true,
      studentCode: true,
      firstName: true,
      lastName: true,
      user: { select: { firstName: true, lastName: true, gradeId: true } },
    },
  });
  if (students.length === 0) return [];

  const enrolments = await db.enrollment.groupBy({
    by: ["studentProfileId"],
    where: scopedWhere(centerId, {
      studentProfileId: { in: students.map((student) => student.id) },
      status: ACTIVE_ENROLLMENT,
      classGroup: { gradeId: fromGradeId },
    }),
    _count: { studentProfileId: true },
  });
  const enrolmentCount = new Map(enrolments.map((row) => [row.studentProfileId, row._count.studentProfileId]));

  return students.map((student) => ({
    id: student.id,
    studentCode: student.studentCode,
    firstName: student.firstName,
    lastName: student.lastName,
    user: { firstName: student.user.firstName, lastName: student.user.lastName },
    accountGradeId:
      student.user.gradeId && student.user.gradeId !== fromGradeId ? student.user.gradeId : null,
    activeEnrollments: enrolmentCount.get(student.id) ?? 0,
  }));
}

// ── Confirm ──────────────────────────────────────────────────────────────

export type PromotionResult = {
  ok: true;
  batchId: string;
  /** Students actually moved. */
  count: number;
  /** Ticked students who were no longer active, or no longer in the From grade. */
  skipped: number;
};

export async function confirmGradePromotion(
  db: PrismaClient,
  input: {
    centerId: string;
    actorUserId: string;
    fromGradeId: string;
    toGradeId: string;
    studentIds: string[];
  },
): Promise<PromotionResult | PromotionRefusal> {
  const { centerId, actorUserId, fromGradeId, toGradeId } = input;
  const studentIds = [...new Set(input.studentIds)];
  if (fromGradeId === toGradeId) return { ok: false, error: "samePromotionGrade" };
  if (studentIds.length === 0) return { ok: false, error: "noStudentsToPromote" };
  if (studentIds.length > MAX_PROMOTION_STUDENTS) return { ok: false, error: "tooMany" };

  // Both grades are resolved through this branch's own catalog picks — a
  // grade id it never picked is not a grade as far as this branch knows. The
  // destination must be on offer (R8); students may still leave a grade the
  // platform has since deactivated.
  const [from, to] = await Promise.all([
    centerGradeById(db, centerId, fromGradeId),
    centerGradeById(db, centerId, toGradeId),
  ]);
  if (!from || !to || !to.active || !to.catalogActive) return { ok: false, error: "notFound" };

  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "StudentProfile"
      WHERE "centerId" = ${centerId}
        AND "id" = ANY(${studentIds}::text[])
        AND "gradeId" = ${fromGradeId}
        AND "active" = true
      FOR UPDATE`;
    if (locked.length === 0) return { ok: false, error: "noStudentsToPromote" } as const;
    const movedIds = locked.map((row) => row.id);

    await tx.studentProfile.updateMany({
      where: scopedWhere(centerId, { id: { in: movedIds }, gradeId: fromGradeId }),
      data: { gradeId: toGradeId },
    });

    const batch = await tx.gradePromotionBatch.create({
      data: { centerId, fromGradeId, toGradeId, createdBy: actorUserId },
      select: { id: true },
    });
    await tx.gradePromotionItem.createMany({
      data: movedIds.map((studentProfileId) => ({
        batchId: batch.id,
        studentProfileId,
        previousGradeId: fromGradeId,
      })),
    });
    await writeAuditRow(tx, {
      centerId,
      actorUserId,
      action: "student.grade.promote",
      entityType: "GradePromotionBatch",
      entityId: batch.id,
      after: { fromGradeId, toGradeId, count: movedIds.length, skipped: studentIds.length - movedIds.length },
    });

    return { ok: true, batchId: batch.id, count: movedIds.length, skipped: studentIds.length - movedIds.length } as const;
  }, TRANSACTION_OPTIONS);
}

// ── Undo ─────────────────────────────────────────────────────────────────

export type UndoResult = {
  ok: true;
  /** Students put back in the From grade. */
  reverted: number;
  /** Students whose grade had changed since, left exactly as they are. */
  skipped: number;
};

/**
 * The latest not-yet-undone batch at this branch, if `batchId` is it, and
 * still inside its undo window. Reverts only items whose grade **still equals
 * the batch's To grade** — a student a manager has since moved elsewhere is
 * left alone. Audited `student.grade.promote.undo` (batch id + counts).
 */
export async function undoGradePromotion(
  db: PrismaClient,
  input: { centerId: string; actorUserId: string; batchId: string; now?: Date },
): Promise<UndoResult | PromotionRefusal> {
  const { centerId, actorUserId, batchId } = input;
  const now = input.now ?? new Date();

  return db.$transaction(async (tx) => {
    // Serialises two staff pressing Undo at once: the batch row is the lock.
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "GradePromotionBatch" WHERE "id" = ${batchId} AND "centerId" = ${centerId} FOR UPDATE`;
    if (found.length === 0) return { ok: false, error: "notFound" } as const;

    const batch = await tx.gradePromotionBatch.findFirst({
      where: scopedWhere(centerId, { id: batchId }),
      include: { items: true },
    });
    if (!batch) return { ok: false, error: "notFound" } as const;
    if (batch.undoneAt) return { ok: false, error: "alreadyUndone" } as const;

    const latest = await tx.gradePromotionBatch.findFirst({
      where: scopedWhere(centerId, { undoneAt: null }),
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (latest?.id !== batch.id) return { ok: false, error: "notLatest" } as const;
    if (!isWithinUndoWindow(batch.createdAt, now)) return { ok: false, error: "expired" } as const;

    let reverted = 0;
    const previousGrades = new Set(batch.items.map((item) => item.previousGradeId));
    for (const previousGradeId of previousGrades) {
      const ids = batch.items.filter((item) => item.previousGradeId === previousGradeId).map((item) => item.studentProfileId);
      // Lock first, then move only the rows still sitting in the To grade.
      const stillThere = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "StudentProfile"
        WHERE "centerId" = ${centerId}
          AND "id" = ANY(${ids}::text[])
          AND "gradeId" = ${batch.toGradeId}
        FOR UPDATE`;
      if (stillThere.length === 0) continue;
      const result = await tx.studentProfile.updateMany({
        where: scopedWhere(centerId, { id: { in: stillThere.map((row) => row.id) }, gradeId: batch.toGradeId }),
        data: { gradeId: previousGradeId },
      });
      reverted += result.count;
    }

    await tx.gradePromotionBatch.updateMany({
      where: scopedWhere(centerId, { id: batch.id, undoneAt: null }),
      data: { undoneAt: now, undoneBy: actorUserId },
    });
    await writeAuditRow(tx, {
      centerId,
      actorUserId,
      action: "student.grade.promote.undo",
      entityType: "GradePromotionBatch",
      entityId: batch.id,
      after: { reverted, skipped: batch.items.length - reverted },
    });

    return { ok: true, reverted, skipped: batch.items.length - reverted } as const;
  }, TRANSACTION_OPTIONS);
}

// ── History ──────────────────────────────────────────────────────────────

/** "First Last" for the staff who ran or undid batches (ids only are stored on the batch). */
export async function promotionActorNames(
  db: PrismaClient | Tx,
  userIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((user) => [user.id, `${user.firstName} ${user.lastName}`.trim()]));
}
