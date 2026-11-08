import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { createWorkspace, createWorkspaceClass } from "@/lib/db/workspaces";
import { formatDay, formatNumber } from "@/lib/format";
import { addDays, todayInTimezone } from "@/lib/scheduling";

import { deleteAuditRows } from "../scripts/lib/audit-maintenance";
import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail, removeE2eUsers } from "../scripts/lib/e2e-users";

import { expect, expectHealthy, test } from "./support/fixtures";
import type { AppLocale } from "./support/i18n";
import { E2E_PASSWORD, signInWith } from "./support/signup";
import { choose, dayFromToday, field, openDialog, pickDate, submitConfirmingConflicts } from "./support/ui";

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
 *
 * W8b (D-W39), the second test: a premium teacher (premium and a workspace
 * with one class set up directly, staging-guarded) adds a student by the phone
 * of a tagged student account — whose `User.phone` is set by a guarded direct
 * update, since sign-up never writes one — and enrols them; the student sees
 * the invitation on the hub, confirms, and finds the class on their calendar
 * as a "Private class"; the teacher then reads "Linked". The teardown is
 * `removeE2eUsers(db, tag)` (the workspace, its profiles, invitations and
 * enrolments go with it; an unlinked placeholder carries the tag in its
 * surname), and the run asserts nothing of it is left.
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

/** What the W8b run left behind, by its own ids and tag — never a whole-table count. */
async function studentLeftovers(db: PrismaClient, tag: string, emails: string[], userIds: string[], centerIds: string[]) {
  const [users, organizations, centers, profiles, invitations, enrollments, notifications, audit] = await Promise.all([
    db.user.count({ where: { OR: [{ email: { in: emails } }, { lastName: { contains: ` ${tag}` } }] } }),
    db.organization.count({ where: { ownerUserId: { in: userIds } } }),
    db.center.count({ where: { id: { in: centerIds } } }),
    db.studentProfile.count({ where: { OR: [{ centerId: { in: centerIds } }, { userId: { in: userIds } }] } }),
    db.workspaceInvitation.count({ where: { OR: [{ centerId: { in: centerIds } }, { targetUserId: { in: userIds } }] } }),
    db.enrollment.count({ where: { centerId: { in: centerIds } } }),
    db.notification.count({ where: { userId: { in: userIds } } }),
    db.auditLog.count({ where: { OR: [{ actorUserId: { in: userIds } }, { centerId: { in: centerIds } }] } }),
  ]);
  return { users, organizations, centers, profiles, invitations, enrollments, notifications, audit };
}

