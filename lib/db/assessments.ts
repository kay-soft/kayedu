import type { AssessmentType, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assessments` calls this module
// directly, outside Next (the lib/db/notifications.ts discipline).
import {
  assessmentClosesAt,
  assessmentDefaults,
  defaultHomeworkDeadline,
  draftErrors,
  finalisationDue,
  hasClosed,
  isReady,
  pickNextSessionStart,
  readiness,
  sessionInstant,
  type AssessmentDraft,
  type DraftError,
  type HomeworkDeadlineBasis,
} from "../assessments.ts";
import { outsideTeacherHistory } from "../assessment-results.ts";
import { canInContext, type PermissionGrants, type TenantRole } from "../auth/permissions.ts";
import { sessionLabelSelect } from "../session-label.ts";
import { finaliseDueAttempts, finaliseIfDue } from "./assessment-attempts.ts";
import { assistantMayAt, onBehalfOf } from "./assistant-acting.ts";
import { writeAuditRow } from "./audit-row.ts";
import { deleteAssessmentNotices, notifyAssessmentExtended, notifyAssessmentPublished } from "./notifications.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * Teachers' exams and homework (W2, D-W01–D-W06, D-W11, D-W30) — the one data
 * module. **Authority = owning the row** (the U9 precedent): an ACTIVE TEACHER
 * membership at the row's branch, holding that branch's `assessment.manage.own`
 * cell. An exam is created by the class's own teacher, a homework by the
 * session's own teacher (a per-session teacher change counts). After that the
 * owning membership (`teacherMembershipId`) is the authority for every read,
 * edit and delete. Centre staff never reach any of it (D-W11): no `(center)`
 * page or action imports this module (`check:assessments`, statically).
 *
 * Every writer takes the **actor** (the user doing it) and the **owning
 * teacher** as separate parameters, so W7's on-behalf writes (actor = the
 * assistant, teacher = T, D-W18) fit without reshaping them. Every
 * question/option write asks `isAssessmentLocked` first (D-W08).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AssessmentActor = { userId: string };
export type AssessmentTeacher = { centerId: string; membershipId: string; userId: string };

/** What the resolver needs of a request context — a real `TenantContext` satisfies it. */
export type AssessmentAuthorityContext = {
  center: { id: string };
  user: { id: string };
  role: TenantRole;
  grants: PermissionGrants;
  experienceDenied: boolean;
};

/**
 * The owning-teacher identity for a write or read at `ctx`'s branch, or null:
 * the context must be the TEACHER experience, hold `assessment.manage.own`
 * there (the Owner can switch it off; centre staff roles can never hold it —
 * the ceiling), and the person must have an ACTIVE TEACHER membership at that
 * branch, re-read here rather than trusted from the context.
 */
export async function resolveAssessmentTeacher(db: Db, ctx: AssessmentAuthorityContext): Promise<AssessmentTeacher | null> {
  if (ctx.role !== "TEACHER" || !canInContext(ctx, "assessment.manage.own")) return null;
  const membership = await db.membership.findFirst({
    where: scopedWhere(ctx.center.id, { userId: ctx.user.id, role: "TEACHER" as const, active: true }),
    select: { id: true },
  });
  return membership ? { centerId: ctx.center.id, membershipId: membership.id, userId: ctx.user.id } : null;
}

/**
 * D-W08: true once any student has started (W3a): from then on the questions,
 * options and points are fixed, and only an extension may change the row.
 */
export async function isAssessmentLocked(db: Db, centerId: string, assessmentId: string): Promise<boolean> {
  const attempts = await db.assessmentAttempt.count({ where: scopedWhere(centerId, { assessmentId }) });
  return attempts > 0;
}

// ── Reads (the owning teacher's own rows) ──────────────────────────────────

export const classLabelSelect = (centerId: string) => {
  const catalog = sessionLabelSelect(centerId).classGroup.select.subject;
  return { id: true, active: true, subject: catalog, grade: catalog } as const;
};

const sessionSummarySelect = {
  id: true,
  date: true,
  startTime: true,
  endTime: true,
  timezone: true,
  status: true,
  rescheduledToId: true,
} as const;

/**
 * The teacher's own history window at one branch (U6, D-W33): `floor` is
 * `teacherPortalHistoryFloor`, `zone` the branch's. A row is judged on its closing
 * day in its own frozen timezone (`outsideTeacherHistory`); a draft is never hidden.
 */
export type TeacherHistory = { floor: Date | null; zone: string };

export type AssessmentListFilter = {
  type?: AssessmentType;
  classGroupId?: string;
  sessionId?: string;
  /** The calendar's range (W3b): an exam by when it opens, a homework by its deadline. */
  within?: { from: Date; to: Date };
  /** Every list passes it. Only the calendar does not: it clamps its own range to the floor. */
  history?: TeacherHistory;
};

function hiddenByHistory(
  row: Parameters<typeof outsideTeacherHistory>[0] & { session: { timezone: string | null } | null },
  history: TeacherHistory | undefined,
): boolean {
  if (!history) return false;
  return outsideTeacherHistory(row, row.session ? sessionZone(row.session, history.zone) : history.zone, history.floor);
}

export async function listTeacherAssessments(db: Db, teacher: AssessmentTeacher, filter: AssessmentListFilter = {}) {
  const rows = await db.assessment.findMany({
    where: scopedWhere(teacher.centerId, {
      teacherMembershipId: teacher.membershipId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.classGroupId ? { classGroupId: filter.classGroupId } : {}),
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(filter.within
        ? {
            OR: [
              { type: "EXAM" as const, windowStart: { gte: filter.within.from, lte: filter.within.to } },
              { type: "HOMEWORK" as const, deadline: { gte: filter.within.from, lte: filter.within.to } },
            ],
          }
        : {}),
    }),
    select: {
      id: true,
      type: true,
      status: true,
      title: true,
      windowStart: true,
      windowEnd: true,
      deadline: true,
      updatedAt: true,
      classGroupId: true,
      classGroup: { select: classLabelSelect(teacher.centerId) },
      session: { select: sessionSummarySelect },
      _count: { select: { questions: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return rows.filter((row) => !hiddenByHistory(row, filter.history));
}

export type TeacherAssessmentListRow = Awaited<ReturnType<typeof listTeacherAssessments>>[number];

/**
 * Started and submitted per assessment, for the teacher's own rows on a calendar
 * day (W3b). This reads attempts, so what is overdue is finalised first (D-W10);
 * only those that are due cost a write, and the count is the same either way.
 */
export async function assessmentAttemptCounts(
  db: PrismaClient,
  teacher: AssessmentTeacher,
  assessmentIds: readonly string[],
  now: Date,
): Promise<Map<string, { started: number; submitted: number }>> {
  const counts = new Map<string, { started: number; submitted: number }>();
  if (assessmentIds.length === 0) return counts;
  const attempts = await db.assessmentAttempt.findMany({
    where: scopedWhere(teacher.centerId, {
      assessmentId: { in: [...assessmentIds] },
      assessment: { teacherMembershipId: teacher.membershipId },
    }),
    select: {
      id: true,
      assessmentId: true,
      startedAt: true,
      lastSeenAt: true,
      submittedAt: true,
      assessment: {
        select: { type: true, windowStart: true, windowEnd: true, deadline: true, durationMinutes: true, oneSitting: true },
      },
    },
  });
  for (const attempt of attempts) {
    const due = attempt.submittedAt ? null : finalisationDue(attempt.assessment, attempt, now);
    if (due) await finaliseIfDue(db, teacher.centerId, attempt.id, now);
    const entry = counts.get(attempt.assessmentId) ?? { started: 0, submitted: 0 };
    entry.started += 1;
    if (attempt.submittedAt || due) entry.submitted += 1;
    counts.set(attempt.assessmentId, entry);
  }
  return counts;
}

/**
 * The builder's read — the teacher's own row, `isCorrect` included (never a student
 * read). With `history`, a published row outside the teacher's window reads as not
 * found (D-W33); writes never pass it (U6: the window is not an integrity check).
 */
export async function findTeacherAssessment(db: Db, teacher: AssessmentTeacher, assessmentId: string, options: { history?: TeacherHistory } = {}) {
  const row = await db.assessment.findFirst({
    where: scopedWhere(teacher.centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
    include: {
      classGroup: { select: classLabelSelect(teacher.centerId) },
      session: { select: sessionSummarySelect },
      questions: {
        orderBy: { position: "asc" },
        include: { options: { orderBy: { position: "asc" } } },
      },
      _count: { select: { attempts: true } },
    },
  });
  return row && hiddenByHistory(row, options.history) ? null : row;
}

export type TeacherAssessment = NonNullable<Awaited<ReturnType<typeof findTeacherAssessment>>>;

/** A class this teacher may set an exam on: theirs, at this branch, active. */
export function findOwnClassForExam(db: Db, teacher: AssessmentTeacher, classGroupId: string) {
  return db.classGroup.findFirst({
    where: scopedWhere(teacher.centerId, { id: classGroupId, teacherId: teacher.userId, active: true }),
    select: { ...classLabelSelect(teacher.centerId), teacherId: true },
  });
}

/**
 * A session this teacher may set homework from: theirs (its own `teacherId`,
 * so a per-session teacher change counts), on a class — a one-time session
 * has no enrolment, so nobody could take it (D-W03) — not cancelled, and not
 * moved away (its replacement is where the homework belongs).
 */
export function findOwnSessionForHomework(db: Db, teacher: AssessmentTeacher, sessionId: string) {
  return db.session.findFirst({
    where: scopedWhere(teacher.centerId, {
      id: sessionId,
      teacherId: teacher.userId,
      classGroupId: { not: null },
      status: { not: "CANCELLED" as const },
      rescheduledToId: null,
    }),
    select: { ...sessionSummarySelect, classGroupId: true, classGroup: { select: classLabelSelect(teacher.centerId) } },
  });
}

// ── The default homework deadline (D-W03) ──────────────────────────────────

/** The timezone a session's times are typed and shown in: its frozen one, else the branch's. */
export function sessionZone(session: { timezone: string | null }, centreZone: string): string {
  return session.timezone ?? centreZone;
}

/**
 * D-W03 for one session: the class's next SCHEDULED, not-moved-away session
 * after this one starts, minus 30 minutes; with none, this session's end plus
 * 7 days. Each candidate's start is computed in its own frozen timezone.
 */
export async function homeworkDeadlineFor(
  db: Db,
  centerId: string,
  session: { id: string; classGroupId: string; date: Date; startTime: string; endTime: string; timezone: string | null },
  centreZone: string,
): Promise<{ deadline: Date; basis: HomeworkDeadlineBasis }> {
  const zone = sessionZone(session, centreZone);
  const start = sessionInstant(session, "start", zone);
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, {
      classGroupId: session.classGroupId,
      id: { not: session.id },
      date: { gte: session.date },
      status: "SCHEDULED" as const,
      rescheduledToId: null,
    }),
    select: { date: true, startTime: true, endTime: true, timezone: true, status: true, rescheduledToId: true },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: 8,
  });
  const next = pickNextSessionStart(
    rows.map((row) => ({
      status: row.status,
      rescheduledToId: row.rescheduledToId,
      start: sessionInstant(row, "start", sessionZone(row, centreZone)),
    })),
    start,
  );
  return defaultHomeworkDeadline({ sessionEnd: sessionInstant(session, "end", zone), nextSessionStart: next });
}

// ── Writes ─────────────────────────────────────────────────────────────────

export type AssessmentWriteError =
  | "forbidden"
  | "notFound"
  | "notDraft"
  | "locked"
  | "invalid"
  /** W3a: publish refused — "Ready to publish" is not all done. */
  | "notReady"
  /** W3a: publish refused — nobody could take it on an inactive class. */
  | "classInactive"
  /** W3a: an unpublish or extend on a row that is not published. */
  | "notPublished"
  /** W3a: extend refused — the window or deadline has already passed. */
  | "passed"
  /** W3a: extend refused — the new end is not later than the current one. */
  | "notLater";

export type AssessmentWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: AssessmentWriteError; errors?: DraftError[] };

/** The owning membership is still an ACTIVE TEACHER one at this branch — re-read in the write. */
export async function teacherStillActive(tx: Db, teacher: AssessmentTeacher): Promise<boolean> {
  const row = await tx.membership.findFirst({
    where: scopedWhere(teacher.centerId, { id: teacher.membershipId, userId: teacher.userId, role: "TEACHER" as const, active: true }),
    select: { id: true },
  });
  return row !== null;
}

/**
 * W7b (D-W18, D-W37): a write by someone other than the owning teacher is an
 * assistant's, and is allowed only while `assistantCan` grants
 * `assessments.manage` for this teacher at this branch — re-resolved here on
 * the write's own transaction (the link effective, the grant held, the
 * teacher's `assessment.manage.own` cell on, the branch allowing assistants).
 * The teacher's own writes pass unchanged.
 */
async function actorMayWrite(tx: Db, actor: AssessmentActor, teacher: AssessmentTeacher): Promise<boolean> {
  if (actor.userId === teacher.userId) return true;
  return assistantMayAt(tx, {
    assistantUserId: actor.userId,
    teacherUserId: teacher.userId,
    centerId: teacher.centerId,
    permission: "assessments.manage",
  });
}

function draftColumns(draft: AssessmentDraft) {
  return {
    title: draft.title.trim(),
    instructions: draft.instructions?.trim() ? draft.instructions.trim() : null,
    windowStart: draft.windowStart,
    windowEnd: draft.windowEnd,
    deadline: draft.deadline,
    durationMinutes: draft.durationMinutes,
    oneSitting: draft.oneSitting,
    shuffle: draft.shuffle,
    showScore: draft.showScore,
    showCorrectAnswers: draft.showCorrectAnswers,
  };
}

/**
 * The single writer of questions and options: replaces the whole set in the
 * caller's transaction (W2 drafts; nothing references a question id until W3
 * attempts, and those lock it first). Asks the lock helper before touching a row.
 */
async function replaceQuestions(
  tx: Prisma.TransactionClient,
  centerId: string,
  assessmentId: string,
  questions: AssessmentDraft["questions"],
): Promise<"locked" | null> {
  if (await isAssessmentLocked(tx, centerId, assessmentId)) return "locked";
  await tx.assessmentQuestion.deleteMany({ where: scopedWhere(centerId, { assessmentId }) });
  for (const [position, question] of questions.entries()) {
    await tx.assessmentQuestion.create({
      data: scopedData(centerId, {
        assessmentId,
        position,
        text: question.text.trim(),
        points: question.points,
        options: {
          create: question.options.map((option, optionPosition) => ({
            centerId,
            position: optionPosition,
            text: option.text.trim(),
            isCorrect: option.isCorrect,
          })),
        },
      }),
    });
  }
  return null;
}

export type CreateAssessmentInput =
  | { type: "EXAM"; classGroupId: string; sessionId?: string | null; draft: AssessmentDraft }
  | { type: "HOMEWORK"; sessionId: string; draft: AssessmentDraft };

/**
 * Creates a DRAFT. An exam: on the teacher's own active class (an optional
 * session must be one of that class's). A homework: on the teacher's own class
 * session; `classGroupId` comes from the session, never the form.
 */
export async function createAssessment(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  input: CreateAssessmentInput,
): Promise<AssessmentWriteResult> {
  const errors = draftErrors(input.type, input.draft);
  if (errors.length > 0) return { ok: false, error: "invalid", errors };
  const { centerId } = teacher;

  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;

    let classGroupId: string;
    let sessionId: string | null = null;
    if (input.type === "EXAM") {
      const classGroup = await findOwnClassForExam(tx, teacher, input.classGroupId);
      if (!classGroup) return { ok: false, error: "notFound" } as const;
      classGroupId = classGroup.id;
      if (input.sessionId) {
        const linked = await tx.session.findFirst({
          where: scopedWhere(centerId, { id: input.sessionId, classGroupId }),
          select: { id: true },
        });
        if (!linked) return { ok: false, error: "notFound" } as const;
        sessionId = linked.id;
      }
    } else {
      const session = await findOwnSessionForHomework(tx, teacher, input.sessionId);
      if (!session?.classGroupId) return { ok: false, error: "notFound" } as const;
      classGroupId = session.classGroupId;
      sessionId = session.id;
    }

    const created = await tx.assessment.create({
      data: scopedData(centerId, {
        classGroupId,
        sessionId,
        teacherMembershipId: teacher.membershipId,
        type: input.type,
        status: "DRAFT",
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
        ...draftColumns(input.draft),
      }),
      select: { id: true },
    });
    const refused = await replaceQuestions(tx, centerId, created.id, input.draft.questions);
    if (refused) throw new Error("A new assessment cannot be locked.");

    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.create",
      entityType: "Assessment",
      entityId: created.id,
      after: {
        type: input.type,
        status: "DRAFT",
        classGroupId,
        sessionId,
        teacherMembershipId: teacher.membershipId,
        questionCount: input.draft.questions.length,
      },
    });
    return { ok: true, id: created.id } as const;
  });
}

/** "Save draft": the details, timing, toggles and the whole question set, in one transaction. */
export async function saveAssessmentDraft(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
  draft: AssessmentDraft,
): Promise<AssessmentWriteResult> {
  const { centerId } = teacher;
  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;
    const current = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
      select: { id: true, type: true, status: true, _count: { select: { questions: true } } },
    });
    if (!current) return { ok: false, error: "notFound" } as const;
    if (current.status !== "DRAFT") return { ok: false, error: "notDraft" } as const;
    const errors = draftErrors(current.type, draft);
    if (errors.length > 0) return { ok: false, error: "invalid", errors } as const;
    if (await isAssessmentLocked(tx, centerId, assessmentId)) return { ok: false, error: "locked" } as const;

    // The UPDATE takes the row lock first, so two saves of one draft serialise.
    const updated = await tx.assessment.updateMany({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId, status: "DRAFT" as const }),
      data: { ...draftColumns(draft), updatedByUserId: actor.userId },
    });
    if (updated.count === 0) return { ok: false, error: "notFound" } as const;
    if (await replaceQuestions(tx, centerId, assessmentId, draft.questions)) {
      return { ok: false, error: "locked" } as const;
    }

    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.update",
      entityType: "Assessment",
      entityId: assessmentId,
      before: { questionCount: current._count.questions },
      after: {
        questionCount: draft.questions.length,
        durationMinutes: draft.durationMinutes,
        shuffle: draft.shuffle,
        showScore: draft.showScore,
        showCorrectAnswers: draft.showCorrectAnswers,
        oneSitting: draft.oneSitting,
      },
    });
    return { ok: true, id: assessmentId } as const;
  });
}

/** Locks the row, so a start cannot slip in between the check and the write (D-W08). */
async function lockAssessment(tx: Prisma.TransactionClient, centerId: string, assessmentId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id" = ${assessmentId} AND "centerId" = ${centerId} FOR UPDATE`;
}

