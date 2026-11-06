import { PrismaClient } from "@prisma/client";
import type { BrowserContext, Page } from "@playwright/test";

import { assertSafeToWrite } from "../scripts/lib/env";
import { e2eEmail } from "../scripts/lib/e2e-users";

import { ACCOUNTS, SEED } from "./support/accounts";
import { closeNav, expect, expectHealthy, primaryNav, test } from "./support/fixtures";
import { t, type AppLocale } from "./support/i18n";
import { signUp, signUpProjectOnly } from "./support/signup";
import { selectBranch } from "./support/ui";

/**
 * The role switcher (W5, D-W13, D-W34): from any shell, a person moves to any
 * other experience their account has, nothing of the old page follows, and the
 * remembered one is a hint that grants nothing. `listExperiences` against every
 * combination of rows is `check:people`'s W5 block.
 */
const COOKIE = "kayedu_last_experience";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The switcher's trigger in the header (its name starts with "Switch role"). */
function trigger(page: Page, locale: AppLocale) {
  return page.getByRole("banner").getByRole("button", { name: new RegExp(`^${escapeRegExp(t(locale, "Experiences.triggerNoCurrent"))}`) });
}

async function openSwitcher(page: Page, locale: AppLocale) {
  await trigger(page, locale).click();
  const sheet = page.getByRole("dialog", { name: t(locale, "Experiences.title") });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** A row by the text it starts with, for a row whose name also carries its second line. */
function row(sheet: ReturnType<Page["getByRole"]>, name: string) {
  return sheet.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(name)}`) });
}

async function setRemembered(context: BrowserContext, baseURL: string, value: string) {
  await context.addCookies([{ name: COOKIE, value: encodeURIComponent(value), url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function rememberedValue(context: BrowserContext): Promise<string | null> {
  const cookie = (await context.cookies()).find((item) => item.name === COOKIE);
  return cookie ? decodeURIComponent(cookie.value) : null;
}

test("owner.center60 moves between Whole Management and both branches, and no query follows", async ({ as, appLocale, msg, baseURL }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale, SEED.downtown);

  // Downtown is current, by text and by aria-current.
  await page.goto(`/${appLocale}/sessions?range=week&month=2026-01&branch=stale`);
  let sheet = await openSwitcher(page, appLocale);
  const downtown = row(sheet, SEED.downtown);
  await expect(downtown).toHaveAttribute("aria-current", "true");
  await expect(downtown).toContainText(msg("Experiences.current"));
  await expect(sheet.getByRole("menuitem", { name: new RegExp(escapeRegExp(msg("Experiences.wholeManagement"))) })).toHaveCount(1);
  await expect(row(sheet, SEED.nasrCity)).not.toHaveAttribute("aria-current", "true");
  await expect(sheet.getByRole("group", { name: SEED.organization })).toBeVisible();

  // To Nasr City: its landing page, with nothing of the old page.
  await row(sheet, SEED.nasrCity).click();
  await page.waitForURL(`${baseURL}/${appLocale}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/dashboard$`));
  await expectHealthy(page, appLocale);
  await expect(page.getByRole("dialog", { name: msg("Experiences.title") }), "a switch closes the sheet").toHaveCount(0);
  await expect(page.getByRole("banner").getByText(SEED.nasrCity).first()).toBeAttached();

  // To Whole Management, from a filtered page: Analytics, no query.
  await page.goto(`/${appLocale}/classes?status=active`);
  sheet = await openSwitcher(page, appLocale);
  await expect(row(sheet, SEED.nasrCity)).toHaveAttribute("aria-current", "true");
  await sheet.getByRole("menuitem", { name: new RegExp(escapeRegExp(msg("Experiences.wholeManagement"))) }).click();
  await page.waitForURL(`${baseURL}/${appLocale}/analytics`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/analytics$`));
  await expectHealthy(page, appLocale);

  // And back to a branch.
  sheet = await openSwitcher(page, appLocale);
  await expect(sheet.getByRole("menuitem", { name: new RegExp(escapeRegExp(msg("Experiences.wholeManagement"))) })).toHaveAttribute("aria-current", "true");
  await row(sheet, SEED.downtown).click();
  await page.waitForURL(`${baseURL}/${appLocale}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/dashboard$`));
  await expectHealthy(page, appLocale);
});

