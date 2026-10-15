import type { Page } from "@playwright/test";

import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import type { AppLocale } from "./support/i18n";
import { t } from "./support/i18n";
import { choose, dayFromToday, field, isoDayFromToday, openDialog, pickDate, submitConfirmingConflicts } from "./support/ui";

/**
 * Journey 3 — the manager (SYS Part A): classes, sessions (one-time,
 * reschedule, cancel, delete), teachers, students, approvals, settlements,
 * analytics and expenses. Detail pages are opened from their lists and left
 * through their header's back link — a broken back path fails here.
 */

/** Opens the first detail link of a list page and returns to the list by the header's back link. */
async function openFirstDetailAndBack(page: Page, locale: AppLocale, list: string, back: string, query = "") {
  await page.goto(`/${locale}${list}${query}`);
  await expectHealthy(page, locale);
  const detail = page.locator(`main a[href*="${list}/"]`).first();
  await expect(detail).toBeVisible();
  await detail.click();
  await expect(page).toHaveURL(new RegExp(`${list}/[^/]+$`));
  await expectHealthy(page, locale);
  await page.getByRole("link", { name: t(locale, back), exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${locale}${list}(\\?.*)?$`));
}

test("detail pages open from their lists and their back links return", async ({ as, appLocale }) => {
  const page = await as("manager");
  await openFirstDetailAndBack(page, appLocale, "/classes", "Classes.backToList");
  await openFirstDetailAndBack(page, appLocale, "/students", "Students.backToList");
  await openFirstDetailAndBack(page, appLocale, "/teachers", "Teachers.backToList");
  // The sessions list defaults to *today*, which holds nothing on a day with
  // no classes (a Friday, a holiday) - so look across a window around today
  // that always contains the seeded history and the upcoming sessions. The
  // back link returns to the list with its filter, which the URL check allows.
  const window = `?range=range&from=${isoDayFromToday(-30)}&to=${isoDayFromToday(30)}`;
  await openFirstDetailAndBack(page, appLocale, "/sessions", "Sessions.backToList", window);
});

test("approvals, settlements, analytics, expenses, refunds and audit render for the manager", async ({ as, appLocale }) => {
  const page = await as("manager");
  for (const route of ["/approvals", "/settlements", "/analytics", "/expenses", "/refunds", "/audit"]) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page).toHaveURL(new RegExp(`/${appLocale}${route}`));
    await expectHealthy(page, appLocale);
  }
  // Analytics' one date control and the by-teacher breakdown.
  await page.goto(`/${appLocale}/analytics?range=week`);
  await expectHealthy(page, appLocale);
});

/** Creates a one-time session on `day` (06:00–06:45, first room, first teacher, 150 EGP). */
async function createOneOffSession(page: Page, locale: AppLocale, title: string, day: Date) {
  const tr = (key: string) => t(locale, key);
  await page.goto(`/${locale}/sessions`);
  await page.getByRole("button", { name: tr("Sessions.newSession.button"), exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByRole("button", { name: tr("Sessions.newSession.modeOneOff"), exact: true }).click();
  await dialog.getByLabel(tr("Sessions.newSession.titleField"), { exact: true }).fill(title);
  await choose(dialog, tr("Classes.fields.teacher"), /.+/);
  await pickDate(dialog, locale, tr("Sessions.newSession.date"), day);
  await dialog.getByLabel(tr("Sessions.newSession.startTime"), { exact: true }).fill("06:00");
  await dialog.getByLabel(tr("Sessions.newSession.startTime"), { exact: true }).press("Tab");
  await dialog.getByLabel(tr("Sessions.newSession.endTime"), { exact: true }).fill("06:45");
  await dialog.getByLabel(tr("Sessions.newSession.endTime"), { exact: true }).press("Tab");
  await choose(dialog, tr("RoomSets.room"), /.+/);
  await dialog.getByLabel(tr("Classes.fields.price"), { exact: true }).fill("150");
  // A WARN-policy double-booking needs the explicit tick (R3); DENY would refuse.
  await submitConfirmingConflicts(dialog, locale, tr("Sessions.newSession.submit"));
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);
  await expectHealthy(page, locale);
  await expect(page.getByText(title).first()).toBeVisible();
  await expect(page.getByText(tr("Sessions.kind.oneOff")).first()).toBeVisible();
}

test("@write one-time session: create, reschedule, cancel (confirmed) — and a pristine one deletes", async ({ as, appLocale, msg }) => {
  const page = await as("manager");
  const title = `${uniqueTag()} One-time`;
  await createOneOffSession(page, appLocale, title, dayFromToday(2));

  // Reschedule to the next day: a NEW session is created and linked.
  await page.getByRole("button", { name: msg("Sessions.lifecycle.reschedule"), exact: true }).click();
  const dialog = openDialog(page);
  await pickDate(dialog, appLocale, msg("Sessions.lifecycle.fields.date"), dayFromToday(3));
  await submitConfirmingConflicts(dialog, appLocale, msg("Sessions.lifecycle.save"));
  await expect(page.getByText(msg("Sessions.lifecycle.rescheduled")).or(page.getByText(msg("Sessions.status.RESCHEDULED"))).first()).toBeVisible();
  await page.getByRole("link", { name: msg("Sessions.lifecycle.viewNewSession") }).first().click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);

  // Cancel asks first (SYS) and is irreversible.
  await page.getByRole("button", { name: msg("Sessions.lifecycle.cancel"), exact: true }).click();
  const cancelDialog = openDialog(page);
  await expect(cancelDialog.getByText(msg("Sessions.lifecycle.cancelTitle"))).toBeVisible();
  await cancelDialog.getByRole("button", { name: msg("Sessions.lifecycle.cancelConfirm"), exact: true }).click();
  await expect(page.getByText(msg("Sessions.status.CANCELLED")).first()).toBeVisible();

  // A pristine future one-time session can be deleted — behind a confirmation.
  const doomed = `${uniqueTag()} Delete me`;
  await createOneOffSession(page, appLocale, doomed, dayFromToday(4));
  await page.getByRole("button", { name: msg("Sessions.deleteSession.button"), exact: true }).click();
  await openDialog(page).getByRole("button", { name: msg("Sessions.deleteSession.confirm"), exact: true }).click();
  await page.waitForURL(new RegExp(`/${appLocale}/sessions(\\?.*)?$`));
});

test("@write class: create with a weekly row and a brand-new teacher in one step, then delete both", async ({ as, appLocale, msg }) => {
  const page = await as("manager");
  const tag = uniqueTag();
  const lastName = `Teach${tag}`;
  await page.goto(`/${appLocale}/classes`);
  await page.getByRole("button", { name: msg("Classes.add"), exact: true }).click();
  const dialog = openDialog(page);

  // Teacher: New teacher (R6) — created in the same transaction as the class.
  await dialog.getByRole("button", { name: msg("Classes.newTeacher.modeNew"), exact: true }).click();
  await dialog.getByLabel(field(msg("People.fields.firstName"))).fill("Eetoo");
  await dialog.getByLabel(field(msg("People.fields.lastName"))).fill(lastName);
  await dialog.getByLabel(field(msg("People.fields.phone"))).first().fill(`010${String(Date.now()).slice(-8)}`);

  // Room (the first one), its combinable extra if offered (R3), a custom period, one weekly row.
  await choose(dialog, msg("RoomSets.room"), /.+/);
  const combine = dialog.getByRole("group", { name: msg("RoomSets.combineLabel") }).getByRole("checkbox").first();
  if (await combine.isVisible().catch(() => false)) await combine.check();
  const custom = dialog.getByRole("button", { name: msg("Classes.period.modeCustom"), exact: true });
  if (await custom.isVisible().catch(() => false)) await custom.click();
  await pickDate(dialog, appLocale, msg("Classes.period.startDate"), dayFromToday(1));
  await pickDate(dialog, appLocale, msg("Classes.period.endDate"), dayFromToday(15));
  const start = dialog.getByLabel(field(msg("Classes.schedule.start"))).first();
  await start.fill("06:00");
  await start.press("Tab");
  const end = dialog.getByLabel(field(msg("Classes.schedule.end"))).first();
  await end.fill("06:30");
  await end.press("Tab");
  await dialog.getByLabel(field(msg("Classes.fields.price"))).fill("120");

  // Under WARN a double-booking is saved only after the explicit tick (R3).
  await submitConfirmingConflicts(dialog, appLocale, msg("Classes.add"));
  await expect(dialog).toBeHidden();

  // The class lists with its new teacher; open it and delete it (it never ran).
  await page.goto(`/${appLocale}/classes`);
  const row = page.getByRole("listitem").filter({ hasText: lastName }).first();
  // DES: the row's name is its link (the separate "Open" button is gone).
  await row.locator('a[href*="/classes/"]').first().click();
  await expect(page).toHaveURL(/\/classes\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: msg("Classes.edit"), exact: true }).click();
  const edit = openDialog(page);
  await edit.getByRole("button", { name: msg("Settings.common.delete"), exact: true }).click();
  await edit.getByRole("button", { name: msg("Settings.common.deleteYes"), exact: true }).click();
  await page.waitForURL(new RegExp(`/${appLocale}/classes(\\?.*)?$`));

  // The teacher created with it has no class or session left — delete them too.
  await page.goto(`/${appLocale}/teachers`);
  await page.locator('main a[href*="/teachers/"]').filter({ hasText: lastName }).first().click();
  await page.getByRole("button", { name: msg("Settings.common.delete"), exact: true }).click();
  await page.getByRole("button", { name: msg("Settings.common.deleteYes"), exact: true }).click();
  await page.waitForURL(new RegExp(`/${appLocale}/teachers(\\?.*)?$`));
});

test("@write expense: add one, then void it with a reason", async ({ as, appLocale, msg }) => {
  const page = await as("manager");
  const note = `${uniqueTag()} expense`;
  await page.goto(`/${appLocale}/expenses`);
  await page.getByLabel(field(msg("Expenses.fields.amount"))).fill("12.50");
  await page.getByLabel(field(msg("Expenses.fields.note"))).fill(note);
  await page.getByRole("button", { name: msg("Expenses.add"), exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: note }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: msg("Expenses.void"), exact: true }).click();
  await row.getByLabel(msg("Expenses.voidReason"), { exact: true }).fill("e2e clean-up");
  await row.getByRole("button", { name: msg("Expenses.voidYes"), exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: note }).first()).toContainText(msg("Expenses.voidedBadge"));
});
