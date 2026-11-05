import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";

import { E2E_ASSESSMENT_PREFIX, removeE2eAssessments } from "../scripts/lib/e2e-assessments";
import { ACCOUNTS, uniqueTag, type AccountKey } from "./support/accounts";
import { DAY, HOUR, findFixtureClass, insertExam } from "./support/assessment-fixtures";
import { expect, expectHealthy, test } from "./support/fixtures";
import type { AppLocale } from "./support/i18n";
import { dayFromToday, openDialog, pickDate } from "./support/ui";

/**
 * W3a: a teacher builds and publishes an exam through the UI, an enrolled student
 * takes it, refreshes, resumes and submits. Throughout, neither the page nor any
 * response the student receives contains `isCorrect` (rule 11, D-W09). The exam's
 * title carries the shared e2e prefix; the test removes what its tag created,
 * pass or fail, so a second run leaves the same row counts.
 */

const LEAK = "isCorrect";

/** Every document and data response this page receives, not the JS bundles. */
function watchResponses(page: Page, bodies: string[]) {
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (type !== "document" && type !== "fetch" && type !== "xhr") return;
    void response.text().then(
      (text) => bodies.push(text),
      () => undefined,
    );
  });
}

/** Closes the student rating pop-up if it opened: it is modal, and closing persists nothing (M17). */
async function closeRatingPopup(page: Page, title: string, close: string) {
  const popup = page.getByRole("dialog", { name: title });
  await popup.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
  if (await popup.isVisible().catch(() => false)) {
    await popup.getByRole("button", { name: close, exact: true }).click();
    await expect(popup).toBeHidden();
  }
}

/** A class the seeded student is enrolled in, whose teacher is a seeded account. */
async function findClass(): Promise<{ classGroupId: string; centerId: string; teacher: AccountKey }> {
  const db = new PrismaClient();
  try {
    const teacherKeys: AccountKey[] = ["teacherDowntown", "teacherShared"];
    for (const teacher of teacherKeys) {
      const row = await db.enrollment.findFirst({
        where: {
          status: "ACTIVE",
          studentProfile: { user: { email: ACCOUNTS.studentDowntown.email } },
          classGroup: { active: true, teacher: { email: ACCOUNTS[teacher].email } },
        },
        select: { classGroupId: true, centerId: true },
      });
      if (row) return { ...row, teacher };
    }
    throw new Error("e2e: the seeded student has no active class with a seeded teacher");
  } finally {
    await db.$disconnect();
  }
}

