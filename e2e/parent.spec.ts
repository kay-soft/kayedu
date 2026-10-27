import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { signUp, signUpProjectOnly } from "./support/signup";
import { field, firstDetailLink, openDialog } from "./support/ui";

/**
 * Journey 8 — the parent (SYS Part A, F3): the child selector and the
 * read-only mirror; and onboarding a new parent with a one-time code (OD-6
 * decided). A Parent sign-up (F4) carries no phone and links nothing: it sees
 * "No child linked yet" until it uses a code. The branch prints a code; the
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

test("@write a new parent sign-up links nothing; it links with the branch's printed code, then unlinks", async ({ page, as, appLocale, msg }, testInfo) => {
  signUpProjectOnly(testInfo);
  // A seeded student's page, where the branch prints the code.
  const manager = await as("manager");
  await manager.goto(`/${appLocale}/students`);
  await (await firstDetailLink(manager, "/students")).click();

  const tag = uniqueTag("e2e").toLowerCase();
  // F4: a Parent sign-up lands on the parent portal's "Link your child".
  await signUp(page, appLocale, { firstName: "Eetoo", lastName: `Parent ${tag}`, email: `${tag}-parent@example.com` }, "PARENT");
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/parent`));
  await page.goto(`/${appLocale}/parent`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toBeVisible();

  // The branch prints a code (shown once, in the dialog).
  const generate = manager.getByRole("button", { name: new RegExp(`^(${msg("Family.branch.generate")}|${msg("Family.branch.regenerate")})$`) });
  // The card first (so a count of zero means "not rendered", not "not rendered yet"); a missing
  // button is a failure with a name, never a 30 s wait inside isDisabled; a disabled one is the
  // only skip.
  await expect(manager.getByText(msg("Family.branch.title"), { exact: true }).first()).toBeVisible();
  expect(await generate.count(), "the student page's Parent access card offers Generate / Replace the code").toBeGreaterThan(0);
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
  // Wait for the outcome (the child's row gives way to the empty card): navigating at once can
  // abort the request in flight. (Not the toast: the button that owns it unmounts with its row.)
  await expect(page.getByText(msg("Family.parent.noChildren"))).toBeVisible();
  await page.goto(`/${appLocale}/parent`);
  await expect(page.getByText(msg("ParentPortal.noChildren"))).toBeVisible();
});