/** Deletes a DRAFT, or a PUBLISHED row no student has started (questions and options cascade). Refused once locked (D-W08). */
export async function deleteAssessment(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
): Promise<AssessmentWriteResult> {
  const { centerId } = teacher;
  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;
    const current = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
      select: { id: true, type: true, status: true, classGroupId: true, sessionId: true, _count: { select: { questions: true } } },
    });
    if (!current) return { ok: false, error: "notFound" } as const;
    await lockAssessment(tx, centerId, assessmentId);
    if (await isAssessmentLocked(tx, centerId, assessmentId)) return { ok: false, error: "locked" } as const;

    // Its notices go with it, in this transaction (D-W32); an unpublish only hides them.
    await deleteAssessmentNotices(tx, centerId, assessmentId);
    const removed = await tx.assessment.deleteMany({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
    });
    if (removed.count === 0) return { ok: false, error: "notFound" } as const;
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.delete",
      entityType: "Assessment",
      entityId: assessmentId,
      before: {
        type: current.type,
        status: current.status,
        classGroupId: current.classGroupId,
        sessionId: current.sessionId,
        teacherMembershipId: teacher.membershipId,
        questionCount: current._count.questions,
      },
    });
    return { ok: true, id: assessmentId } as const;
  });
}

// ── Publishing (W3a, D-W01, D-W08, D-W31) ──────────────────────────────────

