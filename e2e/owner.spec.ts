import type { Page } from "@playwright/test";

import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { dayFromToday, field, openDialog, pickDate, rowWith, selectBranch } from "./support/ui";

/**
 * Journey 2 — the owner (SYS Part A): an organization with two branches, the
 * branch switcher, every settings screen, the permissions matrix (owner
 * only), staff invitations and branch access.
 */

/** Opens a settings row's edit form and deletes it through the two-step confirmation. */
async function deleteRow(page: Page, name: string, msg: (key: string) => string) {
  await rowWith(page, name).getByRole("button", { name: msg("Settings.common.edit"), exact: true }).click();
  // In edit mode the name is an input's value, so find the row by its form.
  const editing = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: msg("Settings.common.save"), exact: true }) }).first();
  await editing.getByRole("button", { name: msg("Settings.common.delete"), exact: true }).click();
  await editing.getByRole("button", { name: msg("Settings.common.deleteYes"), exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0);
}

const SETTINGS = [
  ["/settings", "general"],
  ["/settings/rooms", "rooms"],
  ["/settings/payment-methods", "paymentMethods"],
  ["/settings/terms", "terms"],
  ["/settings/catalog", "catalog"],
  ["/settings/card", "card"],
  ["/settings/branding", "branding"],
  ["/settings/permissions", "permissions"],
  ["/settings/staff", "staff"],
] as const;

// U5: Settings → Branches is gone — only a platform admin manages branches.
test("every settings screen renders, and its sub-nav lists all nine (no Branches)", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  for (const [route] of SETTINGS) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page, `${route} must not bounce`).toHaveURL(new RegExp(`/${appLocale}${route}$`));
    await expectHealthy(page, appLocale);
  }
  const subNav = page.getByRole("navigation", { name: msg("Settings.nav.label") });
  for (const [, key] of SETTINGS) {
    await expect(subNav.getByRole("link", { name: msg(`Settings.nav.${key}`), exact: true })).toBeVisible();
  }
  await expect(subNav.getByRole("link")).toHaveCount(SETTINGS.length);
  // The old URL is no settings screen any more.
  await page.goto(`/${appLocale}/settings/branches`);
  await expect(page.getByRole("navigation", { name: msg("Settings.nav.label") })).toHaveCount(0);
  // The permission matrix: every matrix role is a column, every action a row.
  await page.goto(`/${appLocale}/settings/permissions`);
  await expect(page.getByRole("button", { name: msg("Settings.permissions.saveMatrix") })).toBeVisible();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  // The owner-only branch access card sits on Users & roles.
  await page.goto(`/${appLocale}/settings/staff`);
  await expect(page.getByText(msg("Staff.branchGrants.title"), { exact: true })).toBeVisible();
});

test("a manager is refused the owner-only permissions matrix, by nav and by URL", async ({ as, appLocale, msg }) => {
  const page = await as("manager");
  await page.goto(`/${appLocale}/settings`);
  const subNav = page.getByRole("navigation", { name: msg("Settings.nav.label") });
  await expect(subNav.getByRole("link", { name: msg("Settings.nav.permissions"), exact: true })).toHaveCount(0);
  await page.goto(`/${appLocale}/settings/permissions`);
  await expect(page).not.toHaveURL(/\/settings\/permissions$/);
});

test("@write general settings save as they are (conflict policy, late threshold, both windows)", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  await page.goto(`/${appLocale}/settings`);
  await expect(page.getByText(msg("Settings.general.schedulingTitle"), { exact: true })).toBeVisible();
  await expect(page.getByLabel(msg("Settings.general.lateThreshold"))).toBeVisible();
  // U6: two windows, each with its cap.
  await expect(page.getByLabel(msg("Settings.general.visibilityCenter.label"))).toHaveAttribute("max", "365");
  await expect(page.getByLabel(msg("Settings.general.visibilityTeacher.label"))).toHaveAttribute("max", "30");
  await page.getByRole("button", { name: msg("Settings.common.save"), exact: true }).first().click();
  await expect(page.getByText(msg("Settings.common.saved"))).toBeVisible();
});

