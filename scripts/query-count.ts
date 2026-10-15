/**
 * `npm run perf:queries` (SYS) — how many SQL statements each hot page issues
 * per request, to find N+1 loaders (docs/08-system-audit.md "Performance").
 *
 * Starts its own `next dev` with `KAYEDU_QUERY_LOG=1` (Prisma then prints
 * every statement as `prisma:query …`), signs nothing in itself — it reuses
 * the sessions the e2e suite saved (`e2e/.auth/*.json`, run `npm run e2e`
 * once first) — loads each page twice (the first load compiles the route)
 * and counts the statements logged during the second. A count that grows
 * with the data on the page is an N+1; a flat count is fine.
 *
 * Read-only against the seeded dev database. Needs no other dev server on
 * the port (default 3100, `QUERY_COUNT_PORT`).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { chromium, type BrowserContext } from "@playwright/test";

const PORT = Number(process.env.QUERY_COUNT_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;

/** [label, saved session, path] — the screens docs/02 §14 names as hot. */
const PAGES: [string, string, string][] = [
  ["dashboard", "manager", "/en/dashboard"],
  ["reception", "receptionist", "/en/reception"],
  ["sessions (week)", "manager", "/en/sessions?range=week"],
  ["students list", "manager", "/en/students"],
  ["teachers list", "manager", "/en/teachers"],
  ["classes list", "manager", "/en/classes"],
  ["analytics (month)", "manager", "/en/analytics?range=month"],
  ["approvals", "manager", "/en/approvals"],
  ["settlements", "manager", "/en/settlements"],
  ["audit", "manager", "/en/audit"],
  ["teacher dashboard", "teacherShared", "/en/teacher/dashboard"],
  ["student schedule", "studentDowntown", "/en/student/schedule"],
  ["parent portal", "parentFamily", "/en/parent"],
];

let logged = 0;
/** Every statement logged, in order — `QUERY_COUNT_DUMP=1` groups them per page. */
const statements: string[] = [];
const DUMP = process.env.QUERY_COUNT_DUMP === "1";

async function main() {
  for (const [, account] of PAGES) {
    if (!existsSync(`e2e/.auth/${account}.json`)) {
      throw new Error(`No saved session for ${account} — run \`npm run e2e\` (its setup project) first.`);
    }
  }
  // Another server on the port would answer instead of ours — its statements
  // would never reach this process and every count would read 0.
  if (await fetch(`${BASE}/en/login`).then(() => true, () => false)) {
    throw new Error(`Something already listens on ${PORT} — stop it first (QUERY_COUNT_PORT to change).`);
  }
  const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, KAYEDU_QUERY_LOG: "1" },
    shell: process.platform === "win32",
  });
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    logged += (text.match(/prisma:query/g) ?? []).length;
    if (DUMP) for (const m of text.matchAll(/prisma:query ([^\n]*)/g)) statements.push(m[1]);
  };
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const contexts = new Map<string, BrowserContext>();
    const rows: { label: string; queries: number; ms: number }[] = [];
    for (const [label, account, path] of PAGES) {
      let context = contexts.get(account);
      if (!context) {
        context = await browser.newContext({ storageState: JSON.parse(readFileSync(`e2e/.auth/${account}.json`, "utf8")) });
        contexts.set(account, context);
      }
      const page = await context.newPage();
      // "load", not "networkidle": the dev server keeps an HMR connection open.
      await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 300_000 }); // compile + warm
      await settle();
      const before = logged;
      const firstStatement = statements.length;
      const started = Date.now();
      await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 300_000 });
      await settle();
      rows.push({ label, queries: logged - before, ms: Date.now() - started });
      console.log(`  ${label.padEnd(22)} ${String(logged - before).padStart(4)} queries`);
      if (DUMP) {
        // The same statement shape repeated with different ids is an N+1.
        const shapes = new Map<string, number>();
        for (const sql of statements.slice(firstStatement)) {
          const shape = sql.replace(/\$\d+/g, "$").replace(/\s+/g, " ").slice(0, 160);
          shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        }
        for (const [shape, count] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
          console.log(`      ${String(count).padStart(3)} × ${shape}`);
        }
      }
      await page.close();
    }
    await browser.close();
    console.log("\nSQL statements per request (second load)\n");
    for (const row of rows) console.log(`  ${row.label.padEnd(22)} ${String(row.queries).padStart(4)} queries  ${row.ms} ms`);
  } finally {
    // The whole tree (npx → next → the server), synchronously, so no
    // server outlives the run and answers the next one.
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
    else server.kill("SIGTERM");
  }
}

/** Waits until no new statement was logged for a moment (streamed parts finish late). */
async function settle() {
  let last = -1;
  while (last !== logged) {
    last = logged;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/en/login`);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("next dev did not start");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