test("teacher.shared has one experience: no role switcher, and the branch switcher still moves between both branches", async ({ as, appLocale, msg }) => {
  const page = await as("teacherShared");
  await page.goto(`/${appLocale}/teacher/dashboard`);
  await expectHealthy(page, appLocale);
  await expect(trigger(page, appLocale)).toHaveCount(0);

  const main = page.locator("main");
  await page.locator("header").getByRole("button", { name: new RegExp(msg("Shell.allBranches")) }).click();
  await page.getByRole("button", { name: new RegExp(SEED.nasrCity) }).click();
  await expect(main.getByText(SEED.downtown)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.locator("header").getByRole("button", { name: new RegExp(SEED.nasrCity) }).click();
  await page.getByRole("button", { name: new RegExp(SEED.downtown) }).click();
  await expect(main.getByText(SEED.nasrCity)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.locator("header").getByRole("button", { name: new RegExp(SEED.downtown) }).click();
  await page.getByRole("button", { name: new RegExp(`^${msg("Shell.allBranches")}`) }).click();
  await expect(main.getByText(SEED.downtown).first()).toBeVisible();
  await expect(main.getByText(SEED.nasrCity).first()).toBeVisible();
});

test("a single-experience account has no switcher", async ({ as, appLocale }) => {
  const page = await as("studentDowntown");
  await page.goto(`/${appLocale}`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/student/schedule$`));
  await expect(trigger(page, appLocale)).toHaveCount(0);
  await page.goto(`/${appLocale}/account?from=student`);
  await expect(trigger(page, appLocale)).toHaveCount(0);
});

test("the sheet is keyboard operable and hands focus back", async ({ as, appLocale, msg }) => {
  const page = await as("owner");
  await selectBranch(page, appLocale, SEED.downtown);
  const button = trigger(page, appLocale);
  await button.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: msg("Experiences.title") });
  await expect(sheet).toBeVisible();

  // The current row takes focus, and the arrows walk the menu.
  const current = row(sheet, SEED.downtown);
  await expect(current).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(sheet, SEED.nasrCity)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(sheet.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(sheet.getByRole("menuitem").last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("at 375px the sheet is full width on the bottom edge, 44px rows, mirrored in Arabic", async ({ as, appLocale, msg }, testInfo) => {
  test.skip(!testInfo.project.name.endsWith("-375"), "the phone layout");
  const page = await as("owner");
  await selectBranch(page, appLocale, SEED.downtown);

  // The header still fits beside the branch switcher: the page never scrolls sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "no horizontal scroll at 375px").toBeLessThanOrEqual(0);
  await expect(page.locator("html")).toHaveAttribute("dir", appLocale === "ar" ? "rtl" : "ltr");

  const triggerBox = await trigger(page, appLocale).boundingBox();
  expect(triggerBox?.height).toBeGreaterThanOrEqual(44);
  expect(triggerBox?.width).toBeGreaterThanOrEqual(44);

  const sheet = await openSwitcher(page, appLocale);
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? [Math.round(box.x), Math.round(box.width), Math.round(box.y + box.height)] : null;
    }, "full width, sitting on the bottom edge once its slide has finished")
    .toEqual([0, 375, 812]);

  const rows = sheet.getByRole("menuitem");
  for (const box of await rows.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) {
    expect(box, "a 44px row").toBeGreaterThanOrEqual(44);
  }

  // The mark leads on the reading edge: the right in Arabic, the left in English.
  const { markX, textX } = await row(sheet, SEED.nasrCity).evaluate((element) => {
    const [mark, text] = [element.children[0], element.children[1]].map((child) => child.getBoundingClientRect().x);
    return { markX: mark, textX: text };
  });
  if (appLocale === "ar") expect(markX, "the mark is on the right in Arabic").toBeGreaterThan(textX);
  else expect(markX, "the mark is on the left in English").toBeLessThan(textX);

  await page.getByRole("button", { name: msg("Shared.close"), exact: true }).click();
  await expect(sheet).toHaveCount(0);
});

test("the hub lists the last one used first, labelled, with Continue, and never redirects", async ({ as, appLocale, msg, baseURL }) => {
  const page = await as("owner");
  await page.goto(`/${appLocale}/select-center`);
  await expect(page.getByText(msg("Auth.selectCenter.lastUsed"))).toHaveCount(0);

  await selectBranch(page, appLocale, SEED.nasrCity);
  // Back on the hub it waits for a choice: no auto-redirect.
  await page.goto(`/${appLocale}/select-center`);
  await expect(page).toHaveURL(/select-center/);
  await expect(page.getByText(msg("Auth.selectCenter.lastUsed"))).toBeVisible();
  const proceed = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(msg("Auth.selectCenter.continue"))}`) });
  await expect(proceed).toHaveCount(1);
  await expect(proceed).toContainText(SEED.nasrCity);
  // First on the page, and listed once.
  await expect(page.getByRole("button", { name: new RegExp(escapeRegExp(SEED.nasrCity)) })).toHaveCount(1);
  await proceed.click();
  await page.waitForURL(`${baseURL}/${appLocale}/dashboard`);
  await expectHealthy(page, appLocale);
});