/**
 * DRAFT → PUBLISHED. Refused unless "Ready to publish" is all done (D-W30, with
 * the closing time in the future) and the class is active. Students can see and
 * start it from now on, and every student enrolled right now is told, in this
 * transaction (D-W32).
 */
export async function publishAssessment(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
  now: Date,
): Promise<AssessmentWriteResult> {
  const { centerId } = teacher;
  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;
    await lockAssessment(tx, centerId, assessmentId);
    const current = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
      include: {
        classGroup: { select: { active: true } },
        questions: { include: { options: true } },
      },
    });
    if (!current) return { ok: false, error: "notFound" } as const;
    if (current.status !== "DRAFT") return { ok: false, error: "notDraft" } as const;
    if (!current.classGroup.active) return { ok: false, error: "classInactive" } as const;
    if (!isReady(readiness(current.type, current, now)) || draftErrors(current.type, current).length > 0) {
      return { ok: false, error: "notReady" } as const;
    }
    await tx.assessment.updateMany({
      where: scopedWhere(centerId, { id: assessmentId, status: "DRAFT" as const }),
      data: { status: "PUBLISHED", publishedAt: now, updatedByUserId: actor.userId },
    });
    await notifyAssessmentPublished(tx, { id: assessmentId, centerId, classGroupId: current.classGroupId }, now);
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.publish",
      entityType: "Assessment",
      entityId: assessmentId,
      before: { status: "DRAFT" },
      after: {
        status: "PUBLISHED",
        type: current.type,
        classGroupId: current.classGroupId,
        sessionId: current.sessionId,
        teacherMembershipId: teacher.membershipId,
        questionCount: current.questions.length,
      },
    });
    return { ok: true, id: assessmentId } as const;
  });
}