test("@write workspace students: add by phone, enrol, the student confirms on the hub and sees the private class; the teacher reads Linked", async ({
  page,
  browser,
  appLocale,
  msg,
  e2eTag,
}, testInfo) => {
  assertSafeToWrite("e2e: workspace students fixtures");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e workspace students: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  const locale: AppLocale = appLocale;
  const teacher = { email: e2eEmail(e2eTag, "ws-teacher"), first: "Wst", last: `Teacher ${e2eTag}` };
  const pupil = { email: e2eEmail(e2eTag, "ws-student"), first: "Wss", last: `Student ${e2eTag}` };
  // The name the teacher types: the profile's own local record (it carries the tag for the teardown).
  const typed = { first: "Typed", last: `Pupil ${e2eTag}` };
  const national = `011${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
  const userIds: string[] = [];
  const centerIds: string[] = [];
  const authIds: string[] = [];
  const studentContext = await browser.newContext({ ...testInfo.project.use });

  try {
    for (const person of [teacher, pupil]) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: person.email,
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: { first_name: person.first, last_name: person.last, locale },
      });
      if (error || !data.user) throw error ?? new Error("e2e workspace students: could not create a login");
      authIds.push(data.user.id);
    }
    const studentPage = await studentContext.newPage();
    // Each sign-in makes the app's own User (syncUserFromAuth: authId set, no phone).
    await signInWith(studentPage, locale, pupil.email);
    await signInWith(page, locale, teacher.email);
    const teacherRow = await db.user.findUniqueOrThrow({ where: { email: teacher.email } });
    const pupilRow = await db.user.findUniqueOrThrow({ where: { email: pupil.email } });
    userIds.push(teacherRow.id, pupilRow.id);

    // Staging-guarded setup: premium, the student's staff-typed User.phone, one workspace with one class.
    await db.user.update({ where: { id: teacherRow.id }, data: { premiumUntil: new Date(Date.now() + 30 * 86_400_000) } });
    await db.user.update({ where: { id: pupilRow.id }, data: { phone: `+20${national.slice(1)}` } });
    const workspaceName = `Biology ${e2eTag}`;
    const created = await createWorkspace(db, teacherRow.id, { name: workspaceName });
    if (!created.ok) throw new Error(`e2e workspace students: ${created.error}`);
    const workspaceId = created.workspaceId;
    centerIds.push(workspaceId);
    const today = todayInTimezone("Africa/Cairo");
    const tomorrow = addDays(today, 1);
    const klass = await createWorkspaceClass(
      db,
      teacherRow.id,
      workspaceId,
      {
        educationSystemId: null,
        gradeId: null,
        subjectId: null,
        price: 10_000,
        lateThresholdMinutes: 10,
        startDate: today,
        endDate: addDays(today, 21),
        slots: [{ dayOfWeek: tomorrow.getUTCDay(), startTime: "17:00", endTime: "18:00" }],
      },
      { confirmConflicts: true, locale },
    );
    if (!klass.ok) throw new Error(`e2e workspace students: ${klass.error}`);
    const classId = klass.classGroupId;
    const firstSession = await db.session.findFirstOrThrow({
      where: { classGroupId: classId, date: { gt: today } },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });

    // The teacher adds the student by phone: one answer, "Not linked".
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}/students`);
    await expectHealthy(page, locale);
    await page.getByRole("button", { name: msg("WorkspaceStudents.add.button"), exact: true }).first().click();
    const dialog = openDialog(page);
    await dialog.getByLabel(field(msg("People.fields.firstName"))).fill(typed.first);
    await dialog.getByLabel(field(msg("People.fields.lastName"))).fill(typed.last);
    await dialog.getByLabel(field(msg("People.fields.phone"))).fill(national);
    await dialog.getByRole("button", { name: msg("WorkspaceStudents.add.submit"), exact: true }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole("listitem").filter({ hasText: typed.last });
    await expect(card).toBeVisible();
    await expect(card.getByText(msg("WorkspaceStudents.row.notLinked"), { exact: true })).toBeVisible();

    // …and enrols them in the class.
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}/classes/${classId}`);
    await expectHealthy(page, locale);
    await choose(page, msg("WorkspaceStudents.roster.student"), `${typed.first} ${typed.last}`);
    await page.getByRole("button", { name: msg("WorkspaceStudents.roster.enrol"), exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: typed.last })).toBeVisible();

    // The student finds the invitation on the hub, with the teacher's and the workspace's names, and confirms.
    await studentPage.goto(`/${locale}/select-center`);
    await expectHealthy(studentPage, locale);
    const teacherName = `${teacher.first} ${teacher.last}`;
    await expect(studentPage.getByText(msg("WorkspaceStudents.invitation.title", { teacher: teacherName, workspace: workspaceName }))).toBeVisible();
    await studentPage.getByRole("button", { name: msg("WorkspaceStudents.invitation.confirm"), exact: true }).click();
    await studentPage.waitForURL(new RegExp(`/${locale}/student/calendar`));

    // The class is on their calendar, as a private class of that workspace.
    const day = firstSession.date.toISOString().slice(0, 10);
    await studentPage.goto(`/${locale}/student/calendar?month=${day.slice(0, 7)}&day=${day}`);
    await expectHealthy(studentPage, locale);
    await expect(studentPage.getByText(msg("WorkspaceStudents.student.privateClass"), { exact: true }).first()).toBeVisible();
    await expect(studentPage.getByText(workspaceName, { exact: true }).first()).toBeVisible();
    await expect(studentPage.getByText(teacherName, { exact: true }).first()).toBeVisible();

    // The teacher now reads "Linked" — and still the typed record, never the account's own name.
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}/students`);
    await expectHealthy(page, locale);
    const linkedCard = page.getByRole("listitem").filter({ hasText: typed.last });
    await expect(linkedCard.getByText(msg("WorkspaceStudents.row.linked"), { exact: true })).toBeVisible();
    await expect(page.getByText(pupil.last)).toHaveCount(0);
  } finally {
    await studentContext.close();
    await removeE2eUsers(db, e2eTag);
    for (const authId of authIds) {
      if ((await db.user.count({ where: { authId } })) === 0) await supabase.auth.admin.deleteUser(authId).catch(() => undefined);
    }
  }

  expect(
    await studentLeftovers(db, e2eTag, [teacher.email, pupil.email], userIds, centerIds),
    "the teardown leaves nothing of this run behind",
  ).toEqual({ users: 0, organizations: 0, centers: 0, profiles: 0, invitations: 0, enrollments: 0, notifications: 0, audit: 0 });
  await db.$disconnect();
});
