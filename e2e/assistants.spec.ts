import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { formatDay } from "@/lib/format";

import { deleteAuditRows } from "../scripts/lib/audit-maintenance";
import { E2E_ASSESSMENT_PREFIX, removeE2eAssessments } from "../scripts/lib/e2e-assessments";
import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail, removeE2eUsers } from "../scripts/lib/e2e-users";

import { ACCOUNTS, SEED } from "./support/accounts";
import { closeNav, expect, expectHealthy, primaryNav, test } from "./support/fixtures";
import { t, type AppLocale } from "./support/i18n";
import { E2E_PASSWORD, signInWith } from "./support/signup";
import { choose, dayFromToday, field, openDialog, pickDate } from "./support/ui";

/**
 * Assistants (W7a, D-W36): a platform admin gives a tagged fixture teacher
 * premium; the teacher creates an invite and reads the code once; a second
 * tagged account (a teacher at the same branch, so it has two experiences)
 * redeems it after a confirmation, switches into "Assistant of <teacher>" and
 * sees the granted permissions there and on Account settings; the teacher
 * removes the assistant, and the assistant's route is gone on its next
 * request. Both logins are made through the Supabase admin API (no per-IP
 * sign-up limit), so it runs in `en-1280` and `ar-375`. The teardown deletes
 * both accounts (cascading their membership, invites, links and grants) and
 * their audit rows, and the run checks the row counts came back to where they
 * started. Everything rule-level is `check:assistants`.
 *
 * W7b (D-W37), a second journey: a platform admin gives the seeded
 * teacher.downtown premium (restored at teardown); a tagged assistant account
 * redeems the teacher's invite, builds and publishes an exam in the teacher's
 * class, opens its results and files a new-session request (a reschedule
 * request does not exist for the teacher either — backlog); the manager sees it
 * in the approvals queue and the audit log as the teacher's, "via assistant",
 * never the assistant; the manager turns "Allow teacher assistants" off and
 * the assistant loses Downtown on the next request. The two `@write` projects
 * take turns on a lock (it changes shared seed state), and the teardown
 * restores the premium and the setting and removes the run's rows by tag.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openSwitcher(page: Page, locale: AppLocale) {
  await page
    .getByRole("banner")
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(t(locale, "Experiences.triggerNoCurrent"))}`) })
    .click();
  const sheet = page.getByRole("dialog", { name: t(locale, "Experiences.title") });
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * What this run left behind, by its own ids and emails — never a whole-table
 * count: `en-1280` and `ar-375` run in parallel, so a total would include the
 * other project's rows in flight. (Whole-table counts across two sequential
 * runs are compared by hand; `docs/staging.md`.)
 */
async function leftovers(db: PrismaClient, emails: string[], ids: string[]) {
  const mine = { in: ids };
  const [users, invites, links, memberships, audit] = await Promise.all([
    db.user.count({ where: { email: { in: emails } } }),
    db.assistantInvite.count({ where: { OR: [{ teacherUserId: mine }, { usedByUserId: mine }] } }),
    db.teacherAssistant.count({ where: { OR: [{ teacherUserId: mine }, { assistantUserId: mine }] } }),
    db.membership.count({ where: { userId: mine } }),
    db.auditLog.count({ where: { OR: [{ actorUserId: mine }, { entityId: mine }] } }),
  ]);
  return { users, invites, links, memberships, audit };
}

/**
 * The redemption limiter counts per account and per client IP (10 an hour). The
 * local dev server sees every e2e request from one address, so a journey run a
 * few times an hour would refuse itself: it clears the assistant-join buckets
 * before and after (staging or local only — `assertSafeToWrite` above).
 */
async function resetJoinLimits(db: PrismaClient) {
  await db.rateLimitBucket.deleteMany({
    where: { OR: [{ key: { startsWith: "assistantJoinPerIp:" } }, { key: { startsWith: "assistantJoinPerUser:" } }] },
  });
}

