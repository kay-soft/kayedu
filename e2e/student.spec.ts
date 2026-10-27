import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { signUp, signUpProjectOnly } from "./support/signup";
import { choose, field } from "./support/ui";

/**
 * Journey 7 — the student (SYS Part A): the rating pop-up (skippable; closing
 * persists nothing), the schedule, Discover, reservations, and a brand-new
 * sign-up's whole path: a Student sign-up lands on "Your studies" (F4) →
 * grade → skip the optional parent invite → Discover → instant enrolment →
 * the one-time profile completion → the schedule.
 */

test("a seeded student: the rating pop-up closes without a decision, every page renders", async ({ as, appLocale, msg }) => {
  const page = await as("studentDowntown");
  await page.goto(`/${appLocale}/student/schedule`);
  await expectHealthy(page, appLocale);
  const popup = page.getByRole("dialog", { name: msg("RatingPopup.title") });
  if (await popup.isVisible().catch(() => false)) {
    await expect(popup.getByRole("button", { name: msg("RatingPopup.skip") }).first()).toBeVisible();
    await popup.getByRole("button", { name: msg("Shared.close"), exact: true }).click();
    await expect(popup).toBeHidden();
  }
  for (const route of ["/student/discover", "/student/reservations"]) {
    await page.goto(`/${appLocale}${route}`);
    await expectHealthy(page, appLocale);
  }
});

test("a student with no centre sees their pending and declined requests", async ({ as, appLocale, msg }) => {
  const page = await as("studentNew");
  await page.goto(`/${appLocale}/student/reservations`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("StudentReservations.status.PENDING")).first()).toBeVisible();
});

test("@write a new sign-up onboards, enrols instantly, completes the profile once, sees the schedule", async ({ page, appLocale, msg }, testInfo) => {
  signUpProjectOnly(testInfo);
  const tag = uniqueTag("e2e").toLowerCase();
  await signUp(page, appLocale, { firstName: "Eetoo", lastName: `Student ${tag}`, email: `${tag}-student@example.com` });
  // A Student sign-up with no branch lands on "Your studies" (F4): the account
  // grade, then an optional parent invite (skipped here), then Discover.
  await expect(page).toHaveURL(/\/student\/onboarding/);
  await expectHealthy(page, appLocale);
  await choose(page, msg("Account.study.picker.system"), /.+/);
  await choose(page, msg("Account.study.picker.grade"), /.+/);
  await page.getByRole("button", { name: msg("Onboarding.student.continue"), exact: true }).click();
  await page.getByRole("link", { name: msg("Onboarding.student.skip"), exact: true }).click();
  await expect(page).toHaveURL(/\/student\/discover/);
  // Discover opens on the account grade; "All grades" keeps this journey
  // independent of which grades the seeded branches teach.
  await page.goto(`/${appLocale}/student/discover?grade=all`);
  await expectHealthy(page, appLocale);

  await page.getByRole("button", { name: msg("StudentDiscover.card.enroll"), exact: true }).first().click();
  // Once a seat is claimed the (student) layout substitutes the one-time
  // profile form for whatever page is shown (M18) — no redirect involved.
  await expect(page.getByRole("heading", { name: msg("StudentProfile.title") })).toBeVisible();
  await page.goto(`/${appLocale}/student/schedule`);
  await expect(page.getByRole("heading", { name: msg("StudentProfile.title") })).toBeVisible();
  await choose(page, msg("Students.fields.grade"), /.+/);
  await page.getByLabel(field(msg("People.fields.phone"))).fill(`012${String(Date.now()).slice(-8)}`);
  await page.getByRole("button", { name: msg("StudentProfile.submit"), exact: true }).click();
  await expect(page.getByRole("heading", { name: msg("StudentSchedule.title") })).toBeVisible();
  await expectHealthy(page, appLocale);
});
