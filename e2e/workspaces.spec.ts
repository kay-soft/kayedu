import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { formatDay, formatNumber } from "@/lib/format";

import { deleteAuditRows } from "../scripts/lib/audit-maintenance";
import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail, removeE2eUsers } from "../scripts/lib/e2e-users";

import { expect, expectHealthy, test } from "./support/fixtures";
import type { AppLocale } from "./support/i18n";
import { E2E_PASSWORD, signInWith } from "./support/signup";
import { dayFromToday, field, openDialog, pickDate, submitConfirmingConflicts } from "./support/ui";

/**
 * PERSONAL workspaces (W8a, D-W38): a platform admin gives a tagged fixture
 * account premium; the teacher creates a workspace and a class with a weekly
 * row, sees its generated sessions, reschedules one and cancels another,
 * archives and unarchives the workspace; the admin revokes premium and the
 * workspace reads "Read-only — renew premium to make changes" with no write
 * control left. The login is made through the Supabase admin API (no per-IP
 * sign-up limit), so it runs in `en-1280` and `ar-375`, each with its own
 * account. The teardown deletes the account — `removeE2eUsers` removes its
 * workspace centres and personal organization first (their membership, room,
 * class and sessions cascade) — and the run asserts nothing of it is left.
 * Everything rule-level is `check:workspaces`.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What this run left behind, by its own ids — never a whole-table count (the two projects run in parallel). */
async function leftovers(db: PrismaClient, email: string, userIds: string[], centerIds: string[]) {
  const [users, organizations, centers, memberships, classes, sessions, audit] = await Promise.all([
    db.user.count({ where: { email } }),
    db.organization.count({ where: { ownerUserId: { in: userIds } } }),
    db.center.count({ where: { id: { in: centerIds } } }),
    db.membership.count({ where: { OR: [{ userId: { in: userIds } }, { centerId: { in: centerIds } }] } }),
    db.classGroup.count({ where: { centerId: { in: centerIds } } }),
    db.session.count({ where: { centerId: { in: centerIds } } }),
    db.auditLog.count({ where: { OR: [{ actorUserId: { in: userIds } }, { centerId: { in: centerIds } }, { entityId: { in: userIds } }] } }),
  ]);
  return { users, organizations, centers, memberships, classes, sessions, audit };
}

async function lookUp(admin: Page, msg: (key: string, values?: Record<string, string | number>) => string, email: string, last: string) {
  await admin.getByLabel(field(msg("AdminPremium.lookup.label"))).fill(email);
  await admin.getByRole("button", { name: msg("AdminPremium.lookup.submit"), exact: true }).click();
  const match = admin.getByRole("heading", { name: new RegExp(escapeRegExp(last)) });
  await expect(match).toBeVisible();
  return match;
}

