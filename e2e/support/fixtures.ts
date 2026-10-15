import { expect, test as base, type Page } from "@playwright/test";

import { ACCOUNTS, passwordFor, storageStatePath, type AccountKey } from "./accounts";
import { namespaces, t, type AppLocale } from "./i18n";

export type TestOptions = { appLocale: AppLocale };

type Fixtures = {
  /** Problems the page reported while the test ran — asserted empty at the end. */
  problems: string[];
  /** A path in the active locale: `path("/dashboard")` → "/en/dashboard". */
  path: (route: string) => string;
  /** The active locale's message: `msg("Nav.dashboard")`. */
  msg: (key: string, values?: Record<string, string | number>) => string;
  /** A browser page signed in as a seed account (a fresh context per call). */
  as: (account: AccountKey) => Promise<Page>;
};

/** Console noise that is not the app's: dev tooling, the browser's own favicon miss. */
const BENIGN = [/Download the React DevTools/i, /favicon\.ico/i, /\[Fast Refresh\]/i, /\[HMR\]/i];
/** What counts as an app defect in the console. */
const DEFECT = /MISSING_MESSAGE|INVALID_MESSAGE|FORMATTING_ERROR|hydrat|did not match|Minified React error|Each child in a list|Cannot update a component|Uncaught/i;

function watch(page: Page, problems: string[]) {
  page.on("pageerror", (error) => problems.push(`pageerror on ${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (BENIGN.some((pattern) => pattern.test(text))) return;
    if (DEFECT.test(text)) problems.push(`console on ${page.url()}: ${text.slice(0, 300)}`);
  });
}

export const test = base.extend<TestOptions & Fixtures>({
  appLocale: ["en", { option: true }],

  problems: async ({ page }, provide) => {
    const problems: string[] = [];
    watch(page, problems);
    await provide(problems);
    expect(problems, "console errors / page errors during the test").toEqual([]);
  },

  path: async ({ appLocale }, provide) => {
    await provide((route: string) => `/${appLocale}${route === "/" ? "" : route}`);
  },

  msg: async ({ appLocale }, provide) => {
    await provide((key: string, values?: Record<string, string | number>) => t(appLocale, key, values));
  },

  as: async ({ browser, problems }, provide, testInfo) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await provide(async (account: AccountKey) => {
      const context = await browser.newContext({
        ...testInfo.project.use,
        storageState: storageStatePath(account),
      });
      contexts.push(context);
      const page = await context.newPage();
      watch(page, problems);
      return page;
    });
    // On failure, keep what each signed-in page showed (the default `page` is unused).
    if (testInfo.status !== testInfo.expectedStatus) {
      let index = 0;
      for (const context of contexts) {
        for (const opened of context.pages()) {
          index += 1;
          const shot = await opened.screenshot({ fullPage: true }).catch(() => null);
          if (shot) await testInfo.attach(`page-${index}`, { body: shot, contentType: "image/png" });
        }
      }
    }
    for (const context of contexts) await context.close();
  },
});

export { expect };

const NAMESPACE_KEY = new RegExp(`\\b(?:${namespaces().join("|")})\\.[a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*\\b`);

/**
 * The page rendered something real: one `h1`, no error boundary, no raw
 * "Namespace.key" (a missing translation next-intl printed as its key).
 */
export async function expectHealthy(page: Page, locale: AppLocale) {
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: t(locale, "Shared.error.title") })).toHaveCount(0);
  const text = await page.locator("body").innerText();
  const raw = NAMESPACE_KEY.exec(text);
  expect(raw?.[0] ?? null, "a message key rendered as text (missing translation)").toBeNull();
  // The <html> direction follows the locale (CLAUDE.md rule 5).
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
}

/** Signs in through the real login form; used by e2e/auth.setup.ts. */
export async function signIn(page: Page, account: AccountKey, locale: AppLocale = "en") {
  await page.goto(`/${locale}/login`);
  await page.getByLabel(t(locale, "Auth.fields.email"), { exact: true }).fill(ACCOUNTS[account].email);
  await page.getByLabel(t(locale, "Auth.fields.password"), { exact: true }).fill(passwordFor(account));
  await page.getByRole("button", { name: t(locale, "Auth.login.submit"), exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 120_000 });
}

/** The visible primary navigation — opening the drawer first below `lg`. */
export async function primaryNav(page: Page, locale: AppLocale) {
  const name = t(locale, "Shell.primaryNav");
  const open = page.getByRole("button", { name: t(locale, "Shell.openMenu") });
  if (await open.isVisible()) await open.click();
  const nav = page.getByRole("navigation", { name }).filter({ visible: true }).first();
  await expect(nav).toBeVisible();
  return nav;
}

/** Closes the drawer if one is open (phone widths). */
export async function closeNav(page: Page, locale: AppLocale) {
  const close = page.getByRole("button", { name: t(locale, "Shell.closeMenu") });
  if (await close.isVisible()) await close.click();
}