test("the hub shell carries the switcher, with nothing current, and it leaves for a real landing page", async ({ as, appLocale, msg, baseURL }) => {
  const page = await as("owner");
  await page.goto(`/${appLocale}/account?from=hub`);
  await expect(page.getByRole("link", { name: msg("Shell.backToHub") })).toBeVisible();
  await expect(trigger(page, appLocale)).toHaveAccessibleName(msg("Experiences.triggerNoCurrent"));
  const sheet = await openSwitcher(page, appLocale);
  await expect(sheet.locator('[aria-current="true"]')).toHaveCount(0);
  await row(sheet, SEED.downtown).click();
  await page.waitForURL(`${baseURL}/${appLocale}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/dashboard$`));
  await expectHealthy(page, appLocale);
});

test("a stale or tampered cookie is ignored and cleared", async ({ as, appLocale, msg, baseURL }) => {
  for (const value of [
    JSON.stringify({ key: "staff:00000000-0000-4000-8000-000000000000", centerId: "00000000-0000-4000-8000-000000000000" }),
    JSON.stringify({ key: "admin" }),
    "not json",
  ]) {
    const page = await as("owner");
    await setRemembered(page.context(), baseURL!, value);
    await page.goto(`/${appLocale}/select-center`);
    await expect(page).toHaveURL(/select-center/);
    await expect(page.getByText(msg("Auth.selectCenter.lastUsed"))).toHaveCount(0);
    await expect.poll(() => rememberedValue(page.context()), `${value} is cleared`).toBeNull();
  }
});

test("the cookie never changes what a route allows", async ({ as, appLocale, baseURL }) => {
  const page = await as("studentDowntown");
  const context = page.context();
  for (const value of [JSON.stringify({ key: "admin" }), JSON.stringify({ key: "teacher" }), JSON.stringify({ key: "staff:x", centerId: "x" })]) {
    await setRemembered(context, baseURL!, value);
    await page.goto(`/${appLocale}/admin/centers`);
    await expect(page, "no console for a student").toHaveURL(new RegExp(`/${appLocale}/student/schedule$`));
    await page.goto(`/${appLocale}/dashboard`);
    await expect(page, "no staff page for a student").toHaveURL(new RegExp(`/${appLocale}/student/schedule$`));
  }

  // Nor does it conjure a switcher: this account still has one experience.
  await expect(trigger(page, appLocale)).toHaveCount(0);
});

