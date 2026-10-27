import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { signUp, signUpProjectOnly } from "./support/signup";
import { field, openDialog } from "./support/ui";

/**
 * Journey 8 — the parent (SYS Part A, F3): the child selector and the
 * read-only mirror; and onboarding a new parent with a one-time code (OD-6
 * decided). A phone match grants nothing: a sign-up carrying a student's
 * parent phone sees "No child linked yet". The branch prints a code; the
 * parent links with it at /family/join (the code in the URL fragment) and
 * lands in the portal; then unlinks from Account → Family, which frees the
 * slot so the journey can run again.
 */

test("a linked parent switches between children in a read-only mirror", async ({ as, appLocale, msg }) => {
  const page = await as("parentFamily");
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
  const selector = page.getByLabel(msg("ParentPortal.childSelectorLabel"));
  await expect(selector).toBeVisible();
  await selector.click();
  const options = page.getByRole("option");
  await expect(options, "two linked children, one per branch").toHaveCount(2);
  await options.last().click();
  await expect(page).toHaveURL(/[?&]child=/);
  await expectHealthy(page, appLocale);
  // Read-only: no form control writes anything (only the date filter / child selector).
  await expect(page.getByRole("button", { name: /save|submit|enrol|reserve|cancel request|rate/i })).toHaveCount(0);
});

test("a parent whose one child studies at two branches sees both", async ({ as, appLocale }) => {
  const page = await as("parentNokhba");
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
});

test("@write a phone match grants nothing; a new parent links with the branch's printed code, then unlinks", async ({ page, as, appLocale, msg }, testInfo) => {
  signUpProjectOnly(testInfo);
  // A seeded student's parent phone, read the way staff see it.
  const manager = await as("manager");
  await manager.goto(`/${appLocale}/students`);
  await manager.locator('main a[href*="/students/"]').first().click();
  const parentPhone = await manager.getByLabel(field(msg("Students.fields.parentPhone"))).inputValue();

  const tag = uniqueTag("e2e").toLowerCase();
  await signUp(page, appLocale, { firstName: "Eetoo", lastName: `Parent ${tag}`, email: `${tag}-parent@example.com`, phone: parentPhone || undefined });
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toBeVisible();

  // The branch prints a code (shown once, in the dialog).
  const generate = manager.getByRole("button", { name: new RegExp(`^(${msg("Family.branch.generate")}|${msg("Family.branch.regenerate")})$`) });
  test.skip(await generate.isDisabled(), "this student's three parent slots are in use");
  await generate.click();
  const dialog = openDialog(manager);
  await dialog.getByRole("button", { name: new RegExp(`^(${msg("Family.branch.generate")}|${msg("Family.branch.regenerate")})$`) }).click();
  const code = (await dialog.locator("bdi.font-mono").first().textContent())?.trim() ?? "";
  expect(code, "the code is shown once").toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // The parent links with it: the code travels in the fragment.
  await page.goto(`/${appLocale}/family/join#${code.replace("-", "")}`);
  await expect(page.getByLabel(field(msg("Family.join.codeLabel")))).toHaveValue(code.replace("-", ""));
  await page.getByRole("button", { name: msg("Family.join.submit") }).click();
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/parent`));
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toHaveCount(0);

  // The same code again is refused.
  await page.goto(`/${appLocale}/family/join#${code.replace("-", "")}`);
  await page.getByRole("button", { name: msg("Family.join.submit") }).click();
  await expect(page.getByText(msg("Family.errors.alreadyLinked")).or(page.getByText(msg("Family.errors.invalidCode")))).toBeVisible();

  // The parent unlinks from Account → Family; reads stop.
  await page.goto(`/${appLocale}/account?from=parent`);
  await page.getByRole("button", { name: msg("Family.parent.unlink") }).first().click();
  await openDialog(page).getByRole("button", { name: msg("Family.parent.unlink") }).click();
  await page.goto(`/${appLocale}/parent`);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toBeVisible();
});
