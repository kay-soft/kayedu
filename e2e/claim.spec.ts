import type { Page } from "@playwright/test";

import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { t, type AppLocale } from "./support/i18n";
import { E2E_PASSWORD, signInWith, signUp, signUpProjectOnly } from "./support/signup";
import { choose, field, openDialog } from "./support/ui";

/**
 * The account-claim journey (SEC-2a, D-01): a receptionist registers a
 * student WITH an email; that person later signs up with the same email. The
 * sign-up never links itself — it waits ("your account is waiting for a
 * branch") until a manager approves or declines in person on /approvals.
 * Both outcomes are proven: approve → the login becomes that student;
 * decline → the login becomes a new, separate person.
 */

async function registerStudentWithEmail(page: Page, locale: AppLocale, lastName: string, email: string) {
  const tr = (key: string) => t(locale, key);
  await page.goto(`/${locale}/students`);
  await page.getByRole("button", { name: tr("Students.add"), exact: true }).click();
  const add = openDialog(page);
  await add.getByLabel(field(tr("People.fields.firstName"))).fill("Claimy");
  await add.getByLabel(field(tr("People.fields.lastName"))).fill(lastName);
  await add.getByLabel(field(tr("People.fields.email"))).fill(email);
  await add.getByLabel(field(tr("People.fields.phone"))).fill(`011${String(Date.now()).slice(-8)}`);
  await choose(add, tr("Students.fields.grade"), /.+/);
  await add.getByRole("button", { name: tr("Students.add"), exact: true }).click();
  await expect(add).toBeHidden();
}

async function claimCard(manager: Page, locale: AppLocale, email: string) {
  await manager.goto(`/${locale}/approvals`);
  await expectHealthy(manager, locale);
  return manager.locator("li, article").filter({ hasText: email }).first();
}

for (const outcome of ["approve", "decline"] as const) {
  test(`@write account claim — ${outcome}`, async ({ page, as, appLocale, msg }, testInfo) => {
    signUpProjectOnly(testInfo);
    const tag = uniqueTag("e2e").toLowerCase();
    const email = `${tag}-claim@example.com`;
    const desk = await as("receptionist");
    await registerStudentWithEmail(desk, appLocale, `Claim ${tag}`, email);

    // The person signs up with that email: no link, a pending claim.
    await signUp(page, appLocale, { firstName: "Claimy", lastName: `Claim ${tag}`, email });
    await expect(page).toHaveURL(/account-pending/);
    await expectHealthy(page, appLocale);
    await expect(page.getByText(msg("Auth.accountPending.claimPending.title"))).toBeVisible();

    // A manager decides in person.
    const manager = await as("manager");
    const card = await claimCard(manager, appLocale, email);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: msg(outcome === "approve" ? "Approvals.approve" : "Approvals.decline"), exact: true }).click();
    // The action revalidates the queue: the claim leaves it (no reload needed)…
    await expect(card).toHaveCount(0);
    // …and stays gone on a fresh load.
    await expect((await claimCard(manager, appLocale, email))).toHaveCount(0);

    // Signing in again: approved → the student portal; declined → a new, separate person (no branch).
    await page.context().clearCookies();
    await signInWith(page, appLocale, email);
    if (outcome === "approve") {
      await expect(page).toHaveURL(/\/student\//);
    } else {
      await expect(page).toHaveURL(/select-center/);
      await expect(page.getByText(msg("Auth.selectCenter.emptySubtitle")).first()).toBeVisible();
    }
    await expectHealthy(page, appLocale);
    expect(E2E_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });
}
