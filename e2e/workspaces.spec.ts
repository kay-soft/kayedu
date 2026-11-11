import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { acceptWorkspaceInvitation, addWorkspaceStudent, enrolWorkspaceStudent } from "@/lib/db/workspace-students";
import { createWorkspace, createWorkspaceClass, createWorkspaceSession } from "@/lib/db/workspaces";
import { createAttendance } from "@/lib/db/attendance";
import { recordPayment } from "@/lib/db/payments";
import { refundPayment } from "@/lib/db/refunds";
import { formatDay, formatMoney, formatNumber } from "@/lib/format";
import { addDays, dateKey, todayInTimezone, zonedClock } from "@/lib/scheduling";

import { deleteAuditRows } from "../scripts/lib/audit-maintenance";
import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail, removeE2eUsers } from "../scripts/lib/e2e-users";

import { expect, expectHealthy, primaryNav, test } from "./support/fixtures";
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
 *
 * W8c (D-W40), the third test: a premium teacher with a linked, enrolled
 * student and a session that started 20 minutes ago (all set up directly,
 * staging-guarded — the hub flow is the second test's) opens the session from
 * the Sessions list, checks the student in (Late, from the clock), records the
 * payment at the read-only price, voids it with a reason (the student reads
 * Not arrived), checks them in again, pays again, ends the session and reads
 * the receipt: collected = the price, centre share 0, teacher share = the
 * price. The student then sees the session on their calendar as Late, with no
 * amount. The same `removeE2eUsers` teardown; the run asserts no payment,
 * roster row, method, change row, session or audit row of it is left.
 * Skipped too close to midnight (the session must have started today).
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

/** What the W8c run left behind, by its own ids — never a whole-table count. */
async function moneyLeftovers(db: PrismaClient, tag: string, emails: string[], userIds: string[], centerIds: string[]) {
  const [users, centers, sessions, attendees, payments, methods, changes, audit] = await Promise.all([
    db.user.count({ where: { OR: [{ email: { in: emails } }, { lastName: { contains: ` ${tag}` } }] } }),
    db.center.count({ where: { id: { in: centerIds } } }),
    db.session.count({ where: { centerId: { in: centerIds } } }),
    db.sessionAttendee.count({ where: { centerId: { in: centerIds } } }),
    db.payment.count({ where: { centerId: { in: centerIds } } }),
    db.centerPaymentMethod.count({ where: { centerId: { in: centerIds } } }),
    db.sessionAttendanceChange.count({ where: { centerId: { in: centerIds } } }),
    db.auditLog.count({ where: { OR: [{ actorUserId: { in: userIds } }, { centerId: { in: centerIds } }] } }),
  ]);
  return { users, centers, sessions, attendees, payments, methods, changes, audit };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

test("@write workspace money: check in, record a payment, void it, check in again, pay, end the session and read the receipt; the student sees Late, no money", async ({
  page,
  browser,
  appLocale,
  msg,
  e2eTag,
}, testInfo) => {
  assertSafeToWrite("e2e: workspace money fixtures");
  const clock = zonedClock(new Date(), "Africa/Cairo");
  test.skip(clock.minutes < 40 || clock.minutes > 22 * 60 + 30, "needs a session that started today and is not over (Cairo time)");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e workspace money: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  const locale: AppLocale = appLocale;
  const teacher = { email: e2eEmail(e2eTag, "wsm-teacher"), first: "Wmt", last: `Teacher ${e2eTag}` };
  const pupil = { email: e2eEmail(e2eTag, "wsm-student"), first: "Wms", last: `Student ${e2eTag}` };
  const typed = { firstName: "Typed", lastName: `Payer ${e2eTag}` };
  const phone = `+2011${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
  const userIds: string[] = [];
  const centerIds: string[] = [];
  const authIds: string[] = [];
  const studentContext = await browser.newContext({ ...testInfo.project.use });
  const price = 12_000;

  try {
    for (const person of [teacher, pupil]) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: person.email,
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: { first_name: person.first, last_name: person.last, locale },
      });
      if (error || !data.user) throw error ?? new Error("e2e workspace money: could not create a login");
      authIds.push(data.user.id);
    }
    const studentPage = await studentContext.newPage();
    await signInWith(studentPage, locale, pupil.email);
    await signInWith(page, locale, teacher.email);
    const teacherRow = await db.user.findUniqueOrThrow({ where: { email: teacher.email } });
    const pupilRow = await db.user.findUniqueOrThrow({ where: { email: pupil.email } });
    userIds.push(teacherRow.id, pupilRow.id);

    // Staging-guarded setup: premium, a workspace, a class, the linked enrolled student, a session 20 minutes in.
    await db.user.update({ where: { id: teacherRow.id }, data: { premiumUntil: new Date(Date.now() + 30 * 86_400_000) } });
    await db.user.update({ where: { id: pupilRow.id }, data: { phone } });
    const workspaceName = `Chemistry ${e2eTag}`;
    const created = await createWorkspace(db, teacherRow.id, { name: workspaceName });
    if (!created.ok) throw new Error(`e2e workspace money: ${created.error}`);
    const workspaceId = created.workspaceId;
    centerIds.push(workspaceId);
    const today = todayInTimezone("Africa/Cairo");
    const klass = await createWorkspaceClass(
      db,
      teacherRow.id,
      workspaceId,
      {
        educationSystemId: null,
        gradeId: null,
        subjectId: null,
        price,
        lateThresholdMinutes: 10,
        startDate: today,
        endDate: addDays(today, 21),
        slots: [{ dayOfWeek: addDays(today, 1).getUTCDay(), startTime: "17:00", endTime: "18:00" }],
      },
      { confirmConflicts: true, locale },
    );
    if (!klass.ok) throw new Error(`e2e workspace money: ${klass.error}`);
    const added = await addWorkspaceStudent(db, teacherRow.id, workspaceId, { ...typed, phone, gradeId: null });
    if (!added.ok) throw new Error(`e2e workspace money: ${added.error}`);
    const invitation = await db.workspaceInvitation.findFirstOrThrow({ where: { centerId: workspaceId, targetUserId: pupilRow.id, status: "PENDING" } });
    const accepted = await acceptWorkspaceInvitation(db, pupilRow.id, invitation.id);
    if (!accepted.ok) throw new Error(`e2e workspace money: ${accepted.error}`);
    await enrolWorkspaceStudent(db, teacherRow.id, workspaceId, klass.classGroupId, added.studentProfileId);
    const start = Math.floor((clock.minutes - 20) / 5) * 5;
    const session = await createWorkspaceSession(
      db,
      teacherRow.id,
      workspaceId,
      { kind: "extra", classGroupId: klass.classGroupId, date: today, startTime: hhmm(start), endTime: hhmm(Math.min(start + 120, 23 * 60 + 55)) },
      { confirmConflicts: true, locale },
    );
    if (!session.ok) throw new Error(`e2e workspace money: ${"error" in session ? session.error : "session"}`);
    const sessionId = session.sessionId;

    // The session page, from the Sessions list.
    await page.goto(`/${locale}/teacher/workspaces/${workspaceId}/sessions`);
    await expectHealthy(page, locale);
    await page.locator(`a[href$="/teacher/workspaces/${workspaceId}/sessions/${sessionId}"]`).first().click();
    await page.waitForURL(new RegExp(`/${locale}/teacher/workspaces/${workspaceId}/sessions/${sessionId}$`));
    await expectHealthy(page, locale);
    const row = page.getByRole("listitem").filter({ hasText: typed.lastName });
    await expect(row.getByText(msg("WorkspaceSession.notCheckedIn"), { exact: true })).toBeVisible();

    // Check in: Late (20 minutes in, a 10-minute threshold). The amount is read-only.
    await row.getByRole("button", { name: msg("Sessions.roster.checkIn"), exact: true }).click();
    await expect(row.getByText(msg("Sessions.attendance.LATE"), { exact: true }).first()).toBeVisible();
    await expect(row.getByText(msg("WorkspaceSession.amount", { amount: formatMoney(price, locale) }))).toBeVisible();
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await row.getByRole("button", { name: msg("Sessions.roster.recordPayment"), exact: true }).click();
    const paidText = msg("Sessions.roster.paid", { amount: formatMoney(price, locale), method: "Cash" });
    await expect(row.getByText(paidText)).toBeVisible();

    // Void it, with a reason: the student goes back to Not arrived.
    await row.getByRole("button", { name: msg("Sessions.roster.void"), exact: true }).click();
    await row.getByLabel(msg("Sessions.roster.voidReasonPlaceholder")).fill("Recorded twice");
    await row.getByRole("button", { name: msg("Sessions.roster.confirmVoid"), exact: true }).click();
    await expect(row.getByText(msg("Sessions.attendance.NOT_ARRIVED"), { exact: true })).toBeVisible();

    // Check in again and pay again — a new payment at the same frozen price.
    await row.getByRole("button", { name: msg("Sessions.roster.checkIn"), exact: true }).click();
    await expect(row.getByText(msg("Sessions.attendance.LATE"), { exact: true }).first()).toBeVisible();
    await row.getByRole("button", { name: msg("Sessions.roster.recordPayment"), exact: true }).click();
    await expect(row.getByText(paidText)).toBeVisible();

    // End the session: closed, and the receipt reads collected = teacher share = the price, centre share 0.
    await page.getByRole("button", { name: msg("Sessions.endSession.button"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("Sessions.endSession.confirm"), exact: true }).click();
    await expect(page.getByText(msg("Sessions.closure.locked"))).toBeVisible();
    const receipt = page.locator("dl").filter({ hasText: msg("Sessions.receipt.collected") }).first();
    const line = (label: string) => receipt.locator("div").filter({ hasText: label }).first();
    await expect(line(msg("Sessions.receipt.collected"))).toContainText(formatMoney(price, locale));
    await expect(line(msg("Sessions.receipt.teacherShare"))).toContainText(formatMoney(price, locale));
    await expect(line(msg("Sessions.receipt.centerShare"))).toContainText(formatMoney(0, locale));
    await expect(page.getByRole("button", { name: msg("Sessions.roster.checkIn"), exact: true })).toHaveCount(0);
    const payments = await db.payment.findMany({ where: { centerId: workspaceId }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] });
    expect(
      payments.map((payment) => [payment.amount, payment.centerShareSnapshot, payment.teacherShareSnapshot, payment.voided]),
      "two payments, the first voided, both 100% the teacher's",
    ).toEqual([
      [price, 0, price, true],
      [price, 0, price, false],
    ]);

    // The student sees the session on their calendar as Late — and no amount.
    const day = dateKey(today);
    await studentPage.goto(`/${locale}/student/calendar?month=${day.slice(0, 7)}&day=${day}`);
    await expectHealthy(studentPage, locale);
    const entry = studentPage.getByRole("listitem").filter({ hasText: workspaceName }).first();
    await expect(entry).toBeVisible();
    await expect(entry.getByText(msg("Calendar.tone.late"), { exact: true })).toBeVisible();
    await expect(entry.getByText(msg("WorkspaceStudents.student.privateClass"), { exact: true })).toBeVisible();
    await expect(studentPage.getByText(formatMoney(price, locale))).toHaveCount(0);
  } finally {
    await studentContext.close();
    await removeE2eUsers(db, e2eTag);
    for (const authId of authIds) {
      if ((await db.user.count({ where: { authId } })) === 0) await supabase.auth.admin.deleteUser(authId).catch(() => undefined);
    }
  }

  expect(
    await moneyLeftovers(db, e2eTag, [teacher.email, pupil.email], userIds, centerIds),
    "the teardown leaves nothing of this run behind",
  ).toEqual({ users: 0, centers: 0, sessions: 0, attendees: 0, payments: 0, methods: 0, changes: 0, audit: 0 });
  await db.$disconnect();
});

/**
 * W8d (D-W41), the fourth test: a workspace-only premium teacher (premium, a
 * workspace, a class and two typed students set up directly, staging-guarded)
 * with three payments of 120 EGP frozen on two past sessions — one refunded —
 * opens Earnings from the minimal shell's nav and reads exactly the frozen
 * snapshots: Collected 240 (360 − 120), Refunded 120 on its own, one paid
 * session, three present, and the workspace's card tagged Private with
 * "collected only". The same `removeE2eUsers` teardown and leftover check.
 */
test("@write workspace earnings: the teacher opens Earnings and reads the frozen snapshots — collected, refunded apart, the Private workspace card", async ({
  page,
  appLocale,
  msg,
  e2eTag,
}) => {
  assertSafeToWrite("e2e: workspace earnings fixtures");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e workspace earnings: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  const locale: AppLocale = appLocale;
  const teacher = { email: e2eEmail(e2eTag, "wse-teacher"), first: "Wet", last: `Teacher ${e2eTag}` };
  const userIds: string[] = [];
  const centerIds: string[] = [];
  const authIds: string[] = [];
  const price = 12_000;

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email: teacher.email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { first_name: teacher.first, last_name: teacher.last, locale },
    });
    if (error || !data.user) throw error ?? new Error("e2e workspace earnings: could not create a login");
    authIds.push(data.user.id);
    await signInWith(page, locale, teacher.email);
    const teacherRow = await db.user.findUniqueOrThrow({ where: { email: teacher.email } });
    userIds.push(teacherRow.id);

    // Staging-guarded setup: premium, a workspace and a class, two typed students, two past sessions.
    await db.user.update({ where: { id: teacherRow.id }, data: { premiumUntil: new Date(Date.now() + 30 * 86_400_000) } });
    const workspaceName = `Biology ${e2eTag}`;
    const created = await createWorkspace(db, teacherRow.id, { name: workspaceName });
    if (!created.ok) throw new Error(`e2e workspace earnings: ${created.error}`);
    const workspaceId = created.workspaceId;
    centerIds.push(workspaceId);
    const today = todayInTimezone("Africa/Cairo");
    const klass = await createWorkspaceClass(
      db,
      teacherRow.id,
      workspaceId,
      {
        educationSystemId: null,
        gradeId: null,
        subjectId: null,
        price,
        lateThresholdMinutes: 10,
        startDate: today,
        endDate: addDays(today, 21),
        slots: [{ dayOfWeek: addDays(today, 1).getUTCDay(), startTime: "17:00", endTime: "18:00" }],
      },
      { confirmConflicts: true, locale },
    );
    if (!klass.ok) throw new Error(`e2e workspace earnings: ${klass.error}`);
    const profiles: string[] = [];
    for (const suffix of ["One", "Two"]) {
      const phone = `+2012${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
      const added = await addWorkspaceStudent(db, teacherRow.id, workspaceId, { firstName: "Typed", lastName: `Earner${suffix} ${e2eTag}`, phone, gradeId: null });
      if (!added.ok) throw new Error(`e2e workspace earnings: ${added.error}`);
      profiles.push(added.studentProfileId);
    }
    const method = await db.centerPaymentMethod.findFirstOrThrow({ where: { centerId: workspaceId, active: true } });
    const pastSession = (ago: number) =>
      db.session.create({
        data: {
          centerId: workspaceId,
          classGroupId: klass.classGroupId,
          teacherId: teacherRow.id,
          date: addDays(today, -ago),
          startTime: "10:00",
          endTime: "11:00",
          priceSnapshot: price,
        },
      });
    const pay = async (sessionId: string, profileId: string) => {
      const attendee = await createAttendance(
        db,
        { centerId: workspaceId, sessionId, studentProfileId: profileId, enrollmentId: null, isDropIn: false, recordedBy: teacherRow.id },
        { historicalBackfill: true, status: "PRESENT" },
      );
      const result = await db.$transaction((tx) => recordPayment(tx, workspaceId, attendee.id, method.id, teacherRow.id, { historicalBackfill: true }));
      if (!result.ok) throw new Error(`e2e workspace earnings: ${result.error}`);
      return result.payment;
    };
    const yesterday = await pastSession(1);
    const earlier = await pastSession(3);
    await pay(yesterday.id, profiles[0]);
    await pay(yesterday.id, profiles[1]);
    const toRefund = await pay(earlier.id, profiles[0]);
    const refunded = await db.$transaction((tx) => refundPayment(tx, workspaceId, toRefund.id, "Left early", teacherRow.id, { historicalBackfill: true }));
    if (!refunded.ok) throw new Error(`e2e workspace earnings: ${refunded.error}`);

    // Earnings from the minimal shell's nav (a workspace-only teacher lands on Workspaces).
    await page.goto(`/${locale}/teacher/workspaces`);
    await expectHealthy(page, locale);
    const nav = await primaryNav(page, locale);
    await nav.getByRole("link", { name: msg("Nav.earnings"), exact: true }).click();
    await page.waitForURL(new RegExp(`/${locale}/teacher/earnings$`));
    await expectHealthy(page, locale);
    await expect(page.getByRole("heading", { name: msg("Earnings.title"), exact: true }).first()).toBeVisible();

    const tile = (label: string) => page.locator("div.rounded-xl").filter({ has: page.getByText(label, { exact: true }) }).first();
    await expect(tile(msg("Earnings.stats.collected"))).toContainText(formatMoney(2 * price, locale));
    await expect(tile(msg("Earnings.stats.refunded"))).toContainText(formatMoney(price, locale));
    await expect(tile(msg("Earnings.stats.paidSessions"))).toContainText(formatNumber(1, locale));
    await expect(tile(msg("Earnings.stats.present"))).toContainText(formatNumber(3, locale));
    const card = page.locator("[data-slot='card']").filter({ has: page.getByRole("heading", { name: new RegExp(escapeRegExp(workspaceName)) }) }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(msg("Earnings.workspaces.private"), { exact: true })).toBeVisible();
    await expect(card.getByText(msg("Earnings.workspaces.collectedOnly"))).toBeVisible();
    await expect(card).toContainText(formatMoney(3 * price, locale));
    // No branch section and no paid-out figure for a workspace-only teacher; no student named.
    await expect(page.getByText(msg("Earnings.branches.paidOut"), { exact: true })).toHaveCount(0);
    await expect(page.getByText(`EarnerOne ${e2eTag}`)).toHaveCount(0);
  } finally {
    await removeE2eUsers(db, e2eTag);
    for (const authId of authIds) {
      if ((await db.user.count({ where: { authId } })) === 0) await supabase.auth.admin.deleteUser(authId).catch(() => undefined);
    }
  }

  expect(
    await moneyLeftovers(db, e2eTag, [teacher.email], userIds, centerIds),
    "the teardown leaves nothing of this run behind",
  ).toEqual({ users: 0, centers: 0, sessions: 0, attendees: 0, payments: 0, methods: 0, changes: 0, audit: 0 });
  await db.$disconnect();
});