test("@write workspaces: premium teacher creates a workspace and a class, sessions, archive and unarchive, read-only on revoke", async ({
  page,
  appLocale,
  msg,
  as,
  e2eTag,
}) => {
  assertSafeToWrite("e2e: workspaces fixtures");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e workspaces: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  const person = { email: e2eEmail(e2eTag, "workspace-teacher"), first: "Wor", last: `Teacher ${e2eTag}` };
  const userIds: string[] = [];
  const centerIds: string[] = [];
  let authId: string | null = null;
  const locale: AppLocale = appLocale;

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: person.email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { first_name: person.first, last_name: person.last, locale },
    });
    if (error || !data.user) throw error ?? new Error("e2e workspaces: could not create a login");
    authId = data.user.id;
    await signInWith(page, locale, person.email);
    const teacher = await db.user.findUniqueOrThrow({ where: { email: person.email } });
    userIds.push(teacher.id);

    // Not premium: the premium card, no New workspace.
    await page.goto(`/${locale}/teacher/workspaces`);
    await expectHealthy(page, locale);
    await expect(page.getByText(msg("Workspaces.list.premiumTitle"))).toBeVisible();
    await expect(page.getByRole("button", { name: msg("Workspaces.list.new"), exact: true })).toHaveCount(0);

    // The platform admin grants premium (the W6 page).
    const admin = await as("admin");
    await admin.goto(`/${locale}/admin/teachers`);
    const match = await lookUp(admin, msg, person.email, person.last);
    const end = dayFromToday(30);
    await pickDate(admin, locale, msg("AdminPremium.grant.label"), end);
    await admin.getByRole("button", { name: msg("AdminPremium.grant.submit"), exact: true }).click();
    await expect(match).toContainText(msg("Premium.status.active", { date: formatDay(end, locale) }));

    // Create a workspace: its page opens.
    await page.reload();
    await expectHealthy(page, locale);
    await expect(page.getByText(msg("Workspaces.list.count", { active: formatNumber(0, locale), max: formatNumber(100, locale) }))).toBeVisible();
    await page.getByRole("button", { name: msg("Workspaces.list.new"), exact: true }).click();
    let dialog = openDialog(page);
    const name = `Physics ${e2eTag}`;
    await dialog.getByLabel(field(msg("Workspaces.create.name"))).fill(name);
    await dialog.getByRole("button", { name: msg("Workspaces.create.submit"), exact: true }).click();
    await page.waitForURL(new RegExp(`/${locale}/teacher/workspaces/[0-9a-f-]{36}$`));
    await expectHealthy(page, locale);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const workspaceId = page.url().split("/").pop()!;
    centerIds.push(workspaceId);

    // A class with one weekly row (Saturday, the default), over three weeks.
    await page.getByRole("button", { name: msg("Workspaces.classes.new"), exact: true }).click();
    dialog = openDialog(page);
    await pickDate(dialog, locale, msg("Classes.period.startDate"), dayFromToday(1));
    await pickDate(dialog, locale, msg("Classes.period.endDate"), dayFromToday(22));
    const start = dialog.getByLabel(field(msg("Classes.schedule.start"))).first();
    await start.fill("18:00");
    await start.press("Tab");
    const finish = dialog.getByLabel(field(msg("Classes.schedule.end"))).first();
    await finish.fill("19:00");
    await finish.press("Tab");
    await dialog.getByLabel(field(msg("Classes.fields.price"))).fill("100");
    await submitConfirmingConflicts(dialog, locale, msg("Workspaces.classes.create"));
    await expect(dialog).toBeHidden();
    await expect(page.locator(`a[href*="/teacher/workspaces/${workspaceId}/classes/"]`).first()).toBeVisible();

    // Its generated sessions; reschedule one and cancel another.
    await page.getByRole("link", { name: msg("Workspaces.tabs.sessions"), exact: true }).click();
    await page.waitForURL(new RegExp(`/${locale}/teacher/workspaces/${workspaceId}/sessions$`));
    await expectHealthy(page, locale);
    // Session cards are the list items carrying the session verbs (the tab pills are list items too).
    const rescheduleName = msg("Workspaces.sessions.reschedule");
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: rescheduleName, exact: true }) });
    await expect(cards.first()).toBeVisible();
    expect(await cards.count(), "the weekly row generated sessions").toBeGreaterThanOrEqual(3);
    await cards.first().getByRole("button", { name: msg("Workspaces.sessions.reschedule"), exact: true }).click();
    dialog = openDialog(page);
    const newStart = dialog.getByLabel(field(msg("Workspaces.sessions.start"))).first();
    await newStart.fill("10:00");
    await newStart.press("Tab");
    const newEnd = dialog.getByLabel(field(msg("Workspaces.sessions.end"))).first();
    await newEnd.fill("11:00");
    await newEnd.press("Tab");
    await submitConfirmingConflicts(dialog, locale, msg("Workspaces.sessions.reschedule"));
    await expect(dialog).toBeHidden();
    // The replacement says where it came from (U2); the moved original is not listed.
    const movedPrefix = msg("Sessions.movedFrom", { date: "@@", time: "@@" }).split("@@")[0].trim();
    await expect(page.getByText(new RegExp(`^${escapeRegExp(movedPrefix)}`)).first()).toBeVisible();
    const toCancel = cards.nth(1);
    await toCancel.getByRole("button", { name: msg("Workspaces.sessions.cancelSession"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("Workspaces.sessions.cancelSession"), exact: true }).click();
    await expect(page.getByText(msg("Sessions.status.CANCELLED"), { exact: true }).first()).toBeVisible();

    // Archive (confirmed): read-only, the banner; then unarchive.
    await page.getByRole("link", { name: msg("Workspaces.tabs.settings"), exact: true }).click();
    await page.waitForURL(new RegExp(`/${locale}/teacher/workspaces/${workspaceId}/settings$`));
    await page.getByRole("button", { name: msg("Workspaces.settings.archive"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("Workspaces.settings.archiveConfirm"), exact: true }).click();
    await expect(page.getByText(msg("Workspaces.workspace.archivedBanner"))).toBeVisible();
    await page.getByRole("button", { name: msg("Workspaces.settings.unarchive"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("Workspaces.settings.unarchiveConfirm"), exact: true }).click();
    await expect(page.getByText(msg("Workspaces.workspace.archivedBanner"))).toHaveCount(0);

    // The admin revokes premium: the workspace reads read-only, with no write control.
    await admin.goto(`/${locale}/admin/teachers`);
    const revoked = await lookUp(admin, msg, person.email, person.last);
    await admin.getByRole("button", { name: msg("AdminPremium.revoke.trigger"), exact: true }).click();
    await openDialog(admin).getByRole("button", { name: msg("AdminPremium.revoke.confirm"), exact: true }).click();
    // The revoke has landed before the teacher's next request.
    await expect(revoked).toContainText(msg("Premium.status.none"));
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}`);
    await expectHealthy(page, locale);
    await expect(page.getByText(msg("Workspaces.workspace.lapsedBanner"))).toBeVisible();
    await expect(page.getByRole("button", { name: msg("Workspaces.classes.new"), exact: true })).toHaveCount(0);
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}/sessions`);
    await expect(page.getByRole("button", { name: msg("Workspaces.sessions.reschedule"), exact: true })).toHaveCount(0);
    await expect(page.getByText(msg("Sessions.status.CANCELLED"), { exact: true }).first(), "reads continue while lapsed").toBeVisible();
  } finally {
    const users = await db.user.findMany({ where: { email: person.email }, select: { id: true } });
    const ids = users.map((user) => user.id);
    if (ids.length > 0) {
      await deleteAuditRows(db, { actorUserId: { in: ids } });
      await deleteAuditRows(db, { action: { startsWith: "platform.premium." }, entityType: "User", entityId: { in: ids } });
    }
    await removeE2eUsers(db, e2eTag);
    if (authId && users.length === 0) await supabase.auth.admin.deleteUser(authId);
  }

  expect(await leftovers(db, person.email, userIds, centerIds), "the teardown leaves nothing of this run behind").toEqual({
    users: 0,
    organizations: 0,
    centers: 0,
    memberships: 0,
    classes: 0,
    sessions: 0,
    audit: 0,
  });
  await db.$disconnect();
});