test("@write assistants: premium teacher invites, an account confirms the code, switches in, the teacher removes it", async ({
  browser,
  page,
  appLocale,
  msg,
  as,
  e2eTag,
}, testInfo) => {
  assertSafeToWrite("e2e: assistants fixtures");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e assistants: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  await resetJoinLimits(db);
  const fixtureIds: string[] = [];

  const people = {
    teacher: { email: e2eEmail(e2eTag, "teacher"), first: "Tea", last: `Teacher ${e2eTag}` },
    assistant: { email: e2eEmail(e2eTag, "assistant"), first: "Asi", last: `Assistant ${e2eTag}` },
  };
  const authIds: string[] = [];
  const assistantContext = await browser.newContext({ ...testInfo.project.use });

  try {
    for (const person of Object.values(people)) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: person.email,
        password: E2E_PASSWORD,
        email_confirm: true,
        user_metadata: { first_name: person.first, last_name: person.last, locale: appLocale },
      });
      if (error || !data.user) throw error ?? new Error("e2e assistants: could not create a login");
      authIds.push(data.user.id);
    }

    // Each signs in once, so its User row exists; then both teach at Downtown.
    await signInWith(page, appLocale, people.teacher.email);
    const assistantPage = await assistantContext.newPage();
    await signInWith(assistantPage, appLocale, people.assistant.email);
    const downtown = await db.center.findFirstOrThrow({ where: { name: SEED.downtown }, select: { id: true } });
    const teacher = await db.user.findUniqueOrThrow({ where: { email: people.teacher.email } });
    const assistant = await db.user.findUniqueOrThrow({ where: { email: people.assistant.email } });
    fixtureIds.push(teacher.id, assistant.id);
    for (const user of [teacher, assistant]) {
      await db.membership.create({
        data: { centerId: downtown.id, userId: user.id, role: "TEACHER", firstName: user.firstName, lastName: user.lastName, joinedAt: new Date() },
      });
    }
    const teacherName = `${people.teacher.first} ${people.teacher.last}`;

    // Not premium yet: the page explains premium and offers no action.
    await page.goto(`/${appLocale}/teacher/assistants`);
    await expectHealthy(page, appLocale);
    await expect(page.getByText(msg("Assistants.teacher.premiumTitle"))).toBeVisible();
    await expect(page.getByRole("button", { name: msg("Assistants.teacher.invite"), exact: true })).toHaveCount(0);

    // The platform admin grants premium (the W6 page).
    const admin = await as("admin");
    await admin.goto(`/${appLocale}/admin/teachers`);
    await admin.getByLabel(field(msg("AdminPremium.lookup.label"))).fill(people.teacher.email);
    await admin.getByRole("button", { name: msg("AdminPremium.lookup.submit"), exact: true }).click();
    const match = admin.getByRole("heading", { name: new RegExp(escapeRegExp(people.teacher.last)) });
    await expect(match).toBeVisible();
    const end = dayFromToday(30);
    await pickDate(admin, appLocale, msg("AdminPremium.grant.label"), end);
    await admin.getByRole("button", { name: msg("AdminPremium.grant.submit"), exact: true }).click();
    await expect(match).toContainText(msg("Premium.status.active", { date: formatDay(end, appLocale) }));

    // The teacher invites (Co-teacher, the default) and reads the code once.
    await page.reload();
    await expectHealthy(page, appLocale);
    await expect(page.getByText(msg("Assistants.teacher.slots", { used: 0, max: 5 }))).toBeVisible();
    await page.getByRole("button", { name: msg("Assistants.teacher.invite"), exact: true }).click();
    let dialog = openDialog(page);
    await expect(dialog.getByText(msg("Assistants.presets.CO_TEACHER.description"))).toBeVisible();
    await dialog.getByRole("button", { name: msg("Assistants.invite.submit"), exact: true }).click();
    dialog = openDialog(page);
    await expect(dialog.getByText(msg("Assistants.code.onceWarning"))).toBeVisible();
    const code = (await dialog.textContent())?.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
    expect(code, "the code is shown once in the dialog").toBeTruthy();
    await dialog.getByRole("button", { name: msg("Assistants.invite.done"), exact: true }).first().click();
    await expect(page.getByText(msg("Assistants.teacher.slots", { used: 1, max: 5 }))).toBeVisible();
    await expect(page.getByText(msg("Assistants.teacher.pendingPreset", { preset: msg("Assistants.presets.CO_TEACHER.label") }))).toBeVisible();
    await expect(page.getByText(code!), "never retrievable later").toHaveCount(0);

    // The second account: a wrong code gets the one message; the real one shows a confirmation first.
    await assistantPage.goto(`/${appLocale}/assistant-join`);
    await expectHealthy(assistantPage, appLocale);
    const codeField = assistantPage.getByLabel(field(msg("Assistants.join.codeLabel")));
    await codeField.fill("ABCD-EFGH-2345");
    await assistantPage.getByRole("button", { name: msg("Assistants.join.continue"), exact: true }).click();
    await expect(assistantPage.getByText(msg("Assistants.errors.invalidCode"))).toBeVisible();
    await codeField.fill(code!.toLowerCase());
    await assistantPage.getByRole("button", { name: msg("Assistants.join.continue"), exact: true }).click();
    await expect(assistantPage.getByRole("heading", { name: msg("Assistants.join.confirmTitle", { teacher: teacherName }) })).toBeVisible();
    await expect(assistantPage.getByText(msg("Assistants.permissions.assessments.review.label"))).toBeVisible();
    expect(await db.teacherAssistant.count({ where: { teacherUserId: teacher.id } }), "nothing links before Confirm").toBe(0);
    await assistantPage.getByRole("button", { name: msg("Assistants.join.confirm"), exact: true }).click();

    // Into the assistant experience: the teacher's name and the granted permissions.
    await assistantPage.waitForURL(new RegExp(`/${appLocale}/assistant/${teacher.id}$`));
    await expectHealthy(assistantPage, appLocale);
    const homeTitle = assistantPage.getByRole("heading", { name: msg("Assistants.home.title", { teacher: teacherName }) });
    await expect(homeTitle).toBeVisible();
    await expect(assistantPage.getByText(msg("Assistants.permissions.classes.view.label"))).toBeVisible();
    await expect(assistantPage.getByText(msg("Assistants.permissions.analytics.view.label"))).toHaveCount(0);

    // The switcher lists both; out to the teacher portal and back in.
    let sheet = await openSwitcher(assistantPage, appLocale);
    const assistantRow = sheet.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(msg("Experiences.assistantOf", { teacher: teacherName }))}`) });
    await expect(assistantRow).toHaveAttribute("aria-current", "true");
    await sheet.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(msg("Experiences.teacher"))}`) }).click();
    await assistantPage.waitForURL(new RegExp(`/${appLocale}/teacher/dashboard$`));
    sheet = await openSwitcher(assistantPage, appLocale);
    await sheet.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(msg("Experiences.assistantOf", { teacher: teacherName }))}`) }).click();
    await assistantPage.waitForURL(new RegExp(`/${appLocale}/assistant/${teacher.id}$`));
    await expect(homeTitle).toBeVisible();

    // Account settings lists the role with its permissions.
    await assistantPage.goto(`/${appLocale}/account?from=hub`);
    await expectHealthy(assistantPage, appLocale);
    await expect(assistantPage.getByRole("heading", { name: msg("Account.assistant.roleTitle", { teacher: teacherName }) })).toBeVisible();

    // The teacher sees the assistant, then removes them (confirmed).
    await page.reload();
    await expect(page.getByText(msg("Assistants.teacher.slots", { used: 1, max: 5 }))).toBeVisible();
    await expect(page.getByRole("heading", { name: new RegExp(escapeRegExp(people.assistant.last)) })).toBeVisible();
    await page.getByRole("button", { name: msg("Assistants.teacher.remove"), exact: true }).click();
    await openDialog(page).getByRole("button", { name: msg("Assistants.teacher.remove"), exact: true }).click();
    await expect(page.getByText(msg("Assistants.teacher.noAssistants"))).toBeVisible();

    // Gone on the assistant's next request.
    await assistantPage.goto(`/${appLocale}/assistant/${teacher.id}`);
    await expect(homeTitle).toHaveCount(0);
    await assistantPage.goto(`/${appLocale}/account?from=hub`);
    await expect(assistantPage.getByRole("heading", { name: msg("Account.assistant.roleTitle", { teacher: teacherName }) })).toHaveCount(0);
  } finally {
    await assistantContext.close();
    const users = await db.user.findMany({ where: { email: { in: [people.teacher.email, people.assistant.email] } }, select: { id: true, authId: true } });
    const ids = users.map((user) => user.id);
    if (ids.length > 0) {
      await deleteAuditRows(db, { actorUserId: { in: ids } });
      await deleteAuditRows(db, { action: { startsWith: "platform.premium." }, entityType: "User", entityId: { in: ids } });
    }
    await removeE2eUsers(db, e2eTag);
    await resetJoinLimits(db);
    // A login that never reached the app is invisible to removeE2eUsers.
    for (const authId of authIds) {
      if (!users.some((user) => user.authId === authId)) await supabase.auth.admin.deleteUser(authId);
    }
  }

  expect(
    await leftovers(db, [people.teacher.email, people.assistant.email], fixtureIds),
    "the teardown leaves nothing of this run behind",
  ).toEqual({ users: 0, invites: 0, links: 0, memberships: 0, audit: 0 });
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// W7b (D-W37): the assistant acts for the seeded teacher.downtown.
// ─────────────────────────────────────────────────────────────────────────────

const W7B_LOCK = "e2e:assistants-w7b:lock";
const W7B_LOCK_STALE_MS = 15 * 60_000;

/**
 * `en-1280` and `ar-375` run on two workers at once, and this journey changes
 * shared seed state for its length — teacher.downtown's premium and Downtown's
 * "Allow teacher assistants" — so one project's teardown would cut the other's
 * assistant off mid-run. A row in the limiter's table (a unique key) is the
 * mutex: the second project waits for the first to restore everything. A lock
 * older than 15 minutes is a crashed run's and is taken over.
 */
async function takeLock(db: PrismaClient) {
  const deadline = Date.now() + W7B_LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try {
      await db.rateLimitBucket.create({ data: { key: W7B_LOCK, windowStart: new Date(), count: 1 } });
      return;
    } catch {
      await db.rateLimitBucket.deleteMany({ where: { key: W7B_LOCK, windowStart: { lt: new Date(Date.now() - W7B_LOCK_STALE_MS) } } });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error("e2e assistants W7b: the other project still holds the lock");
}

test("@write assistants act on behalf: an exam built, published and read, a request filed, seen as the teacher's, and the branch switch", async ({
  browser,
  appLocale,
  msg,
  as,
  e2eTag,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  assertSafeToWrite("e2e: assistants W7b fixtures");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e assistants: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const db = new PrismaClient();
  await takeLock(db);
  const startedAt = new Date();
  const title = `${E2E_ASSESSMENT_PREFIX}${e2eTag.toLowerCase()}-w7b`;
  const person = { email: e2eEmail(e2eTag, "helper"), first: "Help", last: `Helper ${e2eTag}` };
  const authIds: string[] = [];
  const assistantContext = await browser.newContext({ ...testInfo.project.use });

  const teacher = await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.teacherDowntown.email } });
  const downtown = await db.center.findFirstOrThrow({ where: { name: SEED.downtown }, select: { id: true } });
  const manager = await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.manager.email }, select: { id: true } });
  const original = {
    premiumUntil: teacher.premiumUntil,
    allow: (await db.centerSettings.findUniqueOrThrow({ where: { centerId: downtown.id } })).allowTeacherAssistants,
  };
  const classGroup = await db.classGroup.findFirstOrThrow({
    where: { centerId: downtown.id, teacherId: teacher.id, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  let assistantId: string | null = null;

  try {
    // The tagged assistant account (the Supabase admin API: no per-IP sign-up limit).
    const { data, error } = await supabase.auth.admin.createUser({
      email: person.email,
      password: E2E_PASSWORD,
      email_confirm: true,
      user_metadata: { first_name: person.first, last_name: person.last, locale: appLocale },
    });
    if (error || !data.user) throw error ?? new Error("e2e assistants: could not create a login");
    authIds.push(data.user.id);
    const assistantPage = await assistantContext.newPage();
    await signInWith(assistantPage, appLocale, person.email);
    assistantId = (await db.user.findUniqueOrThrow({ where: { email: person.email }, select: { id: true } })).id;

    // The platform admin gives the seeded teacher premium (the W6 page), unless a run left it on.
    if (!teacher.premiumUntil || teacher.premiumUntil <= new Date()) {
      const admin = await as("admin");
      await admin.goto(`/${appLocale}/admin/teachers`);
      await admin.getByLabel(field(msg("AdminPremium.lookup.label"))).fill(ACCOUNTS.teacherDowntown.email);
      await admin.getByRole("button", { name: msg("AdminPremium.lookup.submit"), exact: true }).click();
      await pickDate(admin, appLocale, msg("AdminPremium.grant.label"), dayFromToday(30));
      await admin.getByRole("button", { name: msg("AdminPremium.grant.submit"), exact: true }).click();
      await expect(admin.getByText(msg("Premium.status.active", { date: formatDay(dayFromToday(30), appLocale) }))).toBeVisible();
    }

    // The teacher invites (Co-teacher); the assistant redeems the code.
    const teacherPage = await as("teacherDowntown");
    await teacherPage.goto(`/${appLocale}/teacher/assistants`);
    await expectHealthy(teacherPage, appLocale);
    await teacherPage.getByRole("button", { name: msg("Assistants.teacher.invite"), exact: true }).click();
    let dialog = openDialog(teacherPage);
    await dialog.getByRole("button", { name: msg("Assistants.invite.submit"), exact: true }).click();
    dialog = openDialog(teacherPage);
    await expect(dialog.getByText(msg("Assistants.code.onceWarning"))).toBeVisible();
    const code = (await dialog.textContent())?.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
    expect(code, "the code is shown once").toBeTruthy();
    await dialog.getByRole("button", { name: msg("Assistants.invite.done"), exact: true }).first().click();

    await assistantPage.goto(`/${appLocale}/assistant-join`);
    await assistantPage.getByLabel(field(msg("Assistants.join.codeLabel"))).fill(code!);
    await assistantPage.getByRole("button", { name: msg("Assistants.join.continue"), exact: true }).click();
    await assistantPage.getByRole("button", { name: msg("Assistants.join.confirm"), exact: true }).click();
    await assistantPage.waitForURL(new RegExp(`/${appLocale}/assistant/${teacher.id}$`));
    await expectHealthy(assistantPage, appLocale);
    await expect(assistantPage.getByRole("listitem").filter({ hasText: SEED.downtown })).toBeVisible();

    // The Co-teacher nav: assessments, classes and requests — no overview, no settlements.
    const nav = await primaryNav(assistantPage, appLocale);
    for (const label of ["Nav.assessments", "Nav.classes", "Nav.requests"]) {
      await expect(nav.getByRole("link", { name: msg(label), exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: msg("Nav.overview"), exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: msg("Nav.settlements"), exact: true })).toHaveCount(0);
    await closeNav(assistantPage, appLocale);

    // ── An exam in the teacher's class: build, save, publish, results ──────
    const base = `/${appLocale}/assistant/${teacher.id}/assessments`;
    await assistantPage.goto(`${base}/new?type=EXAM&class=${encodeURIComponent(classGroup.id)}`);
    await expectHealthy(assistantPage, appLocale);
    await assistantPage.locator("#assessment-title").fill(title);
    const windowField = (name: string) => assistantPage.locator("fieldset", { has: assistantPage.locator(`#${name}-date`) });
    await pickDate(windowField("windowStart"), appLocale, msg("TeacherAssessments.builder.date"), dayFromToday(0));
    await assistantPage.locator("#windowStart-time").fill("00:00");
    await assistantPage.locator("#windowStart-time").press("Tab");
    await pickDate(windowField("windowEnd"), appLocale, msg("TeacherAssessments.builder.date"), dayFromToday(2));
    await assistantPage.locator("#windowEnd-time").fill("23:00");
    await assistantPage.locator("#windowEnd-time").press("Tab");
    await assistantPage.getByRole("button", { name: msg("TeacherAssessments.builder.addQuestion"), exact: true }).click();
    const card = assistantPage.locator("main ol > li").first();
    await card.getByLabel(msg("TeacherAssessments.builder.questionText"), { exact: true }).fill("Assistant question");
    const options = card.locator("fieldset input:not([type=radio])");
    await expect(options).toHaveCount(4);
    for (let option = 0; option < 4; option += 1) await options.nth(option).fill(`Option ${option + 1}`);
    await card.getByRole("radio").first().check();
    await assistantPage.getByRole("button", { name: msg("TeacherAssessments.builder.save"), exact: true }).click();
    await assistantPage.waitForURL(new RegExp(`/assistant/${teacher.id}/assessments/[0-9a-f-]{36}`));
    const assessmentId = /assessments\/([0-9a-f-]{36})/.exec(assistantPage.url())![1];
    const publish = assistantPage.getByRole("button", { name: msg("TeacherAssessments.publish.label"), exact: true });
    await expect(publish).toBeEnabled();
    await publish.click();
    await openDialog(assistantPage).getByRole("button", { name: msg("TeacherAssessments.publish.label"), exact: true }).click();
    await expect(assistantPage.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toBeVisible();

    const row = await db.assessment.findUniqueOrThrow({ where: { id: assessmentId }, select: { status: true, teacherMembershipId: true, createdByUserId: true } });
    const ownMembership = await db.membership.findFirstOrThrow({ where: { centerId: downtown.id, userId: teacher.id, role: "TEACHER" }, select: { id: true } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.teacherMembershipId, "the exam is the teacher's").toBe(ownMembership.id);
    const audit = await db.auditLog.findMany({ where: { entityType: "Assessment", entityId: assessmentId } });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.every((entry) => entry.actorUserId === assistantId && entry.onBehalfOfUserId === teacher.id), "actor = the assistant, onBehalfOf = the teacher").toBe(true);

    await assistantPage.getByRole("link", { name: msg("TeacherAssessments.results.action") }).first().click();
    await assistantPage.waitForURL(new RegExp(`/assistant/${teacher.id}/assessments/${assessmentId}/results`));
    await expectHealthy(assistantPage, appLocale);
    await expect(assistantPage.getByRole("heading", { name: msg("TeacherAssessments.results.title") })).toBeVisible();

    // ── A request for a new session, as the teacher's ─────────────────────
    await assistantPage.goto(`/${appLocale}/assistant/${teacher.id}/requests`);
    await expectHealthy(assistantPage, appLocale);
    const form = assistantPage.locator("form", { has: assistantPage.locator("#session-request-class") });
    await choose(form, msg("TeacherSessions.request.class"), /./);
    await pickDate(form, appLocale, msg("TeacherSessions.request.date"), dayFromToday(6));
    await form.locator("#session-request-time-start").fill("19:00");
    await form.locator("#session-request-time-start").press("Tab");
    await form.locator("#session-request-time-end").fill("20:00");
    await form.locator("#session-request-time-end").press("Tab");
    await form.getByRole("button", { name: msg("TeacherSessions.request.submit"), exact: true }).click();
    await expect(form.getByText(msg("TeacherSessions.request.submitted"))).toBeVisible();
    const request = await db.changeRequest.findFirstOrThrow({ where: { viaAssistantUserId: assistantId }, orderBy: { createdAt: "desc" } });
    expect(request.requestedBy, "stored as the teacher's").toBe(teacher.id);
    await expect(assistantPage.getByText(msg("Assistants.work.requests.viaAssistant")).first()).toBeVisible();

    // ── The manager: the teacher's name with "via assistant", never the assistant ─
    const managerPage = await as("manager");
    await managerPage.goto(`/${appLocale}/approvals?type=sessionRequests`);
    await expectHealthy(managerPage, appLocale);
    const teacherMembership = await db.membership.findFirstOrThrow({ where: { centerId: downtown.id, userId: teacher.id, role: "TEACHER" }, select: { firstName: true, lastName: true } });
    const teacherLocal = `${teacherMembership.firstName ?? teacher.firstName} ${teacherMembership.lastName ?? teacher.lastName}`;
    const requestCard = managerPage.locator("article", { hasText: msg("Approvals.viaAssistant") }).first();
    await expect(requestCard).toBeVisible();
    await expect(requestCard).toContainText(teacherLocal);
    await expect(managerPage.getByText(person.last)).toHaveCount(0);
    await managerPage.goto(`/${appLocale}/audit`);
    await expectHealthy(managerPage, appLocale);
    await expect(managerPage.getByText(msg("Audit.viaAssistant")).first()).toBeVisible();
    await expect(managerPage.getByText(person.last)).toHaveCount(0);

    // ── The branch switch: off, and the assistant loses Downtown ─────────
    await managerPage.goto(`/${appLocale}/settings`);
    await expectHealthy(managerPage, appLocale);
    const toggle = managerPage.getByRole("switch", { name: new RegExp(escapeRegExp(msg("Settings.general.assistantsLabel"))) });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await managerPage.getByRole("button", { name: msg("Settings.common.save"), exact: true }).click();
    await expect(managerPage.getByText(msg("Settings.common.saved")).first()).toBeVisible();
    expect((await db.centerSettings.findUniqueOrThrow({ where: { centerId: downtown.id } })).allowTeacherAssistants).toBe(false);

    await assistantPage.goto(`/${appLocale}/assistant/${teacher.id}`);
    await expectHealthy(assistantPage, appLocale);
    await expect(assistantPage.getByRole("listitem").filter({ hasText: SEED.downtown })).toHaveCount(0);
    await assistantPage.goto(`${base}/${assessmentId}`);
    await expect(assistantPage.getByRole("button", { name: msg("TeacherAssessments.unpublish.label"), exact: true })).toHaveCount(0);
  } finally {
    await assistantContext.close();
    // Restore the seed's shared state first, then remove this run's rows.
    await db.centerSettings.update({ where: { centerId: downtown.id }, data: { allowTeacherAssistants: original.allow } });
    await db.user.update({ where: { id: teacher.id }, data: { premiumUntil: original.premiumUntil } });
    await removeE2eAssessments(db, `${e2eTag.toLowerCase()}-w7b`);
    if (assistantId) {
      await db.changeRequest.deleteMany({ where: { viaAssistantUserId: assistantId } });
      await deleteAuditRows(db, { actorUserId: assistantId });
    }
    await db.assistantInvite.deleteMany({ where: { teacherUserId: teacher.id, createdAt: { gte: startedAt } } });
    await deleteAuditRows(db, { actorUserId: teacher.id, action: { startsWith: "assistant." }, createdAt: { gte: startedAt } });
    await deleteAuditRows(db, { action: { startsWith: "platform.premium." }, entityId: teacher.id, createdAt: { gte: startedAt } });
    await deleteAuditRows(db, { actorUserId: manager.id, action: "center.settings.update", centerId: downtown.id, createdAt: { gte: startedAt } });
    await removeE2eUsers(db, e2eTag);
    await resetJoinLimits(db);
    for (const authId of authIds) {
      const left = await db.user.count({ where: { authId } });
      if (left === 0) await supabase.auth.admin.deleteUser(authId).catch(() => undefined);
    }
    await db.rateLimitBucket.deleteMany({ where: { key: W7B_LOCK } });
  }

  // What this run created is gone, and the seed's shared state is as it was.
  const after = await db.user.findUniqueOrThrow({ where: { id: teacher.id }, select: { premiumUntil: true } });
  expect(after.premiumUntil?.getTime() ?? null).toBe(original.premiumUntil?.getTime() ?? null);
  expect((await db.centerSettings.findUniqueOrThrow({ where: { centerId: downtown.id } })).allowTeacherAssistants).toBe(original.allow);
  expect(
    {
      users: await db.user.count({ where: { email: person.email } }),
      links: await db.teacherAssistant.count({ where: { teacherUserId: teacher.id } }),
      invites: await db.assistantInvite.count({ where: { teacherUserId: teacher.id, createdAt: { gte: startedAt } } }),
      requests: assistantId ? await db.changeRequest.count({ where: { viaAssistantUserId: assistantId } }) : 0,
      assessments: await db.assessment.count({ where: { title: { startsWith: title } } }),
      audit: await db.auditLog.count({ where: { OR: [{ onBehalfOfUserId: teacher.id }, ...(assistantId ? [{ actorUserId: assistantId }] : [])], createdAt: { gte: startedAt } } }),
    },
    "the teardown leaves nothing of this run behind",
  ).toEqual({ users: 0, links: 0, invites: 0, requests: 0, assessments: 0, audit: 0 });
  await db.$disconnect();
});
