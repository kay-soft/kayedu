import type { Page, TestInfo } from "@playwright/test";

import { test } from "./fixtures";
import { t, type AppLocale } from "./i18n";

/**
 * Sign-up is rate-limited per IP (10 an hour, lib/rate-limit.ts), so the
 * journeys that create accounts run in ONE project only — `en-1280` — and
 * the suite stays re-runnable within the hour.
 */
export function signUpProjectOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "en-1280", "account-creating journeys run in en-1280 only (sign-up is rate-limited per IP)");
}

/** A password that satisfies the sign-up rule (≥ 8 characters). */
export const E2E_PASSWORD = "e2e-Passw0rd!";

export async function signUp(
  page: Page,
  locale: AppLocale,
  person: { firstName: string; lastName: string; email: string; phone?: string },
) {
  await page.goto(`/${locale}/register`);
  await page.getByLabel(t(locale, "Auth.fields.firstName"), { exact: true }).fill(person.firstName);
  await page.getByLabel(t(locale, "Auth.fields.lastName"), { exact: true }).fill(person.lastName);
  await page.getByLabel(t(locale, "Auth.fields.email"), { exact: true }).fill(person.email);
  if (person.phone) await page.getByLabel(new RegExp(`^${t(locale, "Auth.fields.phone")}`)).fill(person.phone);
  await page.getByLabel(t(locale, "Auth.fields.password"), { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel(t(locale, "Auth.fields.confirmPassword"), { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: t(locale, "Auth.register.submit"), exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/register"), { timeout: 120_000 });
}

export async function signInWith(page: Page, locale: AppLocale, email: string) {
  await page.goto(`/${locale}/login`);
  await page.getByLabel(t(locale, "Auth.fields.email"), { exact: true }).fill(email);
  await page.getByLabel(t(locale, "Auth.fields.password"), { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: t(locale, "Auth.login.submit"), exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 120_000 });
}
