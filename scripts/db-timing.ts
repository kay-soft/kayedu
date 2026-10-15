/**
 * `npm run perf:db` — DB round trips and time per request, as the owner
 * (docs/08-system-audit.md §4.6.2).
 *
 * Starts its own `next dev` with `KAYEDU_DB_STATS=1` (lib/db/client.ts prints
 * one `[kayedu:db] <ms>ms <sql>` line per statement), loads each route twice
 * with plain HTTP — no browser — using the owner session `npm run e2e` saved
 * (`e2e/.auth/owner.json`), and reports the second (warm) load: logical
 * queries, raw statements (the pgbouncer wrapper included), summed statement
 * time, wall time, and the statement shapes ranked by total time.
 *
 * Read-only against the seeded dev database. Needs no other dev server on the
 * port (default 3101, `DB_TIMING_PORT`). `DB_TIMING_JSON=<file>` also writes
 * the result as JSON.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.DB_TIMING_PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const SESSION = "e2e/.auth/owner.json";
const WRAPPER = /^(BEGIN|COMMIT|DEALLOCATE)\b/i;

type StorageState = { cookies: { name: string; value: string }[] };
const jar = new Map<string, string>();

let lines: string[] = [];

function onData(chunk: Buffer) {
  for (const line of chunk.toString().split("\n")) {
    if (line.includes("[kayedu:db]")) lines.push(line.slice(line.indexOf("[kayedu:db]")));
  }
}

function absorb(response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1));
  }
}

async function get(path: string): Promise<{ status: number; finalPath: string; body: string }> {
  let url = `${BASE}${path}`;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
    });
    absorb(response);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    return { status: response.status, finalPath: new URL(url).pathname, body: await response.text() };
  }
  throw new Error(`Too many redirects for ${path}`);
}

async function settle() {
  let last = -1;
  while (last !== lines.length) {
    last = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
}

const shapeOf = (sql: string) => sql.replace(/\$\d+/g, "$").replace(/\s+/g, " ").slice(0, 110);

async function main() {
  if (!existsSync(SESSION)) throw new Error(`No saved owner session — run \`npm run e2e\` once first.`);
  for (const cookie of (JSON.parse(readFileSync(SESSION, "utf8")) as StorageState).cookies) {
    jar.set(cookie.name, cookie.value);
  }
  // The owner holds several branches; the e2e suite's manager session names the
  // Downtown one in its active-branch cookie, and the owner owns it too.
  const branch = (JSON.parse(readFileSync("e2e/.auth/manager.json", "utf8")) as StorageState).cookies.find(
    (cookie) => cookie.name === "kayedu_center",
  );
  if (branch) jar.set(branch.name, branch.value);
  if (await fetch(`${BASE}/en/login`).then(() => true, () => false)) {
    throw new Error(`Something already listens on ${PORT} — stop it first (DB_TIMING_PORT to change).`);
  }

  const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, KAYEDU_DB_STATS: "1" },
    shell: process.platform === "win32",
  });
  server.stdout.on("data", onData);
  server.stderr.on("data", onData);

  try {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const up = await fetch(`${BASE}/en/login`).then((r) => r.status < 500, () => false);
      if (up) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    // Detail routes need real ids: read them off the lists.
    const classes = await get("/en/classes");
    const classId = /\/classes\/([0-9a-f-]{36})/.exec(classes.body)?.[1];
    const sessions = await get("/en/sessions?range=week");
    const sessionId = /\/sessions\/([0-9a-f-]{36})/.exec(sessions.body)?.[1];
    const students = await get("/en/students");
    const studentId = /\/students\/([0-9a-f-]{36})/.exec(students.body)?.[1];

    const only = process.env.DB_TIMING_ONLY;
    const routes: [string, string | undefined][] = [
      ["dashboard", "/en/dashboard"],
      ["reception", "/en/reception"],
      ["students list", "/en/students"],
      ["class detail", classId && `/en/classes/${classId}`],
      ["schedule (sessions, week)", "/en/sessions?range=week"],
      ["session detail (payments)", sessionId && `/en/sessions/${sessionId}`],
      ["student detail (payments)", studentId && `/en/students/${studentId}`],
      ["settlements", "/en/settlements"],
    ];

    const results: unknown[] = [];
    for (const [label, path] of routes) {
      if (only && !label.includes(only)) continue;
      if (!path) {
        console.log(`  ${label}: no id found in the seeded data — skipped`);
        continue;
      }
      await get(path); // compile + warm
      await settle();
      lines = [];
      const started = Date.now();
      const response = await get(path);
      const wall = Date.now() - started;
      await settle();

      const statementLines = lines.filter((line) => /^\[kayedu:db\] \d+ms /.test(line));
      const statements = statementLines.map((line) => {
        const match = /^\[kayedu:db\] (\d+)ms (.*)$/.exec(line)!;
        return { ms: Number(match[1]), sql: match[2] };
      });
      const queries = statements.filter((s) => !WRAPPER.test(s.sql));
      const dbMs = statements.reduce((sum, s) => sum + s.ms, 0);
      const shapes = new Map<string, { count: number; ms: number }>();
      for (const s of queries) {
        const shape = shapeOf(s.sql);
        const entry = shapes.get(shape) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += s.ms;
        shapes.set(shape, entry);
      }
      const ranked = [...shapes].sort((a, b) => b[1].ms - a[1].ms);
      const where = response.finalPath === path.split("?")[0] ? "" : `  (→ ${response.finalPath})`;
      console.log(
        `\n${label.padEnd(28)} ${String(queries.length).padStart(3)} queries  ${String(statements.length).padStart(3)} statements  ${String(dbMs).padStart(6)} ms db  ${String(wall).padStart(6)} ms wall  [${response.status}]${where}`,
      );
      if (process.env.DB_TIMING_DUMP === "1") {
        // The ordered statement list — to see what runs in sequence vs. together.
        for (const s of queries) console.log(`      ${String(s.ms).padStart(5)} ms  ${shapeOf(s.sql).slice(0, 90)}`);
      }
      for (const [shape, entry] of ranked.slice(0, 5)) {
        console.log(`      ${String(entry.ms).padStart(5)} ms  ${String(entry.count).padStart(2)}×  ${shape}`);
      }
      results.push({ label, path, queries: queries.length, statements: statements.length, dbMs, wall, status: response.status, top: ranked.slice(0, 8) });
    }
    if (process.env.DB_TIMING_JSON) writeFileSync(process.env.DB_TIMING_JSON, JSON.stringify(results, null, 2));
  } finally {
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
    else server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
