import { PrismaClient } from "@prisma/client";
import type { Locator, Page } from "@playwright/test";

import { E2E_ASSESSMENT_PREFIX, removeE2eAssessments } from "../scripts/lib/e2e-assessments";
import { uniqueTag, type AccountKey } from "./support/accounts";
import { DAY, HOUR, MINUTE, findRosterClass, insertAttempt, insertExam } from "./support/assessment-fixtures";
import { expect, expectHealthy, test } from "./support/fixtures";
import type { AppLocale } from "./support/i18n";

/**
 * W4 (D-W11, D-W33): the teacher's results. A closed exam with a correct, a wrong and
 * a deadline-finalised attempt, and students who never started it; an open exam with
 * an attempt in progress. Inserted straight into the database (staging-guarded) under
 * the shared prefix + the test's own tag, and removed by the same teardown, so a
 * second run leaves the same row counts.
 */

/** Rows render as a table and as cards, one hidden by CSS. */
const visible = (locator: Locator) => locator.locator("visible=true");

function digits(locale: AppLocale, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-arab" : "en-US").format(value);
}

async function withFixtures<T>(run: (db: PrismaClient, tag: string) => Promise<T>): Promise<T> {
  const tag = uniqueTag("").toLowerCase();
  const db = new PrismaClient();
  try {
    return await run(db, tag);
  } finally {
    try {
      await removeE2eAssessments(db, tag);
      const left = await db.assessment.count({ where: { title: { startsWith: `${E2E_ASSESSMENT_PREFIX}${tag}` } } });
      expect(left, "the teardown removed everything under this tag").toBe(0);
    } finally {
      await db.$disconnect();
    }
  }
}

async function expectFits(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);
}

const OTHER_TEACHER: Record<string, AccountKey> = { teacherDowntown: "teacherShared", teacherShared: "teacherDowntown" };

