/**
 * `npm run check:gate-fixtures` — no database.
 *
 * Every `check:*` gate names the rows it creates `<gate>-check…`. `seed:verify`
 * keeps those out of the seed-world checks and reports any left behind, using
 * the registry in `scripts/lib/gate-fixtures.ts`. This scans `scripts/*-check.ts`
 * and fails on a fixture stem that is not in the registry — a new gate (or a
 * renamed fixture) must be registered or `seed:verify` would count its rows as
 * seed-world data. It also covers the verdict rule (WARN under 30 minutes, FAIL
 * after, FAIL always under --strict-clean) with a faked age.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FIXTURE_STALE_AFTER_MS,
  GATE_FIXTURE_STEMS,
  NOT_A_FIXTURE_LITERALS,
  fixtureVerdict,
  isGateFixtureEmail,
  isGateFixtureSlug,
} from "./lib/gate-fixtures.ts";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = import.meta.dirname;
const files = readdirSync(dir).filter((file) => file.endsWith("-check.ts"));
const SHAPE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-check(?![A-Za-z0-9])/g;
const stems: readonly string[] = GATE_FIXTURE_STEMS;
const allowed: readonly string[] = NOT_A_FIXTURE_LITERALS;

const unregistered = new Map<string, string>();
for (const file of files) {
  const source = readFileSync(join(dir, file), "utf8");
  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    // Only inside a string or template literal can a name become a row.
    for (const literal of line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []) {
      if (/^["'`](?:node scripts|npm run)/.test(literal)) continue;
      for (const hit of literal.match(SHAPE) ?? []) {
        const lower = hit.toLowerCase();
        if (allowed.some((word) => lower === word || lower.endsWith(`-${word}`)) || /^(?:check|re)-/.test(lower)) continue;
        // `branches-check-u5` is covered by `branches-check`; a bare/odd stem is not.
        if (!stems.some((stem) => lower === stem || lower.endsWith(`-${stem}`) || lower.startsWith(stem))) {
          if (!unregistered.has(lower)) unregistered.set(lower, `${file}:${index + 1}`);
        }
      }
    }
  }
}

console.log("Gate fixture registry");
check(`${files.length} gate scripts scanned`, files.length > 0);
check(
  "Every fixture stem in scripts/*-check.ts is registered in scripts/lib/gate-fixtures.ts",
  unregistered.size === 0,
  [...unregistered].map(([stem, where]) => `${stem} (${where})`).join(", "),
);
check(
  "Every registered stem belongs to a gate script",
  stems.every((stem) => files.includes(`${stem}.ts`)),
  stems.filter((stem) => !files.includes(`${stem}.ts`)).join(", "),
);
check("A fixture slug is recognised by its stem", isGateFixtureSlug("branches-check-f1-home") && isGateFixtureSlug("Student-Portal-Check-A"));
check("A seed slug is not a fixture", !isGateFixtureSlug("center-60-downtown") && !isGateFixtureSlug("al-nokhba-academy"));
check("A fixture email is recognised", isGateFixtureEmail("people-check-f4-s1@kayedu.test") && isGateFixtureEmail("isolation-family-x@kayedu.test"));
check("A seed email is not a fixture", !isGateFixtureEmail("owner.center60@example.com") && !isGateFixtureEmail(null));

// The "left behind" verdict, with a faked age instead of a faked clock.
const MIN = 60_000;
check("A fixture 5 minutes old is a WARN", fixtureVerdict(5 * MIN, false) === "WARN");
check("A fixture 1 ms short of the limit is a WARN", fixtureVerdict(FIXTURE_STALE_AFTER_MS - 1, false) === "WARN");
check("A fixture at 30 minutes is a FAIL", fixtureVerdict(FIXTURE_STALE_AFTER_MS, false) === "FAIL");
check("A fixture 3 hours old is a FAIL", fixtureVerdict(180 * MIN, false) === "FAIL");
check("--strict-clean fails even a brand-new fixture", fixtureVerdict(0, true) === "FAIL");

console.log(failures === 0 ? "\nAll gate-fixture checks passed." : `\n${failures} gate-fixture check(s) failed.`);
if (failures > 0) process.exitCode = 1;
