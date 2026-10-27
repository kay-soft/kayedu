import type { Page } from "@playwright/test";

import { SEED, type AccountKey } from "./support/accounts";
import { expect, expectHealthy, primaryNav, test } from "./support/fixtures";
import { t, type AppLocale } from "./support/i18n";

/**
 * Every role's primary path, in both locales at 1280 and 375 (SYS Part A):
 * the account lands where its role should, its sidebar lists exactly the
 * items docs/dev-accounts.md promises, and every one of those items opens a
 * page that renders — no bounce back home (a nav gate wider than the page
 * gate), no error boundary, no raw message key, no console error.
 */
type RoleCase = {
  account: AccountKey;
  /** Nav keys (`Nav.*`) the sidebar must show, in order. */
  nav: string[];
  /** Where `/{locale}` lands after any branch choice. */
  home: string;
  /** Whether `/{locale}` first shows the branch hub (several branches). */
  picksBranch?: boolean;
  /** Where to enter instead of `/{locale}` (a zero-centre teacher has no role the root can see). */
  entry?: string;
};

const STAFF_FULL = [
  "dashboard", "reception", "sessions", "approvals", "classes", "students", "teachers",
  "analytics", "expenses", "refunds", "settlements", "audit", "settings",
];

const ROLES: RoleCase[] = [
  { account: "owner", nav: STAFF_FULL, home: "/dashboard", picksBranch: true },
  { account: "manager", nav: STAFF_FULL, home: "/dashboard" },
  { account: "receptionist", nav: ["dashboard", "reception", "sessions", "students"], home: "/dashboard" },
  { account: "accountant", nav: ["dashboard", "analytics", "expenses"], home: "/dashboard" },
  { account: "ownerOnboarding", nav: STAFF_FULL, home: "/dashboard" },
  {
    account: "teacherDowntown",
    nav: ["dashboard", "sessions", "students", "classes", "approvals", "settlements"],
    home: "/teacher/dashboard",
  },
  {
    account: "teacherShared",
    nav: ["dashboard", "sessions", "students", "classes", "approvals", "settlements"],
    home: "/teacher/dashboard",
    picksBranch: true,
  },
  // No relation yet: the root shows the hub (with "Find a branch to teach at");
  // any teacher route sends them to the directory (M15) — never to Discover.
  { account: "teacherNew", nav: ["centers"], home: "/teacher/centers", entry: "/teacher/dashboard" },
  { account: "studentDowntown", nav: ["schedule", "discover", "reservations"], home: "/student/schedule" },
  { account: "parentFamily", nav: ["schedule"], home: "/parent" },
  { account: "admin", nav: ["centers", "platform", "catalog"], home: "/admin/centers" },
];

/** `/{locale}` → the role's home, choosing the Downtown branch on the hub when asked. */
export async function enterAs(page: Page, locale: AppLocale, picksBranch: boolean | undefined, entry?: string) {
  await page.goto(`/${locale}${entry ?? ""}`);
  if (picksBranch) {
    await page.waitForURL(/\/select-center/);
    await page.getByRole("button", { name: new RegExp(SEED.downtown) }).click();
    await page.waitForURL((url) => !url.pathname.includes("select-center"));
  }
}

/** Closes the student rating pop-up if it is open — closing persists nothing (M17). */
async function dismissRatingPopup(page: Page, locale: AppLocale) {
  const popup = page.getByRole("dialog", { name: t(locale, "RatingPopup.title") });
  if (await popup.isVisible().catch(() => false)) {
    await popup.getByRole("button", { name: t(locale, "Shared.close"), exact: true }).click();
    await expect(popup).toBeHidden();
  }
}

