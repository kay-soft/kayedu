import { defineConfig, devices } from "@playwright/test";

import type { TestOptions } from "./e2e/support/fixtures";
import { assertSafeToWrite, loadEnv } from "./scripts/lib/env";

/**
 * The end-to-end smoke suite (SYS, docs/02 §15, docs/08). `npm run e2e`
 * runs it headless against the LOCAL dev server and a seeded database
 * (`npm run db:seed`), signing in as the seed accounts of
 * `docs/dev-accounts.md` with `SEED_PASSWORD` / `SEED_ADMIN_PASSWORD` from
 * `.env` — or, with `KAYEDU_ENV=staging`, from `.env.staging` against the staging
 * project, which is the only place it may run (docs/staging.md). Not in CI yet (M20).
 *
 * Four projects = the two locales × the two widths the design system
 * guarantees (docs/04 §6: 1280 desktop, 375 the floor). Every spec's
 * read-only primary paths run in all four; steps that write (tagged
 * `@write`) run in `en-1280` and `ar-375` only — both locales and both
 * widths, without writing the same data four times. Writes use their own
 * uniquely named data and clean up what they can; nothing is ever wiped.
 */
// The same loader as every script (KAYEDU_ENV=staging reads .env.staging), then the
// write fence: the suite signs in and writes, so it only runs against staging or a
// local database, never the dev project (S1, docs/staging.md).
loadEnv();
assertSafeToWrite("npm run e2e");

const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } };
const phone = {
  ...devices["Desktop Chrome"],
  viewport: { width: 375, height: 812 },
  isMobile: false,
  hasTouch: true,
};

export default defineConfig<TestOptions>({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  // A dev server compiles each route on its first request: generous limits.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],
  use: {
    baseURL,
    headless: true,
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: desktop },
    { name: "en-1280", dependencies: ["setup"], use: { ...desktop, appLocale: "en" } },
    { name: "ar-1280", dependencies: ["setup"], grepInvert: /@write/, use: { ...desktop, appLocale: "ar" } },
    { name: "en-375", dependencies: ["setup"], grepInvert: /@write/, use: { ...phone, appLocale: "en" } },
    { name: "ar-375", dependencies: ["setup"], use: { ...phone, appLocale: "ar" } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: `${baseURL}/en/login`,
        reuseExistingServer: true,
        timeout: 300_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
