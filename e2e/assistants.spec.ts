import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { formatDay } from "@/lib/format";

import { deleteAuditRows } from "../scripts/lib/audit-maintenance";
import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail, removeE2eUsers } from "../scripts/lib/e2e-users";

import { SEED } from "./support/accounts";
import { expect, expectHealthy, test } from "./support/fixtures";
import { t, type AppLocale } from "./support/i18n";
import { E2E_PASSWORD, signInWith } from "./support/signup";
import { dayFromToday, field, openDialog, pickDate } from "./support/ui";

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
