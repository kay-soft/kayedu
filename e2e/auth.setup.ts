import { existsSync, statSync } from "node:fs";

import { test as setup } from "@playwright/test";

import { ACCOUNTS, storageStatePath, type AccountKey } from "./support/accounts";
import { signIn } from "./support/fixtures";

/**
 * Signs every seed account in once, through the real login form, and saves
 * its session (e2e/.auth/<account>.json, git-ignored). The specs reuse those
 * sessions instead of signing in per test — sign-in is rate-limited per email
 * and per IP (lib/rate-limit.ts: 50 per IP per 10 minutes), so a suite that
 * logged in on every test, or on every re-run, would lock itself out. A saved
 * session younger than `E2E_SESSION_MAX_AGE_MIN` (default 50; Supabase access
 * tokens refresh from the cookie) is reused as it is.
 */
const MAX_AGE_MS = Number(process.env.E2E_SESSION_MAX_AGE_MIN ?? 50) * 60_000;

for (const account of Object.keys(ACCOUNTS) as AccountKey[]) {
  setup(`sign in as ${account}`, async ({ browser }) => {
    const path = storageStatePath(account);
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, account);
    await context.storageState({ path });
    await context.close();
  });
}
