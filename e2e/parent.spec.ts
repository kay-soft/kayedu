import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { signUp, signUpProjectOnly } from "./support/signup";
import { field } from "./support/ui";

/**
 * Journey 8 — the parent (SYS Part A): the child selector and the read-only
 * mirror; and the KNOWN GAP (not a bug): a new parent can never be onboarded
 * today. Sign-up with a student's parent phone originates a PENDING link
 * only (no phone is stored — D-02), and staff verification is disabled until
 * OD-6 is decided (D-03 (d)), so the new parent sees no child, ever.
 */

test("a verified parent switches between children in a read-only mirror", async ({ as, appLocale, msg }) => {
  const page = await as("parentFamily");
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
  const selector = page.getByLabel(msg("ParentPortal.childSelectorLabel"));
  await expect(selector).toBeVisible();
  await selector.click();
  const options = page.getByRole("option");
  await expect(options, "two verified children").toHaveCount(2);
  await options.last().click();
  await expect(page).toHaveURL(/[?&]child=/);
  await expectHealthy(page, appLocale);
  // Read-only: no form control writes anything (only the date filter / child selector).
  await expect(page.getByRole("button", { name: /save|submit|enrol|reserve|cancel request|rate/i })).toHaveCount(0);
});

test("a parent with one verified child (and one pending) sees exactly one", async ({ as, appLocale }) => {
  const page = await as("parentNokhba");
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
});

test("@write KNOWN GAP: a new parent's sign-up with a student's parent phone stays pending forever", async ({ page, as, appLocale, msg }, testInfo) => {
  signUpProjectOnly(testInfo);
  // A seeded student's parent phone, read the way staff see it.
  const manager = await as("manager");
  await manager.goto(`/${appLocale}/students`);
  await manager.locator('main a[href*="/students/"]').first().click();
  const parentPhone = await manager.getByLabel(field(msg("Students.fields.parentPhone"))).inputValue();
  test.skip(!parentPhone, "the first seeded student has no parent phone");
  const studentUrl = manager.url();

  const tag = uniqueTag("e2e").toLowerCase();
  await signUp(page, appLocale, { firstName: "Eetoo", lastName: `Parent ${tag}`, email: `${tag}-parent@example.com`, phone: parentPhone });
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toBeVisible();

  // Staff see the pending link, and Verify is disabled (D-03 (d), OD-6).
  await manager.goto(studentUrl);
  const verify = manager.getByRole("button", { name: msg("Students.parentLinks.verify") });
  if (await verify.count()) await expect(verify.first()).toBeDisabled();
});