test("@write the owning teacher reads an exam's results: counts, percentages, times and each student's answers", async ({ as, appLocale, msg }) => {
  await withFixtures(async (db, tag) => {
    const fx = await findRosterClass(db, 4);
    const [rightStudent, wrongStudent, deadlineStudent] = fx.roster;
    const r = (key: string, values?: Record<string, string | number>) => msg(`TeacherAssessments.results.${key}`, values);
    const n = (value: number) => digits(appLocale, value);

    const exam = await insertExam(db, fx, {
      suffix: "results",
      tag,
      startsInMs: -6 * HOUR,
      endsInMs: -HOUR,
      durationMinutes: 30,
    });
    await insertAttempt(db, fx, exam, { studentProfileId: rightStudent.studentProfileId, picks: [0, 0], startedMsAgo: 5 * HOUR, submittedMsAgo: 5 * HOUR - 10 * MINUTE });
    const wrongAttempt = await insertAttempt(db, fx, exam, { studentProfileId: wrongStudent.studentProfileId, picks: [1, 2], startedMsAgo: 5 * HOUR, submittedMsAgo: 5 * HOUR - 20 * MINUTE });
    // Past its 30 minutes, and nothing has read it: the results read finalises it.
    const deadlineAttempt = await insertAttempt(db, fx, exam, { studentProfileId: deadlineStudent.studentProfileId, picks: [0, null], startedMsAgo: 4 * HOUR });

    const eligible = fx.roster.filter((student) => student.enrolledAt.getTime() <= exam.windowEnd.getTime()).length;
    const missed = eligible - 3;

    // ── The list: "submitted / eligible" and the Results action ────────────
    const page = await as(fx.teacher);
    await page.goto(`/${appLocale}/teacher/assessments`);
    await expectHealthy(page, appLocale);
    const listRow = page.locator("main ul > li", { hasText: exam.title });
    await expect(listRow.locator("[data-result-progress]")).toHaveText(msg("TeacherAssessments.results.progress", { submitted: n(3), eligible: n(eligible) }));
    await listRow.getByRole("link", { name: r("action"), exact: true }).click();
    await page.waitForURL(new RegExp(`/teacher/assessments/${exam.id}/results`));
    await expectHealthy(page, appLocale);
    await expectFits(page);

    // ── The summary ────────────────────────────────────────────────────────
    const summary = page.locator("[data-results-summary]");
    const tile = (label: string) => summary.locator("div", { has: page.getByText(label, { exact: true }) }).last().locator("xpath=..");
    const expectTile = async (key: string, value: string) => {
      await expect(tile(r(`summary.${key}`)), key).toContainText(value);
    };
    await expectTile("eligible", n(eligible));
    await expectTile("started", n(3));
    await expectTile("submitted", n(3));
    await expectTile("inProgress", n(0));
    await expectTile("notStarted", n(0));
    await expectTile("missed", n(missed));
    // 100, 0 and 50 percent: submitted attempts only.
    await expectTile("average", r("percent", { value: n(50) }));
    await expectTile("highest", r("percent", { value: n(100) }));
    await expectTile("lowest", r("percent", { value: n(0) }));

    // ── The students ───────────────────────────────────────────────────────
    const row = (profileId: string) => visible(page.locator(`[data-result-row="${profileId}"]`));
    const right = row(rightStudent.studentProfileId);
    await expect(right).toContainText(r("status.SUBMITTED"));
    await expect(right).toContainText(r("score", { score: n(2), max: n(2) }));
    await expect(right).toContainText(r("percent", { value: n(100) }));
    await expect(right).toContainText(r("duration.minutes", { minutes: n(10), seconds: n(0) }));
    await expect(right).toContainText(r("ended.STUDENT"));

    const wrong = row(wrongStudent.studentProfileId);
    await expect(wrong).toContainText(r("score", { score: n(0), max: n(2) }));
    await expect(wrong).toContainText(r("percent", { value: n(0) }));

    const deadline = row(deadlineStudent.studentProfileId);
    await expect(deadline, "lazily finalised by this read").toContainText(r("status.SUBMITTED"));
    await expect(deadline).toContainText(r("score", { score: n(1), max: n(2) }));
    await expect(deadline, "capped at the 30-minute timer").toContainText(r("duration.minutes", { minutes: n(30), seconds: n(0) }));
    await expect(deadline).toContainText(r("ended.DEADLINE"));

    const stored = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: deadlineAttempt } });
    expect(stored.score, "the page's numbers are the frozen ones").toBe(1);
    expect(stored.maxScore).toBe(2);
    expect(stored.finalisedBy).toBe("DEADLINE");

    for (const student of fx.roster.slice(3)) {
      await expect(row(student.studentProfileId)).toContainText(r("status.MISSED"));
    }

    // A filter narrows the list and leaves the summary alone.
    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}/results?status=SUBMITTED`);
    await expectHealthy(page, appLocale);
    await expect(visible(page.locator("[data-result-row]"))).toHaveCount(3);
    await expectTile("missed", n(missed));
    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}/results?status=MISSED`);
    await expect(visible(page.locator("[data-result-row]"))).toHaveCount(missed);

    // ── Per question: over the three submitted attempts ────────────────────
    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}/results`);
    await expectHealthy(page, appLocale);
    const first = page.locator('[data-analysis-question="1"]');
    await expect(first).toContainText(r("analysis.correctLine", { percent: n(67), correct: n(2), submitted: n(3) }));
    await expect(first).toContainText(exam.questions[0].text);
    await expect(page.locator('[data-analysis-question="2"]')).toContainText(r("analysis.correctLine", { percent: n(33), correct: n(1), submitted: n(3) }));

    // ── One student's answers, with text badges ────────────────────────────
    const open = row(wrongStudent.studentProfileId).getByRole("link", { name: r("viewAnswers"), exact: true });
    const box = await open.boundingBox();
    expect(box?.height ?? 0, "a 44px target").toBeGreaterThanOrEqual(44);
    await open.click();
    await page.waitForURL(new RegExp(`/results/${wrongAttempt}`));
    await expectHealthy(page, appLocale);
    await expectFits(page);
    const question = page.locator('[data-answer-question="1"]');
    await expect(question.getByText(r("answers.outcome.INCORRECT"), { exact: true })).toBeVisible();
    await expect(question.getByText(r("answers.chosen"), { exact: true })).toBeVisible();
    await expect(question.getByText(r("answers.correct"), { exact: true })).toBeVisible();
    await expect(question.locator("li", { hasText: exam.questions[0].options[0] }).getByText(r("answers.correct"), { exact: true })).toBeVisible();
    await expect(question.locator("li", { hasText: exam.questions[0].options[1] }).getByText(r("answers.chosen"), { exact: true })).toBeVisible();

    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}/results/${deadlineAttempt}`);
    await expectHealthy(page, appLocale);
    await expect(page.locator('[data-answer-question="1"]').getByText(r("answers.outcome.CORRECT"), { exact: true })).toBeVisible();
    await expect(page.locator('[data-answer-question="2"]').getByText(r("answers.outcome.UNANSWERED"), { exact: true })).toBeVisible();

    // ── Refused: another teacher, a student, the manager ───────────────────
    const hidden = [exam.title, exam.questions[0].text, exam.questions[0].options[0]];
    const expectRefused = async (account: AccountKey, lands: "same" | "centers") => {
      const other = await as(account);
      for (const path of [`/teacher/assessments/${exam.id}/results`, `/teacher/assessments/${exam.id}/results/${wrongAttempt}`]) {
        await other.goto(`/${appLocale}${path}`);
        const destination = lands === "same" ? `/${appLocale}${path}` : `/${appLocale}/teacher/centers`;
        await other.waitForURL((current) => current.pathname === destination);
        await other.waitForLoadState("domcontentloaded");
        await expect(other.locator("[data-results-summary], [data-answer-question]")).toHaveCount(0);
        const html = await other.content();
        for (const text of hidden) expect(html, `${account} on ${path} must not see "${text}"`).not.toContain(text);
        expect(html, `${account} on ${path} must not get correctness`).not.toContain("isCorrect");
      }
    };
    await expectRefused(OTHER_TEACHER[fx.teacher], "same");
    await expectRefused("studentDowntown", "centers");
    await expectRefused("manager", "centers");
  });
});