for (const role of ROLES) {
  test(`${role.account}: lands home, sees exactly its nav, and every item opens`, async ({ as, appLocale, problems }) => {
    const page = await as(role.account);
    await enterAs(page, appLocale, role.picksBranch, role.entry);
    await expect(page).toHaveURL(new RegExp(`/${appLocale}${role.home}$`));
    await expectHealthy(page, appLocale);
    // A student lands with the (modal) rating pop-up open when sessions await a rating.
    await dismissRatingPopup(page, appLocale);

    const nav = await primaryNav(page, appLocale);
    const links = nav.getByRole("link");
    // A pending-count badge (F7) is decoration inside the link: read the label with the
    // badge element removed (`data-nav-badge`), and the badge on its own.
    const items = await links.evaluateAll((anchors) =>
      anchors.map((a) => {
        const copy = a.cloneNode(true) as HTMLElement;
        const badges = [...copy.querySelectorAll("[data-nav-badge]")].map((b) => (b.textContent ?? "").trim());
        copy.querySelectorAll("[data-nav-badge]").forEach((b) => b.remove());
        return { name: (copy.textContent ?? "").trim(), badges };
      }),
    );
    const names = items.map((item) => item.name).filter(Boolean);
    expect(names, "the sidebar lists exactly the role's items").toEqual(role.nav.map((key) => t(appLocale, `Nav.${key}`)));
    // A badge, when present, is a number (Arabic-Indic digits in Arabic) or the capped "9+".
    const digits = appLocale === "ar" ? "[٠-٩]+" : "[0-9]+";
    const capped = t(appLocale, "Shell.pendingCapped", { max: appLocale === "ar" ? "٩" : "9" });
    for (const badge of items.flatMap((item) => item.badges)) {
      expect(badge, "a nav badge is a count or the capped count").toMatch(
        new RegExp(`^(${digits}|${capped.replace(/[+]/g, "\\+")})$`),
      );
    }
    const hrefs = await links.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));

    for (const href of hrefs) {
      await page.goto(href);
      await expect(page, `${href} must not bounce (nav gate = page gate)`).toHaveURL(new RegExp(`${href}$`));
      await expectHealthy(page, appLocale);
      await dismissRatingPopup(page, appLocale);
    }
    expect(problems).toEqual([]);
  });
}

test("a zero-centre teacher's root shows the hub, whose link leads to the directory", async ({ as, appLocale }) => {
  const page = await as("teacherNew");
  await page.goto(`/${appLocale}`);
  await expect(page).toHaveURL(/select-center/);
  await page.getByRole("link", { name: t(appLocale, "Auth.selectCenter.findCenterToTeach") }).click();
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/teacher/centers$`));
  await expectHealthy(page, appLocale);
});

test("a verified parent's root is the parent portal, not the branch hub (SYS fix)", async ({ as, appLocale }) => {
  const page = await as("parentFamily");
  await page.goto(`/${appLocale}`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/parent$`));
  await page.goto(`/${appLocale}/select-center`);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/parent$`));
});

test("a suspended centre's owner resolves no branch and gets the hub's empty state", async ({ as, appLocale }) => {
  const page = await as("ownerSuspended");
  await page.goto(`/${appLocale}`);
  await expect(page).toHaveURL(/select-center/);
  await expectHealthy(page, appLocale);
  await expect(page.getByRole("link", { name: t(appLocale, "Shell.signOut") }).or(
    page.getByRole("button", { name: t(appLocale, "Shell.signOut") }),
  )).toBeVisible();
});

test("the owner's hub offers Whole Management and both branches; the roll-up opens Analytics", async ({ as, appLocale }) => {
  const page = await as("owner");
  await page.goto(`/${appLocale}/select-center`);
  const whole = page.getByRole("button", {
    name: new RegExp(t(appLocale, "Shell.wholeManagement", { organization: SEED.organization })),
  });
  await expect(whole).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(SEED.downtown) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(SEED.nasrCity) })).toBeVisible();
  await whole.click();
  await page.waitForURL((url) => !url.pathname.includes("select-center"));
  await page.goto(`/${appLocale}/analytics`);
  await expectHealthy(page, appLocale);
  await expect(page).toHaveURL(new RegExp(`/${appLocale}/analytics`));
});

test("the language toggle keeps the page and its query string", async ({ as, appLocale }) => {
  const page = await as("manager");
  await page.goto(`/${appLocale}/sessions?range=week`);
  const other: AppLocale = appLocale === "en" ? "ar" : "en";
  await page
    .getByRole("link", { name: t(appLocale, other === "ar" ? "LocaleToggle.toArabic" : "LocaleToggle.toEnglish") })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/${other}/sessions\\?range=week`));
  await expectHealthy(page, other);
});
