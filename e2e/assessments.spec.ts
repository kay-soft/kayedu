import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";

import { E2E_ASSESSMENT_PREFIX, removeE2eAssessments } from "../scripts/lib/e2e-assessments";
import { ACCOUNTS, uniqueTag, type AccountKey } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
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
