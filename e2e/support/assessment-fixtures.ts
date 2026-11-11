import { PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";

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
  endsInMs?: number;
  /** An exact closing instant; wins over `endsInMs`. */
  endsAt?: Date;
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
  /** The same questions by database id, in order, with their options in order. */
  rows: { id: string; options: { id: string }[] }[];
  attemptId: string | null;
  windowEnd: Date;
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
  // Minute-aligned: the time pickers have minute precision, so a fixture on a whole
  // minute survives a round trip through them unchanged.
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
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
      windowEnd: spec.endsAt ?? new Date(now + (spec.endsInMs ?? DAY)),
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
      windowEnd: true,
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
  return { id: exam.id, title, questions, rows: exam.questions, attemptId, windowEnd: exam.windowEnd! };
}

export type RosterClass = FixtureClass & { roster: { studentProfileId: string; firstName: string | null; enrolledAt: Date }[] };

/** A seeded teacher's active class with at least `size` active students (W4). */
export async function findRosterClass(db: PrismaClient, size: number): Promise<RosterClass> {
  const teacherKeys: AccountKey[] = ["teacherDowntown", "teacherShared"];
  for (const teacher of teacherKeys) {
    const classes = await db.classGroup.findMany({
      where: { active: true, teacher: { email: ACCOUNTS[teacher].email } },
      select: {
        id: true,
        centerId: true,
        teacherId: true,
        enrollments: {
          where: { status: "ACTIVE", studentProfile: { active: true } },
          select: { studentProfileId: true, enrolledAt: true, studentProfile: { select: { firstName: true } } },
          orderBy: { enrolledAt: "asc" },
        },
      },
      orderBy: { id: "asc" },
    });
    for (const row of classes) {
      if (row.enrollments.length < size) continue;
      const membership = await db.membership.findFirst({
        where: { centerId: row.centerId, userId: row.teacherId, role: "TEACHER", active: true },
        select: { id: true, userId: true },
      });
      if (!membership) continue;
      return {
        centerId: row.centerId,
        classGroupId: row.id,
        studentProfileId: row.enrollments[0].studentProfileId,
        teacherMembershipId: membership.id,
        teacherUserId: membership.userId,
        teacher,
        roster: row.enrollments.map((enrolment) => ({
          studentProfileId: enrolment.studentProfileId,
          firstName: enrolment.studentProfile.firstName,
          enrolledAt: enrolment.enrolledAt,
        })),
      };
    }
  }
  throw new Error(`e2e: no seeded teacher has an active class with ${size} active students`);
}

export type AttemptFixture = {
  studentProfileId: string;
  /** Per question, the index of the option picked; null leaves it unanswered. */
  picks: (number | null)[];
  startedMsAgo: number;
  /** Set for a final attempt, graded here; omit it to leave the attempt open. */
  submittedMsAgo?: number;
};

/**
 * One attempt on an inserted exam (W4). A final one is written graded, the way
 * finalisation leaves it. An open one holds saved answers only (`isCorrect` null), so
 * a read past its end has to finalise it (D-W10). Removed with its exam.
 */
export async function insertAttempt(db: PrismaClient, fx: FixtureClass, exam: InsertedExam, spec: AttemptFixture): Promise<string> {
  assertSafeToWrite("the e2e assessment fixtures");
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  const final = spec.submittedMsAgo !== undefined;
  const right = exam.rows.filter((row, index) => spec.picks[index] === exam.questions[index].correct).length;
  const submittedAt = final ? new Date(now - spec.submittedMsAgo!) : null;
  const attempt = await db.assessmentAttempt.create({
    data: {
      centerId: fx.centerId,
      assessmentId: exam.id,
      studentProfileId: spec.studentProfileId,
      startedAt: new Date(now - spec.startedMsAgo),
      lastSeenAt: submittedAt ?? new Date(now - spec.startedMsAgo),
      submittedAt,
      finalisedBy: final ? "STUDENT" : null,
      score: final ? right : null,
      maxScore: final ? exam.rows.length : null,
      answers: {
        create: exam.rows.flatMap((row, index) => {
          const pick = spec.picks[index];
          if (pick === null && !final) return [];
          const isRight = pick === exam.questions[index].correct;
          return [
            {
              centerId: fx.centerId,
              questionId: row.id,
              optionId: pick === null ? null : row.options[pick].id,
              isCorrect: final ? isRight : null,
              pointsAwarded: final ? (isRight ? 1 : 0) : null,
            },
          ];
        }),
      },
    },
    select: { id: true },
  });
  return attempt.id;
}

export { DAY, HOUR, MINUTE };

/**
 * W9: fills the builder's questions through the UI — each "Add question", its
 * text, four options and the first one marked correct — the steps the W3a
 * journey takes, shared by the workspace journeys (`workspaces.spec.ts`,
 * `assessments.spec.ts`). The builder must already be open.
 */
export async function fillBuilderQuestions(
  page: Page,
  msg: (key: string) => string,
  texts: string[],
): Promise<void> {
  for (const [questionIndex, text] of texts.entries()) {
    await page.getByRole("button", { name: msg("TeacherAssessments.builder.addQuestion"), exact: true }).click();
    const card = page.locator("main ol > li").nth(questionIndex);
    await card.getByLabel(msg("TeacherAssessments.builder.questionText"), { exact: true }).fill(text);
    // By position: the option labels carry an ICU number format `msg` does not apply.
    const options = card.locator("fieldset input:not([type=radio])");
    await expect(options).toHaveCount(4);
    for (let option = 0; option < 4; option += 1) await options.nth(option).fill(`Option ${option + 1}`);
    await card.getByRole("radio").first().check();
  }
}
