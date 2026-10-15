import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";

/**
 * Journey 1 — the platform admin (SYS Part A): provision a branch (and the
 * one-branch organization it creates), move it through its lifecycle,
 * override its visibility window, open its support view (audited), read the
 * platform KPIs and manage the global catalog.
 */

test("platform KPIs and the centre list render", async ({ as, appLocale, msg }) => {
  const page = await as("admin");
  await page.goto(`/${appLocale}/admin/platform`);
  await expectHealthy(page, appLocale);
  await page.goto(`/${appLocale}/admin/centers`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("AdminCenters.create.title"), { exact: true })).toBeVisible();
});

test("@write provision a branch, move it ONBOARDING → ACTIVE → ARCHIVED, override its window", async ({ as, appLocale, msg }) => {
  const page = await as("admin");
  const tag = uniqueTag("e2e").toLowerCase();
  const name = `E2E Branch ${tag}`;

  await page.goto(`/${appLocale}/admin/centers`);
  await page.getByLabel(msg("AdminCenters.create.fields.name"), { exact: true }).fill(name);
  await page.getByLabel(msg("AdminCenters.create.fields.slug"), { exact: true }).fill(tag);
  await page.getByLabel(msg("AdminCenters.create.fields.ownerEmail"), { exact: true }).fill(`${tag}-owner@example.com`);
  await page.getByRole("button", { name: msg("AdminCenters.create.submit"), exact: true }).click();
  await expect(page.getByText(msg("AdminCenters.create.created"))).toBeVisible();
  await expect(page.getByLabel(msg("AdminCenters.create.inviteLinkLabel"))).toHaveValue(/\/invite\//);

  // The new branch is listed; open its support view (it starts ONBOARDING).
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/centers\/[0-9a-f-]+$/);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("AdminCenters.lifecycle.ONBOARDING")).first()).toBeVisible();

  // Every visit writes a support-access audit row — it shows under Recent activity.
  await expect(page.getByText(msg("AdminCenters.detail.auditEmpty"))).toHaveCount(0);

  const moveTo = async (state: "ACTIVE" | "ARCHIVED") => {
    await page.getByLabel(msg("AdminCenters.lifecycleTransitionLabel"), { exact: true }).click();
    await page.getByRole("option", { name: msg(`AdminCenters.lifecycle.${state}`), exact: true }).click();
    const submit = page.getByRole("button", { name: msg("AdminCenters.lifecycleTransitionSubmit"), exact: true });
    if (state === "ARCHIVED") {
      // Terminal: the button waits for an explicit "this is final" tick (SYS).
      await expect(submit).toBeDisabled();
      await page.getByRole("checkbox", { name: msg("AdminCenters.archiveConfirm") }).check();
    }
    await submit.click();
    // ARCHIVED is terminal: the form is replaced by the "final" notice instead of a saved message.
    await expect(
      page.getByText(msg(state === "ARCHIVED" ? "AdminCenters.lifecycleTerminal" : "AdminCenters.lifecycleTransitionSaved")),
    ).toBeVisible();
    await expect(page.getByText(msg(`AdminCenters.lifecycle.${state}`)).first()).toBeVisible();
  };
  await moveTo("ACTIVE");

  await page.getByLabel(msg("AdminCenters.detail.visibilityLabel"), { exact: true }).fill("45");
  await page.getByRole("button", { name: msg("AdminCenters.detail.saveVisibility"), exact: true }).click();
  await expect(page.getByText(msg("AdminCenters.detail.visibilitySaved"))).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(msg("AdminCenters.detail.visibilityLabel"), { exact: true })).toHaveValue("45");

  // Clean up the only way a branch can be: ARCHIVED is terminal.
  await moveTo("ARCHIVED");
  await expect(page.getByText(msg("AdminCenters.lifecycleTerminal"))).toBeVisible();
});

test("@write the global catalog: add a subject, find it, delete it", async ({ as, appLocale, msg }) => {
  const page = await as("admin");
  const tag = uniqueTag("E2E");
  await page.goto(`/${appLocale}/admin/catalog`);
  await expectHealthy(page, appLocale);

  await page.getByRole("tab", { name: new RegExp(msg("AdminCatalog.tabs.subject")) }).click();
  await page.getByRole("button", { name: msg("AdminCatalog.add"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The dialog is centred in both directions at desktop width (SYS: RTL fix).
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 640) {
    const box = await dialog.boundingBox();
    expect(box && Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4);
  }
  await dialog.getByLabel(msg("AdminCatalog.fields.nameEn"), { exact: true }).fill(`${tag} Subject`);
  await dialog.getByLabel(msg("AdminCatalog.fields.nameAr"), { exact: true }).fill(`مادة ${tag}`);
  await dialog.getByRole("button", { name: msg("AdminCatalog.add"), exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("searchbox", { name: msg("AdminCatalog.search") }).or(page.getByLabel(msg("AdminCatalog.search"))).first().fill(tag);
  const entry = page.getByRole("listitem").filter({ hasText: `${tag} Subject` }).first();
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: msg("AdminCatalog.delete"), exact: true }).click();
  await page.getByRole("button", { name: msg("AdminCatalog.deleteYes"), exact: true }).click();
  await expect(page.getByText(`${tag} Subject`)).toHaveCount(0);
});
