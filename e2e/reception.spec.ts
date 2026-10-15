import type { Page } from "@playwright/test";

import { uniqueTag } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { t, tPattern, type AppLocale } from "./support/i18n";
import { choose, field, dayFromToday, openDialog, pickDate, submitConfirmingConflicts } from "./support/ui";

/**
 * Journey 4 — the receptionist (SYS Part A): the desk (session mode, scan or
 * search, confirm, auto Present/Late), add a student, the roster's
 * absent-switch that voids a payment, End session, and the receipt + print.
 * The profit denial (spec §7 criterion 9) by URL.
 */

test("the desk renders, a search finds a seeded student, and profit pages refuse the receptionist", async ({ as, appLocale, msg }) => {
  const page = await as("receptionist");
  await page.goto(`/${appLocale}/reception`);
  await expectHealthy(page, appLocale);
  await expect(page.getByText(msg("Reception.liveRailTitle"), { exact: true })).toBeVisible();
  const search = page.getByRole("combobox", { name: msg("Reception.searchLabel") }).or(page.getByLabel(msg("Reception.searchLabel"))).first();
  await search.fill("Youssef");
  await expect(page.getByText(/Youssef/).first()).toBeVisible();

  for (const route of ["/analytics", "/settlements", "/refunds", "/expenses", "/approvals", "/settings"]) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page, `${route} is not the receptionist's`).not.toHaveURL(new RegExp(`/${appLocale}${route}$`));
  }
});

/** "HH:mm" in Cairo, `offsetMinutes` from now - clamped to the same Cairo day (00:00-23:59). */
function cairoTime(offsetMinutes: number): string {
  const format = (at: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const now = format(new Date());
  const shifted = format(new Date(Date.now() + offsetMinutes * 60_000));
  // A shift that crossed midnight wrapped round the clock: stay on today's side of it.
  if (offsetMinutes < 0 && shifted > now) return "00:00";
  if (offsetMinutes > 0 && shifted < now) return "23:59";
  return shifted;
}

async function createLiveOneOff(page: Page, locale: AppLocale, title: string) {
  const tr = (key: string) => t(locale, key);
  await page.goto(`/${locale}/sessions`);
  await page.getByRole("button", { name: tr("Sessions.newSession.button"), exact: true }).click();
  const dialog = openDialog(page);
  await dialog.getByRole("button", { name: tr("Sessions.newSession.modeOneOff"), exact: true }).click();
  await dialog.getByLabel(tr("Sessions.newSession.titleField"), { exact: true }).fill(title);
  await choose(dialog, tr("Classes.fields.teacher"), /.+/);
  await pickDate(dialog, locale, tr("Sessions.newSession.date"), dayFromToday(0));
  const start = dialog.getByLabel(tr("Sessions.newSession.startTime"), { exact: true });
  await start.fill(cairoTime(-15));
  await start.press("Tab");
  const end = dialog.getByLabel(tr("Sessions.newSession.endTime"), { exact: true });
  await end.fill(cairoTime(45));
  await end.press("Tab");
  await choose(dialog, tr("RoomSets.room"), /.+/);
  await dialog.getByLabel(tr("Classes.fields.price"), { exact: true }).fill("100");
  await submitConfirmingConflicts(dialog, locale, tr("Sessions.newSession.submit"));
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);
  return page.url();
}