test("@write payment method: add, deactivate, activate, delete", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  const name = `${uniqueTag()} Pay`;
  await page.goto(`/${appLocale}/settings/payment-methods`);
  await page.getByRole("button", { name: msg("Settings.common.add"), exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel(msg("Settings.paymentMethods.fields.name"), { exact: true }).fill(name);
  await dialog.getByRole("button", { name: msg("Settings.common.add"), exact: true }).click();
  await expect(dialog).toBeHidden();

  const row = rowWith(page, name);
  await expect(row).toContainText(msg("Settings.common.active"));
  await row.getByRole("button", { name: msg("Settings.common.deactivate"), exact: true }).click();
  // DES: deactivating asks first — confirm it in the dialog.
  await openDialog(page).getByRole("button", { name: msg("Settings.common.deactivate"), exact: true }).click();
  await expect(rowWith(page, name)).toContainText(msg("Settings.common.inactive"));
  await rowWith(page, name).getByRole("button", { name: msg("Settings.common.activate"), exact: true }).click();
  await expect(rowWith(page, name)).toContainText(msg("Settings.common.active"));

  await deleteRow(page, name, msg);
});

test("@write term: add a preset with dates, then delete it", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  const name = `${uniqueTag()} Term`;
  await page.goto(`/${appLocale}/settings/terms`);
  await page.getByRole("button", { name: msg("Settings.common.add"), exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel(msg("Settings.terms.fields.name"), { exact: true }).fill(name);
  await pickDate(dialog, appLocale, msg("Settings.terms.fields.startDate"), dayFromToday(1));
  await pickDate(dialog, appLocale, msg("Settings.terms.fields.endDate"), dayFromToday(30));
  await dialog.getByRole("button", { name: msg("Settings.common.add"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(rowWith(page, name)).toBeVisible();

  await deleteRow(page, name, msg);
});

test("@write room: add one, then delete it", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  const name = `${uniqueTag()} Room`;
  await page.goto(`/${appLocale}/settings/rooms`);
  // T3: rooms add and edit in a dialog, "Can be combined with" included.
  await page.getByRole("button", { name: msg("Settings.rooms.addButton"), exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByLabel(field(msg("Settings.rooms.fields.name"))).first().fill(name);
  await dialog.getByLabel(field(msg("Settings.rooms.fields.capacity"))).first().fill("12");
  await dialog.getByRole("button", { name: msg("Settings.common.add"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(rowWith(page, name)).toBeVisible();

  // The row's own Delete asks first, in a dialog.
  await rowWith(page, name).getByRole("button", { name: msg("Settings.common.delete"), exact: true }).click();
  await openDialog(page).getByRole("button", { name: msg("Settings.common.deleteYes"), exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0);
});

test("@write staff: invite a receptionist by email, then revoke the invitation", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale);
  const email = `${uniqueTag("e2e").toLowerCase()}-staff@example.com`;
  await page.goto(`/${appLocale}/settings/staff`);
  await page.getByLabel(field(msg("Staff.fields.email"))).first().fill(email);
  await page.getByRole("combobox", { name: field(msg("Staff.fields.role")) }).first().click();
  await page.getByRole("option", { name: msg("Roles.RECEPTIONIST"), exact: true }).click();
  await page.getByRole("button", { name: msg("Staff.sendInvite"), exact: true }).click();
  await expect(page.getByText(msg("Staff.inviteCreated"))).toBeVisible();
  await expect(page.getByLabel(msg("Staff.inviteLinkLabel"))).toHaveValue(/\/invite\//);

  // TEACHER is never offered here (R9): teachers are added on the Teachers page.
  await page.getByRole("combobox", { name: field(msg("Staff.fields.role")) }).first().click();
  await expect(page.getByRole("option", { name: msg("Roles.RECEPTIONIST"), exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: msg("Roles.TEACHER"), exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  const pending = rowWith(page, email);
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: msg("Staff.revoke"), exact: true }).click();
  // DES: revoking asks first (the one behaviour change) — confirm it.
  await openDialog(page).getByRole("button", { name: msg("Staff.revoke"), exact: true }).click();
  await expect(page.getByText(email)).toHaveCount(0);
});