test("a teacher who is also a student and a parent moves between all three, and losing access removes one @write", async ({ page, appLocale, msg, baseURL, e2eTag }, testInfo) => {
  signUpProjectOnly(testInfo);
  assertSafeToWrite("e2e: experience switcher fixture");

  const email = e2eEmail(e2eTag, "multi");
  await signUp(page, appLocale, { firstName: "Multi", lastName: `Kind ${e2eTag}`, email }, "TEACHER");

  // The three relations go straight in: the seed stays as it is, and deleting
  // this e2e account (the fixture, pass or fail) cascades all of them.
  const db = new PrismaClient();
  let membershipId = "";
  try {
    const me = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const downtown = await db.center.findFirstOrThrow({ where: { name: SEED.downtown }, select: { id: true } });
    const child = await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.studentNew.email }, select: { id: true } });
    const membership = await db.membership.create({ data: { userId: me.id, centerId: downtown.id, role: "TEACHER" } });
    membershipId = membership.id;
    await db.studentProfile.create({ data: { userId: me.id, centerId: downtown.id, studentCode: e2eTag, profileCompletedAt: new Date() } });
    await db.familyLink.create({ data: { parentUserId: me.id, studentUserId: child.id, status: "ACTIVE", source: "STUDENT_INVITE" } });
  } finally {
    await db.$disconnect();
  }

  // Several experiences: the hub, and it offers all three.
  await page.goto(`/${appLocale}`);
  await expect(page).toHaveURL(/select-center/);
  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(msg("Auth.selectCenter.teacherPortal"))}`) }).click();
  await page.waitForURL(`${baseURL}/${appLocale}/teacher/dashboard`);

  // Teacher → Student → Parent → Teacher, each from the other's shell.
  let sheet = await openSwitcher(page, appLocale);
  await expect(sheet.getByRole("menuitem")).toHaveCount(3);
  await expect(row(sheet, msg("Experiences.teacher"))).toHaveAttribute("aria-current", "true");
  await row(sheet, msg("Experiences.student")).click();
  await page.waitForURL(`${baseURL}/${appLocale}/student/schedule`);
  await expectHealthy(page, appLocale);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/student/schedule$`));

  sheet = await openSwitcher(page, appLocale);
  await expect(row(sheet, msg("Experiences.student"))).toHaveAttribute("aria-current", "true");
  await row(sheet, msg("Experiences.parent")).click();
  await page.waitForURL(`${baseURL}/${appLocale}/parent`);
  await expectHealthy(page, appLocale);

  sheet = await openSwitcher(page, appLocale);
  await expect(row(sheet, msg("Experiences.parent"))).toHaveAttribute("aria-current", "true");
  await row(sheet, msg("Experiences.teacher")).click();
  await page.waitForURL(`${baseURL}/${appLocale}/teacher/dashboard`);
  await expectHealthy(page, appLocale);

  // The sidebar's menu still works beside it.
  await primaryNav(page, appLocale);
  await closeNav(page, appLocale);

  // The hub marks the last one used.
  await page.goto(`/${appLocale}/select-center`);
  await expect(page.getByText(msg("Auth.selectCenter.lastUsed"))).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^${escapeRegExp(msg("Auth.selectCenter.continue"))}`) })).toContainText(msg("Auth.selectCenter.teacherPortal"));
  expect(JSON.parse((await rememberedValue(page.context())) ?? "{}")).toEqual({ key: "teacher" });

  // Access lost: the entry is gone on the next request, and the cookie is cleared.
  const cleanup = new PrismaClient();
  try {
    await cleanup.membership.update({ where: { id: membershipId }, data: { active: false } });
  } finally {
    await cleanup.$disconnect();
  }
  await page.goto(`/${appLocale}/select-center`);
  await expect(page.getByText(msg("Auth.selectCenter.lastUsed"))).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(`^${escapeRegExp(msg("Auth.selectCenter.teacherPortal"))}`) })).toHaveCount(0);
  await expect.poll(() => rememberedValue(page.context())).toBeNull();
  await page.goto(`/${appLocale}/parent`);
  sheet = await openSwitcher(page, appLocale);
  await expect(sheet.getByRole("menuitem")).toHaveCount(2);
});