test("@write the daily loop: register, check in, switch to Absent (voids), end, receipt, print", async ({ as, appLocale, msg }) => {
  // The session is live from (now - 15 min, clamped to 00:00) to (now + 45 min,
  // clamped to 23:59), all on today's Cairo date, so any hour works - except
  // the last minutes of the day, when the session would end under the test.
  const nowCairo = cairoTime(0);
  test.skip(nowCairo > "23:49", "needs a few minutes before Cairo midnight for a live session to survive the run");

  // A live one-time session of our own (a manager adds it — reception cannot).
  const manager = await as("manager");
  const title = `${uniqueTag()} Desk`;
  const sessionUrl = await createLiveOneOff(manager, appLocale, title);
  const sessionPath = new URL(sessionUrl).pathname;

  // The receptionist registers a brand-new student (unique name and phone).
  const desk = await as("receptionist");
  const last = uniqueTag("Lst");
  await desk.goto(`/${appLocale}/students`);
  await desk.getByRole("button", { name: msg("Students.add"), exact: true }).click();
  const add = openDialog(desk);
  await add.getByLabel(field(msg("People.fields.firstName"))).fill("Eetoo");
  await add.getByLabel(field(msg("People.fields.lastName"))).fill(last);
  await add.getByLabel(field(msg("People.fields.phone"))).fill(`015${String(Date.now()).slice(-8)}`);
  await choose(add, msg("Students.fields.grade"), /.+/);
  await add.getByRole("button", { name: msg("Students.add"), exact: true }).click();
  await expect(add).toBeHidden();

  // Session-first check-in at the desk.
  await desk.goto(`/${appLocale}/reception`);
  const card = desk.getByRole("listitem").filter({ hasText: title }).or(desk.getByRole("article").filter({ hasText: title })).first();
  await card.getByRole("link", { name: msg("Reception.card.startAttending") }).or(card.getByRole("button", { name: msg("Reception.card.startAttending") })).first().click();
  await expect(desk.getByText(msg("Reception.sessionMode.attending")).first()).toBeVisible();
  const input = desk.getByPlaceholder(msg("Reception.sessionMode.placeholder"));
  await input.fill(last);
  await desk.getByText(new RegExp(last)).first().click();
  await desk.getByRole("button", { name: msg("Reception.submit"), exact: true }).click();
  // Attendance and payment are one action — wait for its answer before leaving the page.
  await expect(desk.getByText(tPattern(appLocale, "Reception.sessionMode.checkedInAs")).first()).toBeVisible();

  // A receptionist cannot correct attendance (no `attendance.correct` /
  // `payment.void` in the baseline, spec §3) — the roster's buttons are off.
  await desk.goto(sessionPath);
  const deskRow = desk.getByRole("listitem").filter({ hasText: last }).first();
  await expect(deskRow.getByRole("button", { name: msg("Sessions.attendance.ABSENT"), exact: true })).toBeDisabled();

  // The manager switches the paid student to Absent: the payment is voided, with a reason.
  await manager.goto(sessionPath);
  const row = manager.getByRole("listitem").filter({ hasText: last }).first();
  await row.getByRole("button", { name: msg("Sessions.attendance.ABSENT"), exact: true }).click();
  const voidDialog = openDialog(manager);
  await voidDialog.getByLabel(field(msg("Sessions.roster.voidDialog.reasonLabel"))).fill("e2e: checked in by mistake");
  await voidDialog.getByRole("button", { name: msg("Sessions.roster.voidDialog.confirm"), exact: true }).click();
  await expect(manager.getByText(msg("Sessions.receipt.paymentVoided")).first()).toBeVisible();

  // Back at the desk: End session (session.close is the receptionist's) — irreversible, confirmed.
  await desk.reload();

  // End session — irreversible, behind a confirmation.
  await desk.getByRole("button", { name: msg("Sessions.endSession.button"), exact: true }).first().click();
  await openDialog(desk).getByRole("button", { name: msg("Sessions.endSession.confirm"), exact: true }).click();
  await expect(desk.getByText(msg("Sessions.closure.locked")).first()).toBeVisible();
  await expect(desk.getByText(new RegExp(t(appLocale, "Sessions.receipt.voidsTitle"))).first()).toBeVisible();

  // The print view renders on its own.
  await desk.goto(`${sessionPath}/print`.replace(`/${appLocale}/sessions`, `/${appLocale}/sessions`));
  await expectHealthy(desk, appLocale);
});
