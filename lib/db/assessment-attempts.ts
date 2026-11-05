import type { AssessmentFinalisedBy, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assessments` calls this module
// directly, outside Next (the lib/db/assessments.ts discipline).
import {
  STUDENT_ASSESSMENT_SELECT,
  assessmentClosesAt,
  attemptEnd,
  attemptOrder,
  finalisationDue,
  gradeAnswers,
  percentage,
  revealAllowed,
  startRefusal,
  studentAssessmentState,
  toStudentAssessment,
  totalPoints,
  type AssessmentTiming,
  type StudentAssessmentState,
  type StudentQuestion,
} from "../assessments.ts";
import { sessionLabelSelect } from "../session-label.ts";
import { writeAuditRow } from "./audit-row.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * A student's side of an exam or homework (W3a, D-W02, D-W05–D-W11, D-W31) —
 * every read and write that touches an attempt, per branch: each function takes
 * one `AssessmentStudent` (one branch's profile) and a student page or action
 * unions them across the person's profiles (U7, rule 1).
 *
 * **Correct answers never leave the server before reveal (rule 11).** Exactly two
 * places here read correctness: `finaliseAttemptTx`, to grade, and `revealOf`,
 * behind `revealAllowed`. Every other read uses `STUDENT_ASSESSMENT_SELECT` /
 * `toStudentAssessment` and selects `AssessmentAnswer.questionId` and `.optionId`
 * only. `check:assessments` asserts it by direct call and statically.
 *
 * **Time is the server's (D-W09).** Every function takes `now`, the attempt's end
 * is derived from `startedAt`, and nothing the client sends moves it.
 *
 * **Lazy finalisation (D-W10).** `finaliseIfDue` is called by every read and write
 * that touches an attempt. No job, timer route or polling exists.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

/** One branch's student: the profile that owns the attempt, and who is acting. */
export type AssessmentStudent = { centerId: string; studentProfileId: string; userId: string };

function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ("$transaction" in db) return (db as PrismaClient).$transaction(fn, WRITE_TRANSACTION_OPTIONS);
  return fn(db);
}

/**
 * The student at this branch, or null: an ACTIVE profile of this person, re-read
 * here rather than trusted. Staff and parents have none, so they get nothing.
 */
export async function resolveAssessmentStudent(db: Db, centerId: string, userId: string): Promise<AssessmentStudent | null> {
  const profile = await db.studentProfile.findFirst({
    where: scopedWhere(centerId, { userId, active: true }),
    select: { id: true },
  });
  return profile ? { centerId, studentProfileId: profile.id, userId } : null;
}

const TIMING_SELECT = {
  type: true,
  windowStart: true,
  windowEnd: true,
  deadline: true,
  durationMinutes: true,
  oneSitting: true,
} as const;

/** The list's groups, in reading order (docs/04 §11.34). */
export const STUDENT_STATE_ORDER: readonly StudentAssessmentState[] = ["IN_PROGRESS", "OPEN", "UPCOMING", "SUBMITTED", "MISSED", "CLOSED"];

/** Semantic colours (rule 8): upcoming blue, in progress amber, submitted green, missed red. */
export const STUDENT_STATE_BADGE = {
  UPCOMING: "info",
  OPEN: "brand",
  IN_PROGRESS: "warning",
  SUBMITTED: "success",
  MISSED: "danger",
  CLOSED: "neutral",
} as const satisfies Record<StudentAssessmentState, "info" | "brand" | "warning" | "success" | "danger" | "neutral">;

export { ONE_SITTING_HEARTBEAT_SECONDS } from "../assessments.ts";

// ── Finalisation (D-W09, D-W10) ────────────────────────────────────────────

/**
 * Finalises one attempt in the caller's transaction. The conditional update is
 * the claim: it takes the row lock, so a saved answer committed before it is
 * graded and one arriving after it finds the attempt final; a second finaliser
 * matches nothing. Grading reads the saved answers after the claim, and score,
 * maxScore, isCorrect and pointsAwarded freeze in the same transaction — nobody
 * can read a final attempt without its score. Returns false if already final.
 */
async function finaliseAttemptTx(
  tx: Tx,
  centerId: string,
  attemptId: string,
  decision: { finalisedBy: AssessmentFinalisedBy; submittedAt: Date },
  actorUserId: string | null,
): Promise<boolean> {
  const claimed = await tx.assessmentAttempt.updateMany({
    where: scopedWhere(centerId, { id: attemptId, submittedAt: null }),
    data: { submittedAt: decision.submittedAt, finalisedBy: decision.finalisedBy },
  });
  if (claimed.count === 0) return false;

  const attempt = await tx.assessmentAttempt.findFirstOrThrow({
    where: scopedWhere(centerId, { id: attemptId }),
    select: { assessmentId: true, studentProfileId: true },
  });
  const questions = await tx.assessmentQuestion.findMany({
    where: scopedWhere(centerId, { assessmentId: attempt.assessmentId }),
    select: { id: true, points: true, options: { select: { id: true, isCorrect: true } } },
  });
  const saved = await tx.assessmentAnswer.findMany({
    where: scopedWhere(centerId, { attemptId }),
    select: { questionId: true, optionId: true },
  });
  const graded = gradeAnswers(questions, saved);

  // An unanswered question gets its row too, so the frozen record is complete.
  const savedIds = new Set(saved.map((answer) => answer.questionId));
  const missing = graded.answers.filter((answer) => !savedIds.has(answer.questionId));
  if (missing.length > 0) {
    await tx.assessmentAnswer.createMany({
      data: missing.map((answer) =>
        scopedData(centerId, { attemptId, questionId: answer.questionId, optionId: null, isCorrect: false, pointsAwarded: 0 }),
      ),
      skipDuplicates: true,
    });
  }
  // One write per distinct outcome: every wrong answer, then each points value.
  const wrong = graded.answers.filter((answer) => !answer.isCorrect).map((answer) => answer.questionId);
  if (wrong.length > 0) {
    await tx.assessmentAnswer.updateMany({
      where: scopedWhere(centerId, { attemptId, questionId: { in: wrong } }),
      data: { isCorrect: false, pointsAwarded: 0 },
    });
  }
  const rightByPoints = new Map<number, string[]>();
  for (const answer of graded.answers) {
    if (!answer.isCorrect) continue;
    rightByPoints.set(answer.pointsAwarded, [...(rightByPoints.get(answer.pointsAwarded) ?? []), answer.questionId]);
  }
  for (const [pointsAwarded, ids] of rightByPoints) {
    await tx.assessmentAnswer.updateMany({
      where: scopedWhere(centerId, { attemptId, questionId: { in: ids } }),
      data: { isCorrect: true, pointsAwarded },
    });
  }
  await tx.assessmentAttempt.updateMany({
    where: scopedWhere(centerId, { id: attemptId }),
    data: { score: graded.score, maxScore: graded.maxScore },
  });

  // A deadline or gap finalisation may be triggered by anyone's read, so it has
  // no actor: the attempt's finalisedBy is the record of how it ended.
  await writeAuditRow(tx, {
    centerId,
    actorUserId,
    action: "attempt.submit",
    entityType: "AssessmentAttempt",
    entityId: attemptId,
    after: {
      assessmentId: attempt.assessmentId,
      studentProfileId: attempt.studentProfileId,
      finalisedBy: decision.finalisedBy,
      score: graded.score,
      maxScore: graded.maxScore,
    },
  });
  return true;
}

/** Locks the attempt and reads it, so a decision cannot race a heartbeat or an autosave. */
async function lockAttempt(tx: Tx, centerId: string, attemptId: string) {
  await tx.$queryRaw`SELECT "id" FROM "AssessmentAttempt" WHERE "id" = ${attemptId} AND "centerId" = ${centerId} FOR UPDATE`;
  return tx.assessmentAttempt.findFirst({
    where: scopedWhere(centerId, { id: attemptId }),
    select: {
      id: true,
      assessmentId: true,
      studentProfileId: true,
      startedAt: true,
      lastSeenAt: true,
      submittedAt: true,
      assessment: { select: { ...TIMING_SELECT, classGroup: { select: { active: true } } } },
    },
  });
}

/**
 * D-W10: the one lazy finaliser. If the attempt is past its end or was left, it
 * is finalised and graded with what was saved; otherwise nothing changes.
 * Idempotent and race-safe, so any reader may call it: true = this call
 * finalised it. Writes no actor (see `finaliseAttemptTx`).
 */
export async function finaliseIfDue(db: Db, centerId: string, attemptId: string, now: Date): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const attempt = await lockAttempt(tx, centerId, attemptId);
    if (!attempt || attempt.submittedAt) return false;
    const due = finalisationDue(attempt.assessment, attempt, now);
    return due ? finaliseAttemptTx(tx, centerId, attemptId, due, null) : false;
  });
}

/** Every attempt on one assessment that is due, in the caller's transaction. */
export async function finaliseDueAttempts(tx: Tx, centerId: string, assessmentId: string, now: Date): Promise<number> {
  const open = await tx.assessmentAttempt.findMany({
    where: scopedWhere(centerId, { assessmentId, submittedAt: null }),
    select: { id: true },
  });
  let finalised = 0;
  for (const attempt of open) {
    if (await finaliseIfDue(tx, centerId, attempt.id, now)) finalised += 1;
  }
  return finalised;
}

/**
 * One student request on one attempt: finalise it if it is due, otherwise record
 * that the student is still there. Null when the attempt is not this student's;
 * `final` when it can no longer be written to.
 */
async function studentTouch(tx: Tx, student: AssessmentStudent, attemptId: string, now: Date) {
  const attempt = await lockAttempt(tx, student.centerId, attemptId);
  if (!attempt || attempt.studentProfileId !== student.studentProfileId) return null;
  if (attempt.submittedAt) return { attempt, final: true };
  const due = finalisationDue(attempt.assessment, attempt, now);
  if (due) {
    await finaliseAttemptTx(tx, student.centerId, attemptId, due, null);
    return { attempt, final: true };
  }
  await tx.assessmentAttempt.updateMany({
    where: scopedWhere(student.centerId, { id: attemptId, submittedAt: null }),
    data: { lastSeenAt: now },
  });
  return { attempt, final: false };
}

// ── Eligibility and start (D-W07) ──────────────────────────────────────────

export type StartAttemptResult =
  | { ok: true; attemptId: string; resumed: boolean }
  | { ok: false; error: "notFound" | "notEligible" | "notOpenYet" | "closed" | "submitted" };

/**
 * Starts this student's one attempt, or resumes it. Eligibility is checked here
 * and only here: published, the class active, and an ACTIVE enrolment now.
 * `FOR SHARE` holds the row against an unpublish or delete mid-start, and the
 * unique index with `ON CONFLICT DO NOTHING` makes two tabs or a double tap one
 * row. Audited `attempt.start` once, by whichever call created it.
 */
export async function startAttempt(db: Db, student: AssessmentStudent, assessmentId: string, now: Date): Promise<StartAttemptResult> {
  const { centerId, studentProfileId } = student;
  return inTransaction(db, async (tx): Promise<StartAttemptResult> => {
    await tx.$queryRaw`SELECT "id" FROM "Assessment" WHERE "id" = ${assessmentId} AND "centerId" = ${centerId} FOR SHARE`;
    const assessment = await tx.assessment.findFirst({
      where: scopedWhere(centerId, { id: assessmentId, status: "PUBLISHED" as const, classGroup: { active: true } }),
      select: { id: true, classGroupId: true, ...TIMING_SELECT },
    });
    if (!assessment) return { ok: false, error: "notFound" };

    const existing = await tx.assessmentAttempt.findFirst({
      where: scopedWhere(centerId, { assessmentId, studentProfileId }),
      select: { id: true },
    });
    if (existing) {
      const touched = await studentTouch(tx, student, existing.id, now);
      if (!touched || touched.final) return { ok: false, error: "submitted" };
      return { ok: true, attemptId: existing.id, resumed: true };
    }

    const enrolled = await tx.enrollment.findFirst({
      where: scopedWhere(centerId, { studentProfileId, classGroupId: assessment.classGroupId, status: "ACTIVE" as const }),
      select: { id: true },
    });
    if (!enrolled) return { ok: false, error: "notEligible" };
    const refusal = startRefusal(assessment, now);
    if (refusal) return { ok: false, error: refusal };

    const created = await tx.assessmentAttempt.createMany({
      data: [scopedData(centerId, { assessmentId, studentProfileId, startedAt: now, lastSeenAt: now })],
      skipDuplicates: true,
    });
    const row = await tx.assessmentAttempt.findFirstOrThrow({
      where: scopedWhere(centerId, { assessmentId, studentProfileId }),
      select: { id: true },
    });
    if (created.count === 0) return { ok: true, attemptId: row.id, resumed: true };
    await writeAuditRow(tx, {
      centerId,
      actorUserId: student.userId,
      action: "attempt.start",
      entityType: "AssessmentAttempt",
      entityId: row.id,
      after: { assessmentId, studentProfileId },
    });
    return { ok: true, attemptId: row.id, resumed: false };
  });
}

// ── Autosave, heartbeat, submit ────────────────────────────────────────────

export type SaveAnswerResult = { ok: true } | { ok: false; error: "notFound" | "submitted" | "invalidOption" };

/**
 * Saves one answer (D-W09). The option must belong to that question and the
 * question to this attempt's assessment; null clears it. Refused with
 * "submitted" once the attempt is final or due — and if due, finalised. The
 * result says nothing about correctness: `isCorrect` is set only at finalisation.
 */
export async function saveAnswer(
  db: Db,
  student: AssessmentStudent,
  attemptId: string,
  input: { questionId: string; optionId: string | null },
  now: Date,
): Promise<SaveAnswerResult> {
  const { centerId } = student;
  return inTransaction(db, async (tx): Promise<SaveAnswerResult> => {
    const touched = await studentTouch(tx, student, attemptId, now);
    if (!touched) return { ok: false, error: "notFound" };
    if (touched.final) return { ok: false, error: "submitted" };
    if (!touched.attempt.assessment.classGroup.active) return { ok: false, error: "notFound" };

    const question = await tx.assessmentQuestion.findFirst({
      where: scopedWhere(centerId, { id: input.questionId, assessmentId: touched.attempt.assessmentId }),
      select: { id: true },
    });
    if (!question) return { ok: false, error: "invalidOption" };
    if (input.optionId !== null) {
      const option = await tx.assessmentOption.findFirst({
        where: scopedWhere(centerId, { id: input.optionId, questionId: question.id }),
        select: { id: true },
      });
      if (!option) return { ok: false, error: "invalidOption" };
    }
    await tx.assessmentAnswer.upsert({
      where: { attemptId_questionId: { attemptId, questionId: question.id } },
      create: scopedData(centerId, { attemptId, questionId: question.id, optionId: input.optionId }),
      update: { optionId: input.optionId },
    });
    return { ok: true };
  });
}

export type AttemptClock = { endsAtMs: number; serverNowMs: number };
export type HeartbeatResult = ({ ok: true } & AttemptClock) | { ok: false; error: "notFound" | "submitted" };

/** "Still here": refreshes `lastSeenAt` (or finds the attempt over) and answers the server's clock. */
export async function attemptHeartbeat(db: Db, student: AssessmentStudent, attemptId: string, now: Date): Promise<HeartbeatResult> {
  return inTransaction(db, async (tx): Promise<HeartbeatResult> => {
    const touched = await studentTouch(tx, student, attemptId, now);
    if (!touched) return { ok: false, error: "notFound" };
    if (touched.final) return { ok: false, error: "submitted" };
    return {
      ok: true,
      endsAtMs: attemptEnd(touched.attempt.assessment, touched.attempt.startedAt).getTime(),
      serverNowMs: now.getTime(),
    };
  });
}

export type SubmitAttemptResult =
  | { ok: true; finalisedBy: AssessmentFinalisedBy }
  | { ok: false; error: "notFound" | "notOneSitting" };

/**
 * The student's submit, and the best-effort submit on page close
 * (`onlyOneSitting`: a default exam or homework simply stays open for re-entry).
 * An attempt already over is not rewritten, and a submit after the end finalises
 * it at its end, as DEADLINE or ONE_SITTING_GAP, so a late submit gains nothing.
 * Idempotent.
 */
export async function submitAttempt(
  db: Db,
  student: AssessmentStudent,
  attemptId: string,
  now: Date,
  options: { onlyOneSitting?: boolean } = {},
): Promise<SubmitAttemptResult> {
  const { centerId } = student;
  return inTransaction(db, async (tx): Promise<SubmitAttemptResult> => {
    const attempt = await lockAttempt(tx, centerId, attemptId);
    if (!attempt || attempt.studentProfileId !== student.studentProfileId) return { ok: false, error: "notFound" };
    if (options.onlyOneSitting && !attempt.assessment.oneSitting) return { ok: false, error: "notOneSitting" };
    if (!attempt.submittedAt) {
      const due = finalisationDue(attempt.assessment, attempt, now);
      if (due) await finaliseAttemptTx(tx, centerId, attemptId, due, null);
      else await finaliseAttemptTx(tx, centerId, attemptId, { finalisedBy: "STUDENT", submittedAt: now }, student.userId);
    }
    const final = await tx.assessmentAttempt.findFirstOrThrow({
      where: scopedWhere(centerId, { id: attemptId }),
      select: { finalisedBy: true },
    });
    return { ok: true, finalisedBy: final.finalisedBy! };
  });
}

// ── The student's list (per branch; the page unions them) ──────────────────

const classLabelSelect = (centerId: string) => {
  const catalog = sessionLabelSelect(centerId).classGroup.select.subject;
  return { subject: catalog, grade: catalog } as const;
};

type ClassLabel = Prisma.ClassGroupGetPayload<{ select: ReturnType<typeof classLabelSelect> }>;

/** What a student can see of the row: published, the class active, and enrolled or already started. */
function visibleTo(student: AssessmentStudent, extra: Prisma.AssessmentWhereInput) {
  const { studentProfileId } = student;
  return scopedWhere(student.centerId, {
    ...extra,
    status: "PUBLISHED" as const,
    classGroup: { active: true },
    OR: [
      { classGroup: { enrollments: { some: { studentProfileId, status: "ACTIVE" as const } } } },
      { attempts: { some: { studentProfileId } } },
    ],
  });
}

export type StudentScore = { score: number; maxScore: number; percentage: number };

export type StudentAssessmentListItem = {
  id: string;
  type: AssessmentTiming["type"];
  title: string;
  state: StudentAssessmentState;
  classGroup: ClassLabel;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  /** The session's frozen timezone; null = the branch's (an exam with no session). */
  timeZone: string | null;
  /** Null unless the attempt is final and the teacher left showScore on. */
  score: StudentScore | null;
};

function shownScore(
  showScore: boolean,
  attempt: { submittedAt: Date | null; score: number | null; maxScore: number | null } | null,
): StudentScore | null {
  if (!showScore || !attempt?.submittedAt || attempt.score === null || attempt.maxScore === null) return null;
  return { score: attempt.score, maxScore: attempt.maxScore, percentage: percentage(attempt.score, attempt.maxScore) };
}

/** One branch's assessments for this student. Finalises what is due first (D-W10). */
export async function listStudentAssessments(db: Db, student: AssessmentStudent, now: Date): Promise<StudentAssessmentListItem[]> {
  const { centerId, studentProfileId } = student;
  const open = await db.assessmentAttempt.findMany({
    where: scopedWhere(centerId, { studentProfileId, submittedAt: null }),
    select: { id: true },
  });
  for (const attempt of open) await finaliseIfDue(db, centerId, attempt.id, now);

  const rows = await db.assessment.findMany({
    where: visibleTo(student, {}),
    select: {
      id: true,
      title: true,
      showScore: true,
      ...TIMING_SELECT,
      session: { select: { timezone: true } },
      classGroup: {
        select: {
          ...classLabelSelect(centerId),
          enrollments: { where: { studentProfileId, status: "ACTIVE" as const }, select: { enrolledAt: true } },
        },
      },
      attempts: { where: { studentProfileId }, select: { submittedAt: true, score: true, maxScore: true } },
    },
    orderBy: [{ windowEnd: "asc" }, { deadline: "asc" }],
  });

  const items: StudentAssessmentListItem[] = [];
  for (const row of rows) {
    const attempt = row.attempts[0] ?? null;
    const closes = assessmentClosesAt(row);
    const enrolledAt = row.classGroup.enrollments[0]?.enrolledAt;
    // Joining a class later does not make its past exams "missed".
    if (!attempt && closes && enrolledAt && enrolledAt.getTime() > closes.getTime()) continue;
    items.push({
      id: row.id,
      type: row.type,
      title: row.title,
      state: studentAssessmentState(row, attempt, now),
      classGroup: { subject: row.classGroup.subject, grade: row.classGroup.grade },
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      deadline: row.deadline,
      timeZone: row.session?.timezone ?? null,
      score: shownScore(row.showScore, attempt),
    });
  }
  return items;
}

// ── One assessment: the page's read ────────────────────────────────────────

export type StudentTaking = {
  attemptId: string;
  questions: StudentQuestion[];
  /** questionId → the saved option id. Never whether it is right. */
  answers: Record<string, string | null>;
  clock: AttemptClock;
};

export type StudentAssessmentView = {
  id: string;
  type: AssessmentTiming["type"];
  title: string;
  instructions: string | null;
  classGroup: ClassLabel;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  durationMinutes: number | null;
  oneSitting: boolean;
  questionCount: number;
  totalPoints: number;
  timeZone: string | null;
  state: StudentAssessmentState;
  /** Open, no attempt yet, and an ACTIVE enrolment now. */
  canStart: boolean;
  /** Set only while in progress. The questions are sent to nobody before that. */
  taking: StudentTaking | null;
  /** Set only once final. */
  finished: {
    attemptId: string;
    finalisedBy: AssessmentFinalisedBy;
    submittedAt: Date;
    score: StudentScore | null;
    showCorrectAnswers: boolean;
  } | null;
};

/**
 * The assessment page's read. Touches the attempt first (finalise, or "still
 * here"), then shapes the answer through the student serializer. Null when this
 * student cannot see it, which the page turns into a 404.
 */
export async function readStudentAssessment(
  db: Db,
  student: AssessmentStudent,
  assessmentId: string,
  now: Date,
): Promise<StudentAssessmentView | null> {
  const { centerId, studentProfileId } = student;
  const row = await db.assessment.findFirst({
    where: visibleTo(student, { id: assessmentId }),
    select: {
      ...STUDENT_ASSESSMENT_SELECT,
      showScore: true,
      showCorrectAnswers: true,
      session: { select: { timezone: true } },
      classGroup: {
        select: {
          ...classLabelSelect(centerId),
          enrollments: { where: { studentProfileId, status: "ACTIVE" as const }, select: { id: true } },
        },
      },
    },
  });
  if (!row) return null;

  const found = await db.assessmentAttempt.findFirst({
    where: scopedWhere(centerId, { assessmentId, studentProfileId }),
    select: { id: true, submittedAt: true },
  });
  if (found && !found.submittedAt) await inTransaction(db, (tx) => studentTouch(tx, student, found.id, now));
  const attempt = found
    ? await db.assessmentAttempt.findFirstOrThrow({
        where: scopedWhere(centerId, { id: found.id }),
        select: { id: true, startedAt: true, submittedAt: true, finalisedBy: true, score: true, maxScore: true },
      })
    : null;

  const state = studentAssessmentState(row, attempt, now);
  let taking: StudentTaking | null = null;
  if (attempt && !attempt.submittedAt) {
    const saved = await db.assessmentAnswer.findMany({
      where: scopedWhere(centerId, { attemptId: attempt.id }),
      select: { questionId: true, optionId: true },
    });
    taking = {
      attemptId: attempt.id,
      questions: toStudentAssessment(row, row.shuffle ? attemptOrder(attempt.id, row) : undefined).questions,
      answers: Object.fromEntries(saved.map((answer) => [answer.questionId, answer.optionId])),
      clock: { endsAtMs: attemptEnd(row, attempt.startedAt).getTime(), serverNowMs: now.getTime() },
    };
  }

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    instructions: row.instructions,
    classGroup: { subject: row.classGroup.subject, grade: row.classGroup.grade },
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    deadline: row.deadline,
    durationMinutes: row.durationMinutes,
    oneSitting: row.oneSitting,
    questionCount: row.questions.length,
    totalPoints: totalPoints(row.questions),
    timeZone: row.session?.timezone ?? null,
    state,
    canStart: !attempt && state === "OPEN" && row.classGroup.enrollments.length > 0,
    taking,
    finished:
      attempt?.submittedAt && attempt.finalisedBy
        ? {
            attemptId: attempt.id,
            finalisedBy: attempt.finalisedBy,
            submittedAt: attempt.submittedAt,
            score: shownScore(row.showScore, attempt),
            showCorrectAnswers: row.showCorrectAnswers,
          }
        : null,
  };
}

// ── The reveal (D-W06, rule 11) ────────────────────────────────────────────

export type RevealedQuestion = {
  id: string;
  text: string;
  points: number;
  pointsAwarded: number;
  chosenOptionId: string | null;
  correctOptionId: string | null;
  isCorrect: boolean;
  options: { id: string; text: string }[];
};

/**
 * The only student read that carries correctness, and only when `revealAllowed`
 * says so: the attempt is final, the assessment has closed, and
 * showCorrectAnswers is on. Otherwise null, with nothing selected.
 */
export async function readAttemptReveal(
  db: Db,
  student: AssessmentStudent,
  attemptId: string,
  now: Date,
): Promise<RevealedQuestion[] | null> {
  const { centerId, studentProfileId } = student;
  await finaliseIfDue(db, centerId, attemptId, now);
  const attempt = await db.assessmentAttempt.findFirst({
    where: scopedWhere(centerId, { id: attemptId, studentProfileId, assessment: { classGroup: { active: true } } }),
    select: {
      id: true,
      submittedAt: true,
      assessment: { select: { id: true, type: true, windowEnd: true, deadline: true, showCorrectAnswers: true, shuffle: true } },
    },
  });
  if (!attempt || !revealAllowed(attempt.assessment, attempt, now)) return null;
  return revealOf(db, centerId, attempt.id, attempt.assessment.id, attempt.assessment.shuffle);
}

/** Reads correctness. Called only behind `revealAllowed`. */
async function revealOf(db: Db, centerId: string, attemptId: string, assessmentId: string, shuffle: boolean): Promise<RevealedQuestion[]> {
  const [questions, answers] = await Promise.all([
    db.assessmentQuestion.findMany({
      where: scopedWhere(centerId, { assessmentId }),
      orderBy: { position: "asc" },
      select: {
        id: true,
        position: true,
        text: true,
        points: true,
        options: { orderBy: { position: "asc" }, select: { id: true, position: true, text: true, isCorrect: true } },
      },
    }),
    db.assessmentAnswer.findMany({
      where: scopedWhere(centerId, { attemptId }),
      select: { questionId: true, optionId: true, isCorrect: true, pointsAwarded: true },
    }),
  ]);
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const correctByQuestion = new Map(
    questions.map((question) => [question.id, question.options.find((option) => option.isCorrect)?.id ?? null]),
  );
  const order = shuffle ? attemptOrder(attemptId, { questions }) : undefined;
  const shaped = toStudentAssessment(
    {
      id: assessmentId,
      type: "EXAM",
      title: "",
      instructions: null,
      windowStart: null,
      windowEnd: null,
      deadline: null,
      durationMinutes: null,
      oneSitting: false,
      questions,
    },
    order,
  );
  return shaped.questions.map((question) => {
    const answer = byQuestion.get(question.id);
    return {
      id: question.id,
      text: question.text,
      points: question.points,
      pointsAwarded: answer?.pointsAwarded ?? 0,
      chosenOptionId: answer?.optionId ?? null,
      correctOptionId: correctByQuestion.get(question.id) ?? null,
      isCorrect: answer?.isCorrect ?? false,
      options: question.options,
    };
  });
}