test("@write a teacher publishes an exam, a student takes it, and no correct answer reaches the student", async ({ as, appLocale, msg }) => {
  const tag = uniqueTag("").toLowerCase();
  const title = `${E2E_ASSESSMENT_PREFIX}${tag}`;
  const { classGroupId, centerId, teacher } = await findClass();

  try {
    // ── The teacher: build, save, publish ──────────────────────────────────
    const teacherPage = await as(teacher);
    await teacherPage.goto(`/${appLocale}/teacher/assessments/new?type=EXAM&branch=${encodeURIComponent(centerId)}&class=${encodeURIComponent(classGroupId)}`);
    await expectHealthy(teacherPage, appLocale);
    await teacherPage.locator("#assessment-title").fill(title);

    const windowField = (name: string) => teacherPage.locator("fieldset", { has: teacherPage.locator(`#${name}-date`) });
    await pickDate(windowField("windowStart"), appLocale, msg("TeacherAssessments.builder.date"), dayFromToday(0));
    await teacherPage.locator("#windowStart-time").fill("00:00");
    await teacherPage.locator("#windowStart-time").press("Tab");
    await pickDate(windowField("windowEnd"), appLocale, msg("TeacherAssessments.builder.date"), dayFromToday(2));
    await teacherPage.locator("#windowEnd-time").fill("23:00");
    await teacherPage.locator("#windowEnd-time").press("Tab");

    for (const [questionIndex, text] of ["First question", "Second question"].entries()) {
      await teacherPage.getByRole("button", { name: msg("TeacherAssessments.builder.addQuestion"), exact: true }).click();
      const card = teacherPage.locator("main ol > li").nth(questionIndex);
      await card.getByLabel(msg("TeacherAssessments.builder.questionText"), { exact: true }).fill(text);
      // By position: the option labels carry an ICU number format `msg` does not apply.
      const options = card.locator("fieldset input:not([type=radio])");
      await expect(options).toHaveCount(4);
      for (let option = 0; option < 4; option += 1) await options.nth(option).fill(`Option ${option + 1}`);
      await card.getByRole("radio").first().check();
    }
    await teacherPage.getByRole("button", { name: msg("TeacherAssessments.builder.save"), exact: true }).click();
    await teacherPage.waitForURL(/\/teacher\/assessments\/[0-9a-f-]{36}/);
    const assessmentId = /assessments\/([0-9a-f-]{36})/.exec(teacherPage.url())![1];

    const publish = teacherPage.getByRole("button", { name: msg("TeacherAssessments.publish.label"), exact: true });
    await expect(publish).toBeEnabled();
    await publish.click();
    await openDialog(teacherPage).getByRole("button", { name: msg("TeacherAssessments.publish.label"), exact: true }).click();
    await expect(teacherPage.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toBeVisible();

    // ── The student: list, start, answer, refresh, resume, submit ──────────
    const studentPage = await as("studentDowntown");
    const bodies: string[] = [];
    watchResponses(studentPage, bodies);

    await studentPage.goto(`/${appLocale}/student/assessments`);
    await expectHealthy(studentPage, appLocale);
    await closeRatingPopup(studentPage, msg("RatingPopup.title"), msg("Shared.close"));
    await studentPage.getByRole("link", { name: new RegExp(title) }).click();
    await studentPage.waitForURL(new RegExp(`/student/assessments/${assessmentId}`));
    await expect(studentPage.getByText("First question")).toHaveCount(0);

    await studentPage.getByRole("button", { name: msg("StudentAssessments.start.label"), exact: true }).click();
    const dialog = openDialog(studentPage);
    await expect(dialog.getByText(msg("StudentAssessments.start.noPause"))).toBeVisible();
    await dialog.getByRole("button", { name: msg("StudentAssessments.start.confirm"), exact: true }).click();

    await expect(studentPage.getByRole("timer")).toBeVisible();
    await expect(studentPage.getByRole("radio")).toHaveCount(4);
    await studentPage.getByRole("radio").nth(1).check();
    await expect(studentPage.getByText(msg("StudentAssessments.take.saved"), { exact: true })).toBeVisible();
    const shownBefore = await studentPage.locator("main p[dir=auto]").first().innerText();

    await studentPage.reload();
    await expectHealthy(studentPage, appLocale);
    await closeRatingPopup(studentPage, msg("RatingPopup.title"), msg("Shared.close"));
    await expect(studentPage.getByRole("timer")).toBeVisible();
    await expect(studentPage.locator("main p[dir=auto]").first(), "the shuffled order survives a refresh").toHaveText(shownBefore);
    await expect(studentPage.getByRole("radio").nth(1), "the saved answer survives a refresh").toBeChecked();

    await studentPage.getByRole("button", { name: msg("StudentAssessments.take.next"), exact: true }).click();
    await studentPage.getByRole("button", { name: msg("StudentAssessments.take.review"), exact: true }).click();
    await studentPage.getByRole("button", { name: msg("StudentAssessments.take.submit"), exact: true }).click();
    await openDialog(studentPage).getByRole("button", { name: msg("StudentAssessments.take.submit"), exact: true }).click();

    // An exam's score is off by default, so the student reads only "Submitted".
    await expect(studentPage.getByRole("paragraph").filter({ hasText: new RegExp(`^${msg("StudentAssessments.result.submitted")}$`) })).toBeVisible();
    await expect(studentPage.getByRole("timer")).toHaveCount(0);

    // ── Rule 11 ────────────────────────────────────────────────────────────
    expect(await studentPage.content(), "the rendered page").not.toContain(LEAK);
    await studentPage.reload();
    await expectHealthy(studentPage, appLocale);
    expect(await studentPage.content(), "the rendered page after submit").not.toContain(LEAK);
    expect(bodies.length, "responses were captured").toBeGreaterThan(0);
    expect(bodies.filter((body) => body.includes(LEAK)), "no response before reveal").toEqual([]);

    // ── The teacher sees it is locked now ──────────────────────────────────
    await teacherPage.reload();
    await expect(teacherPage.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toHaveCount(0);
  } finally {
    const db = new PrismaClient();
    try {
      await removeE2eAssessments(db, tag);
    } finally {
      await db.$disconnect();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// W3a follow-up: one sitting, the reveal, extend + unpublish, and access. Every
// exam is inserted directly (staging-guarded) under the shared prefix + the test's
// own tag, and removed by the same teardown, so a second run leaves the same rows.
// ─────────────────────────────────────────────────────────────────────────────

async function withFixtures<T>(run: (db: PrismaClient, tag: string) => Promise<T>): Promise<T> {
  const tag = uniqueTag("").toLowerCase();
  const db = new PrismaClient();
  try {
    return await run(db, tag);
  } finally {
    try {
      await removeE2eAssessments(db, tag);
    } finally {
      await db.$disconnect();
    }
  }
}

/** Opens a student's assessment page and dismisses the rating pop-up if it appears. */
async function openStudentAssessment(page: Page, locale: AppLocale, id: string, msg: (key: string) => string) {
  await page.goto(`/${locale}/student/assessments/${id}`);
  await expectHealthy(page, locale);
  await closeRatingPopup(page, msg("RatingPopup.title"), msg("Shared.close"));
}

test("@write a one-sitting exam is submitted when the student closes the page", async ({ as, appLocale, msg }) => {
  await withFixtures(async (db, tag) => {
    const fx = await findFixtureClass(db);
    const exam = await insertExam(db, fx, { suffix: "sitting", tag, endsInMs: 2 * DAY, oneSitting: true, durationMinutes: 30 });

    const page = await as("studentDowntown");
    page.on("dialog", (dialog) => void dialog.accept());
    await openStudentAssessment(page, appLocale, exam.id, msg);
    await page.getByRole("button", { name: msg("StudentAssessments.start.label"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("StudentAssessments.start.confirm"), exact: true }).click();
    await expect(page.getByRole("timer")).toBeVisible();
    await page.getByRole("radio").nth(1).check();
    await expect(page.getByText(msg("StudentAssessments.take.saved"), { exact: true })).toBeVisible();

    const before = await db.assessmentAttempt.findFirstOrThrow({ where: { assessmentId: exam.id }, select: { id: true, submittedAt: true } });
    expect(before.submittedAt, "still open while the page is open").toBeNull();

    // The student leaves: the page's `pagehide` sends the close beacon.
    await page.close({ runBeforeUnload: true });
    await expect
      .poll(async () => (await db.assessmentAttempt.findUnique({ where: { id: before.id }, select: { finalisedBy: true } }))?.finalisedBy, {
        timeout: 30_000,
      })
      .toBe("STUDENT");

    const reopened = await as("studentDowntown");
    await openStudentAssessment(reopened, appLocale, exam.id, msg);
    await expect(
      reopened.getByRole("paragraph").filter({ hasText: new RegExp(`^${msg("StudentAssessments.result.submitted")}$`) }),
    ).toBeVisible();
    await expect(reopened.getByRole("timer")).toHaveCount(0);
  });
});

test("@write reveal: the score, the correct answers and the window decide what a student sees", async ({ as, appLocale, msg }) => {
  await withFixtures(async (db, tag) => {
    const fx = await findFixtureClass(db);
    const closed = -HOUR; // the window ended an hour ago
    const scoreOnly = await insertExam(db, fx, { suffix: "score", tag, endsInMs: closed, finalAttempt: true, showScore: true });
    const neither = await insertExam(db, fx, { suffix: "neither", tag, endsInMs: closed, finalAttempt: true });
    const both = await insertExam(db, fx, { suffix: "both", tag, endsInMs: closed, finalAttempt: true, showScore: true, showCorrectAnswers: true });
    const open = await insertExam(db, fx, { suffix: "open", tag, endsInMs: 2 * DAY, finalAttempt: true, showScore: true, showCorrectAnswers: true });

    const page = await as("studentDowntown");
    const bodies: string[] = [];
    watchResponses(page, bodies);
    const submitted = page.getByRole("paragraph").filter({ hasText: new RegExp(`^${msg("StudentAssessments.result.submitted")}$`) });
    const score = page.locator("p.text-2xl");
    const correctLabel = page.getByText(msg("StudentAssessments.reveal.correct"), { exact: true });

    // 1. showScore on, showCorrectAnswers off: the score, and no correctness.
    await openStudentAssessment(page, appLocale, scoreOnly.id, msg);
    await expect(score).toBeVisible();
    await expect(submitted).toHaveCount(0);
    await expect(correctLabel).toHaveCount(0);
    await expect(page.locator("main ol")).toHaveCount(0);
    await expect(page.locator('main svg[class*="lucide-check"]')).toHaveCount(0);
    expect(await page.content(), "case 1: the rendered page").not.toContain(LEAK);
    expect(bodies.filter((body) => body.includes(LEAK)), "case 1: no response").toEqual([]);

    // 2. Both off: only "Submitted".
    await openStudentAssessment(page, appLocale, neither.id, msg);
    await expect(submitted).toBeVisible();
    await expect(score).toHaveCount(0);
    await expect(correctLabel).toHaveCount(0);
    await expect(page.locator("main ol")).toHaveCount(0);
    expect(await page.content(), "case 2: the rendered page").not.toContain(LEAK);
    expect(bodies.filter((body) => body.includes(LEAK)), "case 2: no response").toEqual([]);

    // 3. Still inside its window: no correctness even with showCorrectAnswers on.
    await openStudentAssessment(page, appLocale, open.id, msg);
    await expect(correctLabel).toHaveCount(0);
    await expect(page.locator("main ol")).toHaveCount(0);
    await expect(page.locator('main svg[class*="lucide-check"]')).toHaveCount(0);
    expect(await page.content(), "case 3: the rendered page").not.toContain(LEAK);
    expect(bodies.filter((body) => body.includes(LEAK)), "case 3: no response").toEqual([]);

    // 4. Both on and the window closed: the correct answers, by icon and by text.
    await openStudentAssessment(page, appLocale, both.id, msg);
    await expect(score).toBeVisible();
    const cards = page.locator("main ol > li");
    await expect(cards).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const marked = cards.nth(index).locator("ul > li").filter({ hasText: msg("StudentAssessments.reveal.correct") });
      await expect(marked, `question ${index + 1} marks exactly one correct option`).toHaveCount(1);
      await expect(marked.locator('svg[class*="lucide-check"]')).toHaveCount(1);
      await expect(marked).toContainText(both.questions[index].options[both.questions[index].correct]);
    }
    // Question 2 was answered wrong: the chosen option carries the cross and "Your answer".
    await expect(
      cards.nth(1).locator("ul > li").filter({ hasText: msg("StudentAssessments.reveal.yours") }).locator('svg[class*="lucide-x"]'),
    ).toHaveCount(1);
  });
});

test("@write a published exam with an attempt: no question controls, an earlier end is refused, a later one saves, no back to draft", async ({
  as,
  appLocale,
  msg,
}) => {
  await withFixtures(async (db, tag) => {
    const fx = await findFixtureClass(db);
    // Closes at 12:00 UTC two Cairo days from now: a fixed time of day to move the date around.
    const closesAt = new Date(dayFromToday(2).getTime() + 12 * HOUR);
    const exam = await insertExam(db, fx, { suffix: "extend", tag, endsInMs: closesAt.getTime() - Date.now(), finalAttempt: true });
    const stored = () => db.assessment.findUniqueOrThrow({ where: { id: exam.id }, select: { windowEnd: true, status: true } });
    expect((await stored()).windowEnd?.getTime()).toBe(closesAt.getTime());

    const page = await as(fx.teacher);
    await page.goto(`/${appLocale}/teacher/assessments/${exam.id}`);
    await expectHealthy(page, appLocale);

    // Locked: the questions are read-only and there is no way back to a draft.
    await expect(page.getByText(exam.questions[0].text, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: msg("TeacherAssessments.builder.addQuestion"), exact: true })).toHaveCount(0);
    await expect(page.getByLabel(msg("TeacherAssessments.builder.questionText"), { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toHaveCount(0);

    // An earlier end is refused and saves nothing.
    const extend = page.getByRole("button", { name: msg("TeacherAssessments.extend.label"), exact: true });
    await pickDate(page, appLocale, msg("TeacherAssessments.extend.date"), dayFromToday(1));
    await extend.click();
    await expect(page.getByText(msg("TeacherAssessments.errors.notLater"), { exact: true })).toBeVisible();
    expect((await stored()).windowEnd?.getTime(), "an earlier end changes nothing").toBe(closesAt.getTime());

    // A later end saves.
    await pickDate(page, appLocale, msg("TeacherAssessments.extend.date"), dayFromToday(3));
    await extend.click();
    await expect.poll(async () => (await stored()).windowEnd!.getTime(), { timeout: 30_000 }).toBeGreaterThan(closesAt.getTime());
    expect((await stored()).status).toBe("PUBLISHED");

    // Still no way back to a draft.
    await page.reload();
    await expect(page.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toHaveCount(0);
  });
});

test("@write other roles cannot open a student's assessment, and a student cannot open the builder", async ({ as, appLocale, msg }) => {
  await withFixtures(async (db, tag) => {
    const fx = await findFixtureClass(db);
    const exam = await insertExam(db, fx, { suffix: "access", tag, endsInMs: 2 * DAY });
    const hidden = [exam.title, exam.questions[0].text, exam.questions[0].options[0]];

    // The student sees it - so the refusals below are about the account, not the fixture.
    const student = await as("studentDowntown");
    await openStudentAssessment(student, appLocale, exam.id, msg);
    await expect(student.getByText(exam.title).first()).toBeVisible();

    const expectNothing = async (page: Page, path: string, buttonLabel: string) => {
      await page.goto(`/${appLocale}${path}`);
      await page.waitForLoadState("domcontentloaded");
      const html = await page.content();
      for (const text of hidden) expect(html, `${path} must not show "${text}"`).not.toContain(text);
      expect(html, `${path} must not leak a correct answer`).not.toContain(LEAK);
      await expect(page.getByRole("button", { name: buttonLabel, exact: true })).toHaveCount(0);
      await expect(page.getByRole("radio")).toHaveCount(0);
    };
    const start = msg("StudentAssessments.start.label");

    await expectNothing(await as("parentFamily"), `/student/assessments/${exam.id}`, start);
    await expectNothing(await as("manager"), `/student/assessments/${exam.id}`, start);
    await expectNothing(await as("receptionist"), `/student/assessments/${exam.id}`, start);

    // A student opening the teacher's builder and viewer.
    const save = msg("TeacherAssessments.builder.save");
    await expectNothing(student, `/teacher/assessments/${exam.id}`, save);
    await expectNothing(
      student,
      `/teacher/assessments/new?type=EXAM&branch=${encodeURIComponent(fx.centerId)}&class=${encodeURIComponent(fx.classGroupId)}`,
      save,
    );
    await expect(student.locator("#assessment-title")).toHaveCount(0);
  });
});