test("@write an in-progress attempt shows as In progress, with time left and no answers", async ({ as, appLocale, msg }) => {
  await withFixtures(async (db, tag) => {
    const fx = await findRosterClass(db, 2);
    const [workingStudent, idleStudent] = fx.roster;
    const r = (key: string, values?: Record<string, string | number>) => msg(`TeacherAssessments.results.${key}`, values);

    const exam = await insertExam(db, fx, { suffix: "progress", tag, startsInMs: -HOUR, endsInMs: DAY, durationMinutes: 600 });
    const attempt = await insertAttempt(db, fx, exam, { studentProfileId: workingStudent.studentProfileId, picks: [0, null], startedMsAgo: 5 * MINUTE });

    const page = await as(fx.teacher);
    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}/results`);
    await expectHealthy(page, appLocale);
    await expectFits(page);
    await expect(page.getByText(r("noSubmissions"), { exact: true }).first()).toBeVisible();

    const working = visible(page.locator(`[data-result-row="${workingStudent.studentProfileId}"]`));
    await expect(working).toContainText(r("status.IN_PROGRESS"));
    await expect(working).toContainText(msg("TeacherAssessments.results.timeLeft", { time: "" }).trim());
    await expect(working.getByRole("link", { name: r("viewAnswers"), exact: true })).toHaveCount(0);
    await expect(visible(page.locator(`[data-result-row="${idleStudent.studentProfileId}"]`))).toContainText(r("status.NOT_STARTED"));

    await working.getByRole("link", { name: r("viewProgress"), exact: true }).click();
    await page.waitForURL(new RegExp(`/results/${attempt}`));
    await expectHealthy(page, appLocale);
    await expect(page.getByText(r("status.IN_PROGRESS"), { exact: true })).toBeVisible();
    await expect(page.getByText(r("answers.timeLeft"), { exact: true })).toBeVisible();
    await expect(page.getByText(r("answers.inProgressHint"), { exact: true })).toBeVisible();
    await expect(page.locator("[data-answer-question]")).toHaveCount(0);
    const html = await page.content();
    for (const text of [exam.questions[0].text, exam.questions[0].options[0]]) {
      expect(html, "nothing of the questions while it is in progress").not.toContain(text);
    }
    expect(html).not.toContain("isCorrect");

    // The row is still open and unscored: reading it changed nothing.
    const stored = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt } });
    expect(stored.submittedAt).toBeNull();
    expect(stored.score).toBeNull();
  });
});
