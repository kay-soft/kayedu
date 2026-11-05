import { PrismaClient } from "@prisma/client";

import { E2E_ASSESSMENT_PREFIX } from "../../scripts/lib/e2e-assessments";
import { assertSafeToWrite } from "../../scripts/lib/env";

import { ACCOUNTS, type AccountKey } from "./accounts";

/**
 * Exams the e2e suite inserts straight into the database, for the cases a browser
 * flow cannot reach (a window that has already closed, an attempt that is already
 * final). Staging-guarded like the teardown (S1); every title starts with
 * `E2E_ASSESSMENT_PREFIX` + the test's tag, so `removeE2eAssessments(db, tag)`
 * removes the attempts, answers and questions with it - a second run leaves the
 * same row counts.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type FixtureClass = {
  centerId: string;
  classGroupId: string;
  studentProfileId: string;
  teacherMembershipId: string;
  teacherUserId: string;
  teacher: AccountKey;
};

/** The class the seeded student is enrolled in, taught by a seeded teacher. */
export async function findFixtureClass(db: PrismaClient): Promise<FixtureClass> {
  const teacherKeys: AccountKey[] = ["teacherDowntown", "teacherShared"];
  for (const teacher of teacherKeys) {
    const row = await db.enrollment.findFirst({
      where: {
        status: "ACTIVE",
        studentProfile: { user: { email: ACCOUNTS.studentDowntown.email } },
        classGroup: { active: true, teacher: { email: ACCOUNTS[teacher].email } },
      },
      select: { classGroupId: true, centerId: true, studentProfileId: true, classGroup: { select: { teacherId: true } } },
    });
    if (!row) continue;
    const membership = await db.membership.findFirst({
      where: { centerId: row.centerId, userId: row.classGroup.teacherId, role: "TEACHER" },
      select: { id: true, userId: true },
    });
    if (!membership) continue;
    return {
      centerId: row.centerId,
      classGroupId: row.classGroupId,
      studentProfileId: row.studentProfileId,
      teacherMembershipId: membership.id,
      teacherUserId: membership.userId,
      teacher,
    };
  }
  throw new Error("e2e: the seeded student has no active class with a seeded teacher");
}

export type ExamFixture = {
  /** Appended to the shared prefix + the test's tag. */
  suffix: string;
  tag: string;
  /** Window relative to now, in ms. */
  startsInMs?: number;
  endsInMs: number;
  oneSitting?: boolean;
  durationMinutes?: number | null;
  showScore?: boolean;
  showCorrectAnswers?: boolean;
  /** Insert a final attempt: question 1 answered right, question 2 wrong. */
  finalAttempt?: boolean;
};

export type InsertedExam = {
  id: string;
  title: string;
  questions: { text: string; options: string[]; correct: number }[];
  attemptId: string | null;
};

/** Two questions, four options each; the correct option is the first. */
function questionsFor(title: string) {
  return [1, 2].map((n) => ({
    text: `${title} question ${n}`,
    options: ["A", "B", "C", "D"].map((letter) => `${title} q${n} option ${letter}`),
    correct: 0,
  }));
}

export async function insertExam(db: PrismaClient, fx: FixtureClass, spec: ExamFixture): Promise<InsertedExam> {
  assertSafeToWrite("the e2e assessment fixtures");
  const title = `${E2E_ASSESSMENT_PREFIX}${spec.tag}-${spec.suffix}`;
  const now = Date.now();
  const questions = questionsFor(title);
  const exam = await db.assessment.create({
    data: {
      centerId: fx.centerId,
      classGroupId: fx.classGroupId,
      teacherMembershipId: fx.teacherMembershipId,
      type: "EXAM",
      status: "PUBLISHED",
      title,
      windowStart: new Date(now + (spec.startsInMs ?? -2 * HOUR)),
      windowEnd: new Date(now + spec.endsInMs),
      durationMinutes: spec.durationMinutes ?? null,
      oneSitting: spec.oneSitting ?? false,
      showScore: spec.showScore ?? false,
      showCorrectAnswers: spec.showCorrectAnswers ?? false,
      createdByUserId: fx.teacherUserId,
      updatedByUserId: fx.teacherUserId,
      publishedAt: new Date(now - 3 * HOUR),
      questions: {
        create: questions.map((question, index) => ({
          centerId: fx.centerId,
          position: index + 1,
          text: question.text,
          points: 1,
          options: {
            create: question.options.map((text, position) => ({
              centerId: fx.centerId,
              position: position + 1,
              text,
              isCorrect: position === question.correct,
            })),
          },
        })),
      },
    },
    select: {
      id: true,
      questions: { orderBy: { position: "asc" }, select: { id: true, options: { orderBy: { position: "asc" }, select: { id: true } } } },
    },
  });

  let attemptId: string | null = null;
  if (spec.finalAttempt) {
    const startedAt = new Date(now - 90 * MINUTE);
    const submittedAt = new Date(now - 60 * MINUTE);
    const attempt = await db.assessmentAttempt.create({
      data: {
        centerId: fx.centerId,
        assessmentId: exam.id,
        studentProfileId: fx.studentProfileId,
        startedAt,
        lastSeenAt: submittedAt,
        submittedAt,
        finalisedBy: "STUDENT",
        score: 1,
        maxScore: 2,
        answers: {
          create: exam.questions.map((question, index) => ({
            centerId: fx.centerId,
            questionId: question.id,
            // Question 1: the correct (first) option. Question 2: a wrong one (the second).
            optionId: question.options[index === 0 ? 0 : 1].id,
            isCorrect: index === 0,
            pointsAwarded: index === 0 ? 1 : 0,
          })),
        },
      },
      select: { id: true },
    });
    attemptId = attempt.id;
  }
  return { id: exam.id, title, questions, attemptId };
}

export { DAY, HOUR, MINUTE };
