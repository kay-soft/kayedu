import { expect, expectHealthy, test } from "./support/fixtures";

/**
 * Journey 5 — the accountant (SYS Part A): the baseline grant is analytics +
 * expenses and nothing else (spec §3). Settlements, refunds and the session
 * screens are refused by URL, not merely missing from the nav.
 */

test("analytics and expenses open; every other money or operations page refuses", async ({ as, appLocale }) => {
  const page = await as("accountant");
  for (const route of ["/analytics", "/expenses"]) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page).toHaveURL(new RegExp(`/${appLocale}${route}$`));
    await expectHealthy(page, appLocale);
  }
  for (const route of ["/settlements", "/refunds", "/sessions", "/reception", "/students", "/settings", "/audit"]) {
    await page.goto(`/${appLocale}${route}`);
    await expect(page, `${route} is not in the accountant's baseline`).not.toHaveURL(new RegExp(`/${appLocale}${route}$`));
  }
});