/** PUBLISHED → DRAFT, only while no attempt exists. */
export async function unpublishAssessment(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
): Promise<AssessmentWriteResult> {
  const { centerId } = teacher;
  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;
    await lockAssessment(tx, centerId, assessmentId);
    const current = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
      select: { status: true },
    });
    if (!current) return { ok: false, error: "notFound" } as const;
    if (current.status !== "PUBLISHED") return { ok: false, error: "notPublished" } as const;
    if (await isAssessmentLocked(tx, centerId, assessmentId)) return { ok: false, error: "locked" } as const;
    await tx.assessment.updateMany({
      where: scopedWhere(centerId, { id: assessmentId, status: "PUBLISHED" as const }),
      data: { status: "DRAFT", publishedAt: null, updatedByUserId: actor.userId },
    });
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.unpublish",
      entityType: "Assessment",
      entityId: assessmentId,
      before: { status: "PUBLISHED" },
      after: { status: "DRAFT", teacherMembershipId: teacher.membershipId },
    });
    return { ok: true, id: assessmentId } as const;
  });
}

/**
 * Moves windowEnd or the deadline later — the only change allowed once attempts
 * exist (D-W08). Only forwards, and only before it has passed. It first finalises
 * every in-progress attempt already past its old end, in this transaction, so an
 * extension cannot revive one. The row lock makes a start or another extension wait.
 */
