import { SEED } from "./support/accounts";
import { expect, expectHealthy, primaryNav, test } from "./support/fixtures";
import { selectBranch } from "./support/ui";

/**
 * Journey 6 — the teacher at one centre, at two centres and at none (SYS
 * Part A): dashboard (with the average-only rating), the forward-looking
 * schedule, a session's detail and its note (the edit deadline), students,
 * the class/session request forms, their own approvals queue, settlements,
 * the branch switcher, and the centre directory for a teacher with no centre.
 */

test("one centre: every teacher page renders; a session opens with its note card", async ({ as, appLocale, msg }) => {
  const page = await as("teacherDowntown");
  for (const route of [
    "/teacher/dashboard",
    "/teacher/sessions",
    "/teacher/students",
    "/teacher/classes",
    "/teacher/approvals",
    "/teacher/settlements",
  ]) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page).toHaveURL(new RegExp(`/${appLocale}${route}$`));
    await expectHealthy(page, appLocale);
  }
  // The request forms are on their pages (trusted teacher, M10).
  await page.goto(`/${appLocale}/teacher/classes`);
  await expect(page.getByText(msg("TeacherClasses.request.title"), { exact: false }).first()).toBeVisible();
  await page.goto(`/${appLocale}/teacher/sessions?range=month`);
  const firstSession = page.locator('main a[href*="/teacher/sessions/"]').first();
  if (await firstSession.count()) {
    await firstSession.click();
    await expect(page).toHaveURL(/\/teacher\/sessions\/[0-9a-f-]{36}$/);
    await expectHealthy(page, appLocale);
    await expect(page.getByText(msg("TeacherSessions.description.title"), { exact: true })).toBeVisible();
    // The hint states this branch's real deadline setting (SYS copy fix).
    await expect(
      page.getByText(msg("TeacherSessions.description.hintNoDeadline")).or(page.getByText(/after the start of the session's day|بعد بداية يوم الحصة/)),
    ).toBeVisible();
  }
});

test("two centres: the hub lists both branches and switching changes the active branch", async ({ as, appLocale }) => {
  const page = await as("teacherShared");
  await selectBranch(page, appLocale, SEED.downtown);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/teacher/dashboard$`));
  await expectHealthy(page, appLocale);
  await selectBranch(page, appLocale, SEED.nasrCity);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/teacher/dashboard$`));
  // The active branch is named in the shell — in the drawer on a phone.
  const nav = await primaryNav(page, appLocale);
  await expect(nav.locator("xpath=ancestor::*[self::aside or @role='dialog'][1]").getByText(SEED.nasrCity).first()).toBeVisible();
});

test("zero centres: the teacher lands on the centre directory, never on student Discover", async ({ as, appLocale, msg }) => {
  const page = await as("teacherNew");
  await page.goto(`/${appLocale}/teacher/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/teacher/centers$`));
  await expectHealthy(page, appLocale);
  await expect(page.getByRole("heading", { name: msg("TeacherCenters.title") })).toBeVisible();
  // The request form expands in place, with its fields (one pending request per branch, D-18).
  await page.getByRole("button", { name: msg("TeacherCenters.requestButton") }).first().click();
  await expect(page.getByRole("button", { name: msg("TeacherCenters.request.submit") })).toBeVisible();
  await page.getByRole("button", { name: msg("TeacherCenters.request.cancel") }).click();
  await expect(page.getByRole("button", { name: msg("TeacherCenters.request.submit") })).toHaveCount(0);
});
