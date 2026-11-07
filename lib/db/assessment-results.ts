import type { AssessmentFinalisedBy, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assessments` calls this module
// directly, outside Next (the lib/db/assessments.ts discipline).
import {
  analyseQuestions,
  answerOutcome,
  buildResultRows,
  outsideTeacherHistory,
  summariseResults,
  type AnalysisQuestion,
  type AnswerOutcome,
  type ResultRow,
  type ResultSummary,
} from "../assessment-results.ts";
import { attemptEnd, finalisationDue, hasClosed, percentage, totalPoints, type AssessmentTiming } from "../assessments.ts";
import { can } from "../auth/permissions.ts";
import { fullName, localName } from "../identity.ts";
import { centreTimeZone } from "../scheduling.ts";
import { finaliseIfDue } from "./assessment-attempts.ts";
import { assistantMayAt } from "./assistant-acting.ts";
import { classLabelSelect, sessionZone, teacherStillActive, type AssessmentActor, type AssessmentTeacher } from "./assessments.ts";
import { loadPermissionGrants } from "./permissions.ts";
import { teacherPortalHistoryFloor } from "./teacher-portal.ts";
import { assistantReadFloor } from "./visibility.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The teacher's results (W4, D-W11, D-W33), one branch at a time: a page in All
 * branches runs a read per branch and takes the one that finds the row (U7, rule
 * 1), so the branch comes from the assessment, never from a posted centre id.
 *
 * **This is a separate path from the student's (rule 11).** It reads correctness
 * freely, because only the owning teacher reaches it: `lib/db/assessment-attempts.ts`
 * and its serializer are not used for any read here. No centre, student, parent or
 * admin file imports this module (`check:assessments`, statically).
 *
 * **Authority, re-read on every call.** The actor and the owning teacher are
 * separate parameters. The actor is the teacher, or (W7b, D-W37) an assistant
 * for whom `assistantCan` grants `assessments.review` (Manage covers it) for this
 * teacher at this branch, re-resolved here. The membership must still be an
 * ACTIVE TEACHER one, and the branch must still grant `assessment.manage.own`. A
 * forged or stale `AssessmentTeacher` gets `forbidden`, whoever passes it.
 *
 * **The window.** The teacher reads within their own `teacherHistoryDays`; an
 * assistant within the stricter of that and the branch's teacher window
 * (`teacherDataVisibilityDays`, D-W19) — both re-read here, never passed in.
 *
 * **Every read finalises what is due first (D-W10)**, so a student who ran out of
 * time with nothing reading their attempt still shows as Submitted.
 */

export type ResultsRefusal = "forbidden" | "notFound" | "draft";

const NAME_SELECT = { firstName: true, lastName: true, user: { select: { firstName: true, lastName: true } } } as const;

function studentName(row: { firstName: string | null; lastName: string | null; user: { firstName: string; lastName: string } }): string {
  return fullName(localName(row, row.user));
}

async function holdsResultsAuthority(db: PrismaClient, actor: AssessmentActor, teacher: AssessmentTeacher): Promise<boolean> {
  // W7b: anyone but the teacher must be their assistant with review rights here.
  if (
    actor.userId !== teacher.userId &&
    !(await assistantMayAt(db, {
      assistantUserId: actor.userId,
      teacherUserId: teacher.userId,
      centerId: teacher.centerId,
      permission: "assessments.review",
    }))
  ) {
    return false;
  }
  if (!(await teacherStillActive(db, teacher))) return false;
  const grants = await loadPermissionGrants(db, teacher.centerId, "TEACHER");
  return can("TEACHER", "assessment.manage.own", grants);
}

/** The owner's PUBLISHED row inside their history window, or why not. */
async function ownedPublished(db: PrismaClient, actor: AssessmentActor, teacher: AssessmentTeacher, assessmentId: string, now: Date) {
  if (!(await holdsResultsAuthority(db, actor, teacher))) return { ok: false, error: "forbidden" } as const;
  const { centerId } = teacher;
  const row = await db.assessment.findFirst({
    where: scopedWhere(centerId, { id: assessmentId, teacherMembershipId: teacher.membershipId }),
    select: {
      id: true,
      type: true,
      status: true,
      title: true,
      windowStart: true,
      windowEnd: true,
      deadline: true,
      durationMinutes: true,
      oneSitting: true,
      classGroupId: true,
      classGroup: { select: classLabelSelect(centerId) },
      session: { select: { date: true, startTime: true, endTime: true, timezone: true } },
    },
  });
  if (!row) return { ok: false, error: "notFound" } as const;
  if (row.status !== "PUBLISHED") return { ok: false, error: "draft" } as const;

  const [user, settings] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: teacher.userId }, select: { teacherHistoryDays: true } }),
    db.centerSettings.findFirst({
      where: scopedWhere(centerId, {}),
      select: { timezone: true, centerDataVisibilityDays: true, teacherDataVisibilityDays: true },
    }),
  ]);
  const zone = row.session ? sessionZone(row.session, centreTimeZone(settings)) : centreTimeZone(settings);
  const floor =
    actor.userId === teacher.userId
      ? teacherPortalHistoryFloor({ user, settings }, now)
      : assistantReadFloor({ settings, teacherHistoryDays: user.teacherHistoryDays }, now);
  if (outsideTeacherHistory(row, zone, floor)) {
    return { ok: false, error: "notFound" } as const;
  }
  return { ok: true, row, zone } as const;
}

/** D-W10: the one lazy finaliser, for each open attempt already over. */
async function finaliseDue(db: PrismaClient, centerId: string, assessmentId: string, timing: AssessmentTiming, now: Date) {
  const open = await db.assessmentAttempt.findMany({
    where: scopedWhere(centerId, { assessmentId, submittedAt: null }),
    select: { id: true, startedAt: true, lastSeenAt: true },
  });
  for (const attempt of open) {
    if (finalisationDue(timing, attempt, now)) await finaliseIfDue(db, centerId, attempt.id, now);
  }
}

/** ACTIVE enrolments of active students: a deactivated profile cannot start (D-W31). */
function activeEnrolmentWhere(centerId: string, classGroupIds: readonly string[]) {
  return scopedWhere(centerId, {
    classGroupId: { in: [...classGroupIds] },
    status: "ACTIVE" as const,
    studentProfile: { active: true },
  });
}

// ── The results page ───────────────────────────────────────────────────────

export type AssessmentResults = {
  id: string;
  type: AssessmentTiming["type"];
  title: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  deadline: Date | null;
  durationMinutes: number | null;
  oneSitting: boolean;
  /** The session's frozen timezone, else the branch's. */
  zone: string;
  closed: boolean;
  classGroup: Prisma.ClassGroupGetPayload<{ select: ReturnType<typeof classLabelSelect> }>;
  questionCount: number;
  totalPoints: number;
  summary: ResultSummary;
  students: ResultRow[];
  questions: AnalysisQuestion[];
};

export type ResultsRead = { ok: true; results: AssessmentResults } | { ok: false; error: ResultsRefusal };

export async function readAssessmentResults(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
  now: Date,
): Promise<ResultsRead> {
  const owned = await ownedPublished(db, actor, teacher, assessmentId, now);
  if (!owned.ok) return owned;
  const { row, zone } = owned;
  const { centerId } = teacher;
  await finaliseDue(db, centerId, assessmentId, row, now);

  const [enrolments, attempts, questions, groups] = await Promise.all([
    db.enrollment.findMany({
      where: activeEnrolmentWhere(centerId, [row.classGroupId]),
      select: { studentProfileId: true, enrolledAt: true, studentProfile: { select: NAME_SELECT } },
    }),
    db.assessmentAttempt.findMany({
      where: scopedWhere(centerId, { assessmentId }),
      select: {
        id: true,
        studentProfileId: true,
        startedAt: true,
        submittedAt: true,
        finalisedBy: true,
        score: true,
        maxScore: true,
        studentProfile: { select: NAME_SELECT },
      },
    }),
    db.assessmentQuestion.findMany({
      where: scopedWhere(centerId, { assessmentId }),
      orderBy: { position: "asc" },
      select: {
        id: true,
        text: true,
        points: true,
        options: { orderBy: { position: "asc" }, select: { id: true, text: true, isCorrect: true } },
      },
    }),
    db.assessmentAnswer.groupBy({
      by: ["questionId", "optionId", "isCorrect"],
      where: scopedWhere(centerId, { attempt: { assessmentId, submittedAt: { not: null } } }),
      _count: { _all: true },
    }),
  ]);

  const students = buildResultRows(
    row,
    enrolments.map((enrolment) => ({
      studentProfileId: enrolment.studentProfileId,
      name: studentName(enrolment.studentProfile),
      enrolledAt: enrolment.enrolledAt,
    })),
    attempts.map((attempt) => ({ ...attempt, name: studentName(attempt.studentProfile) })),
    now,
  );
  const summary = summariseResults(students);

  return {
    ok: true,
    results: {
      id: row.id,
      type: row.type,
      title: row.title,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      deadline: row.deadline,
      durationMinutes: row.durationMinutes,
      oneSitting: row.oneSitting,
      zone,
      closed: hasClosed(row, now),
      classGroup: row.classGroup,
      questionCount: questions.length,
      totalPoints: totalPoints(questions),
      summary,
      students,
      questions: analyseQuestions(
        questions,
        groups.map((group) => ({ questionId: group.questionId, optionId: group.optionId, isCorrect: group.isCorrect, count: group._count._all })),
        summary.submitted,
      ),
    },
  };
}

// ── One student's answers ──────────────────────────────────────────────────

export type ResultAnswer = {
  id: string;
  text: string;
  points: number;
  pointsAwarded: number;
  chosenOptionId: string | null;
  correctOptionId: string | null;
  outcome: AnswerOutcome;
  options: { id: string; text: string }[];
};

export type AttemptResult = {
  attemptId: string;
  assessmentId: string;
  title: string;
  zone: string;
  studentName: string;
  left: boolean;
  startedAt: Date;
  submittedAt: Date | null;
  finalisedBy: AssessmentFinalisedBy | null;
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
  timeTakenMs: number | null;
  /** Set only while in progress. */
  timeLeftMs: number | null;
  /** Null while in progress: nothing a student has picked shows before it is final. */
  answers: ResultAnswer[] | null;
};

export type AttemptResultRead = { ok: true; attempt: AttemptResult } | { ok: false; error: ResultsRefusal };

/** Each question in the assessment's order, not the attempt's shuffled one (D-W33). */
export async function readAttemptResult(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentId: string,
  attemptId: string,
  now: Date,
): Promise<AttemptResultRead> {
  const owned = await ownedPublished(db, actor, teacher, assessmentId, now);
  if (!owned.ok) return owned;
  const { row, zone } = owned;
  const { centerId } = teacher;

  // Only on this assessment's own attempt, so an id from elsewhere finalises nothing.
  const found = await db.assessmentAttempt.findFirst({
    where: scopedWhere(centerId, { id: attemptId, assessmentId }),
    select: { id: true },
  });
  if (!found) return { ok: false, error: "notFound" };
  await finaliseIfDue(db, centerId, attemptId, now);

  const attempt = await db.assessmentAttempt.findFirstOrThrow({
    where: scopedWhere(centerId, { id: attemptId, assessmentId }),
    select: {
      id: true,
      studentProfileId: true,
      startedAt: true,
      submittedAt: true,
      finalisedBy: true,
      score: true,
      maxScore: true,
      studentProfile: { select: NAME_SELECT },
    },
  });
  const enrolled = await db.enrollment.findFirst({
    where: {
      ...activeEnrolmentWhere(centerId, [row.classGroupId]),
      studentProfileId: attempt.studentProfileId,
    },
    select: { id: true },
  });

  const base = {
    attemptId: attempt.id,
    assessmentId,
    title: row.title,
    zone,
    studentName: studentName(attempt.studentProfile),
    left: enrolled === null,
    startedAt: attempt.startedAt,
  };

  if (!attempt.submittedAt) {
    return {
      ok: true,
      attempt: {
        ...base,
        submittedAt: null,
        finalisedBy: null,
        score: null,
        maxScore: null,
        percentage: null,
        timeTakenMs: null,
        timeLeftMs: Math.max(0, attemptEnd(row, attempt.startedAt).getTime() - now.getTime()),
        answers: null,
      },
    };
  }

  const [questions, answers] = await Promise.all([
    db.assessmentQuestion.findMany({
      where: scopedWhere(centerId, { assessmentId }),
      orderBy: { position: "asc" },
      select: {
        id: true,
        text: true,
        points: true,
        options: { orderBy: { position: "asc" }, select: { id: true, text: true, isCorrect: true } },
      },
    }),
    db.assessmentAnswer.findMany({
      where: scopedWhere(centerId, { attemptId }),
      select: { questionId: true, optionId: true, isCorrect: true, pointsAwarded: true },
    }),
  ]);
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const { score, maxScore } = attempt;

  return {
    ok: true,
    attempt: {
      ...base,
      submittedAt: attempt.submittedAt,
      finalisedBy: attempt.finalisedBy,
      score,
      maxScore,
      percentage: score !== null && maxScore !== null ? percentage(score, maxScore) : null,
      timeTakenMs: Math.max(0, attempt.submittedAt.getTime() - attempt.startedAt.getTime()),
      timeLeftMs: null,
      answers: questions.map((question) => {
        const answer = byQuestion.get(question.id);
        return {
          id: question.id,
          text: question.text,
          points: question.points,
          pointsAwarded: answer?.pointsAwarded ?? 0,
          chosenOptionId: answer?.optionId ?? null,
          correctOptionId: question.options.find((option) => option.isCorrect)?.id ?? null,
          outcome: answerOutcome(answer),
          options: question.options.map((option) => ({ id: option.id, text: option.text })),
        };
      }),
    },
  };
}

// ── "submitted / eligible" on a list ───────────────────────────────────────

export type ResultProgress = { submitted: number; eligible: number };

/**
 * The teacher's lists: for the ids given, re-reads the owner's published rows,
 * finalises what is due, then counts through `buildResultRows`, so a list can never
 * disagree with the page. Empty when the actor holds no authority here.
 */
export async function assessmentResultProgress(
  db: PrismaClient,
  actor: AssessmentActor,
  teacher: AssessmentTeacher,
  assessmentIds: readonly string[],
  now: Date,
): Promise<Map<string, ResultProgress>> {
  const progress = new Map<string, ResultProgress>();
  if (assessmentIds.length === 0 || !(await holdsResultsAuthority(db, actor, teacher))) return progress;
  const { centerId } = teacher;

  const published = await db.assessment.findMany({
    where: scopedWhere(centerId, {
      id: { in: [...assessmentIds] },
      teacherMembershipId: teacher.membershipId,
      status: "PUBLISHED" as const,
    }),
    select: { id: true, type: true, windowStart: true, windowEnd: true, deadline: true, durationMinutes: true, oneSitting: true, classGroupId: true },
  });
  if (published.length === 0) return progress;

  const [attempts, enrolments] = await Promise.all([
    db.assessmentAttempt.findMany({
      where: scopedWhere(centerId, { assessmentId: { in: published.map((row) => row.id) } }),
      select: { id: true, assessmentId: true, studentProfileId: true, startedAt: true, lastSeenAt: true, submittedAt: true, finalisedBy: true },
    }),
    db.enrollment.findMany({
      where: activeEnrolmentWhere(centerId, [...new Set(published.map((row) => row.classGroupId))]),
      select: { classGroupId: true, studentProfileId: true, enrolledAt: true },
    }),
  ]);

  for (const row of published) {
    const shaped = [];
    for (const attempt of attempts.filter((item) => item.assessmentId === row.id)) {
      const due = attempt.submittedAt ? null : finalisationDue(row, attempt, now);
      if (due) await finaliseIfDue(db, centerId, attempt.id, now);
      shaped.push({
        id: attempt.id,
        studentProfileId: attempt.studentProfileId,
        name: "",
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt ?? due?.submittedAt ?? null,
        finalisedBy: attempt.finalisedBy ?? due?.finalisedBy ?? null,
        score: null,
        maxScore: null,
      });
    }
    const roster = enrolments
      .filter((enrolment) => enrolment.classGroupId === row.classGroupId)
      .map((enrolment) => ({ studentProfileId: enrolment.studentProfileId, name: "", enrolledAt: enrolment.enrolledAt }));
    const summary = summariseResults(buildResultRows(row, roster, shaped, now));
    progress.set(row.id, { submitted: summary.submitted, eligible: summary.eligible });
  }
  return progress;
}