export async function extendAssessment(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
  newEnd: Date,
  now: Date,
): Promise<AssessmentWriteResult> {
  const { centerId } = teacher;
  return db.$transaction(async (tx) => {
    if (!(await teacherStillActive(tx, teacher))) return { ok: false, error: "forbidden" } as const;
    if (!(await actorMayWrite(tx, actor, teacher))) return { ok: false, error: "forbidden" } as const;
    await lockAssessment(tx, centerId, assessmentId);
    const current = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
      select: { status: true, type: true, classGroupId: true, windowEnd: true, deadline: true },
    });
    if (!current) return { ok: false, error: "notFound" } as const;
    if (current.status !== "PUBLISHED") return { ok: false, error: "notPublished" } as const;
    const oldEnd = assessmentClosesAt(current);
    if (!oldEnd || hasClosed(current, now)) return { ok: false, error: "passed" } as const;
    if (newEnd.getTime() <= oldEnd.getTime()) return { ok: false, error: "notLater" } as const;

    const finalisedAttempts = await finaliseDueAttempts(tx, centerId, assessmentId, now);
    const column = current.type === "EXAM" ? "windowEnd" : "deadline";
    await tx.assessment.updateMany({
      where: scopedWhere(centerId, { id: assessmentId }),
      data: { [column]: newEnd, updatedByUserId: actor.userId },
    });
    await notifyAssessmentExtended(tx, { id: assessmentId, centerId, classGroupId: current.classGroupId }, newEnd);
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.userId,
      onBehalfOfUserId: onBehalfOf(actor.userId, teacher.userId),
      action: "assessment.extend",
      entityType: "Assessment",
      entityId: assessmentId,
      before: { [column]: oldEnd.toISOString() },
      after: { [column]: newEnd.toISOString(), finalisedAttempts, teacherMembershipId: teacher.membershipId },
    });
    return { ok: true, id: assessmentId } as const;
  });
}

/** The per-type defaults a new draft starts from (the builder pre-fills them). */
export function newAssessmentSettings(type: AssessmentType) {
  return assessmentDefaults(type);
}
