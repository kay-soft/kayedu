/**
 * RTL check — the M10 acceptance gate for spec §7 acceptance criterion 15:
 * "Every screen renders correctly in Arabic RTL and English LTR."
 *
 * Run with:  npm run check:rtl
 *
 * CLAUDE.md rule 1 forbids browser testing, so this cannot literally render
 * every screen in both directions — it statically enforces the mechanisms
 * docs/02-architecture.md §8 requires for RTL to work at all, the same way
 * the other gates enforce their milestone's mechanism rather than clicking
 * through the UI:
 *
 *   1. Every translation key in messages/en.json exists in messages/ar.json
 *      and vice versa — a missing Arabic string is the single most common
 *      way a screen "renders wrong" in RTL (a raw i18n key, or an English
 *      fallback breaking the reading direction mid-sentence).
 *   2. No physical-direction Tailwind utility (`pl-`, `pr-`, `ml-`, `mr-`,
 *      `left-`, `right-`, `text-left`, `text-right`, `float-left`,
 *      `float-right`, `border-l*`, `border-r*`, `rounded-l*`, `rounded-r*`,
 *      `rounded-tl*`/`tr*`/`bl*`/`br*`) appears in `app/` or `components/` —
 *      CLAUDE.md rule 5 and docs/02 §8 require logical properties
 *      (`ps-`/`pe-`, `start-`/`end-`) exclusively, precisely because a
 *      physical-direction class does not flip for `ar`.
 *   3. No inline `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`
 *      call outside `lib/format.ts` — docs/02 §8 requires every number/date
 *      to go through `lib/format.ts` so Arabic-Indic numerals render in
 *      `ar` and Latin numerals in `en`.
 *   4. The root locale layout actually sets `dir` from the locale (the one
 *      mechanism everything else depends on).
 *
 * Pure static analysis — no database needed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. Translation key parity between ar.json and en.json ──────────────────

/** Every dotted leaf-key path in a nested messages object, e.g. "Sessions.errors.notFound". */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(...flattenKeys(value, path));
  }
  return keys;
}

function checkTranslationParity() {
  console.log("Translation key parity (messages/en.json ↔ messages/ar.json)");

  const en = JSON.parse(readFileSync(join(ROOT, "messages/en.json"), "utf8"));
  const ar = JSON.parse(readFileSync(join(ROOT, "messages/ar.json"), "utf8"));

  const enKeys = new Set(flattenKeys(en));
  const arKeys = new Set(flattenKeys(ar));

  const missingInAr = [...enKeys].filter((key) => !arKeys.has(key));
  const missingInEn = [...arKeys].filter((key) => !enKeys.has(key));

  check(
    `Every en.json key exists in ar.json (${enKeys.size} keys checked)`,
    missingInAr.length === 0,
    missingInAr.slice(0, 20).join(", ") + (missingInAr.length > 20 ? ` … and ${missingInAr.length - 20} more` : ""),
  );
  check(
    `Every ar.json key exists in en.json (${arKeys.size} keys checked)`,
    missingInEn.length === 0,
    missingInEn.slice(0, 20).join(", ") + (missingInEn.length > 20 ? ` … and ${missingInEn.length - 20} more` : ""),
  );

  // A translation left byte-for-byte identical to English is very often a
  // string someone forgot to actually translate (numbers/brand names/URLs
  // are legitimate exceptions, so this is a count, not a hard failure).
  let identicalCount = 0;
  for (const key of enKeys) {
    if (!arKeys.has(key)) continue;
    const enValue = getPath(en, key);
    const arValue = getPath(ar, key);
    if (
      typeof enValue === "string" &&
      typeof arValue === "string" &&
      enValue === arValue &&
      /[A-Za-z]{3,}/.test(enValue)
    ) {
      identicalCount++;
    }
  }
  if (identicalCount > 0) {
    console.log(`  INFO  ${identicalCount} string(s) are byte-identical between en.json and ar.json — spot-check these are intentional (brand names, numbers), not forgotten translations.`);
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[segment];
  }, obj);
}

// ── 2. No physical-direction Tailwind utilities in app/ or components/ ─────

const FORBIDDEN_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "pl-/pr- (physical padding)", regex: /\b(pl|pr)-\[?-?\d/ },
  { name: "ml-/mr- (physical margin)", regex: /\b(ml|mr)-\[?-?\d/ },
  { name: "left-/right- (physical position)", regex: /\b(left|right)-\[?-?\d/ },
  { name: "text-left/text-right", regex: /\btext-(left|right)\b/ },
  { name: "float-left/float-right", regex: /\bfloat-(left|right)\b/ },
  { name: "border-l*/border-r* (physical border side)", regex: /\bborder-[lr](?:-\S+)?\b/ },
  { name: "rounded-l*/rounded-r*/rounded-t[lr]*/rounded-b[lr]* (physical corner)", regex: /\brounded-(l|r|tl|tr|bl|br)(?:-\S+)?\b/ },
  { name: "inset-l-/inset-r- ", regex: /\binset-(l|r)-\[?-?\d/ },
];

/** Files intentionally excluded — vendor/generated code this repo does not author. */
const EXCLUDED_PATH_SEGMENTS = ["node_modules", ".next", "components/ui/"];

function shouldScan(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return !EXCLUDED_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (shouldScan(full)) walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && shouldScan(full)) {
      out.push(full);
    }
  }
  return out;
}

function checkNoPhysicalDirectionClasses() {
  console.log("\nLogical CSS properties only (docs/02-architecture.md §8, CLAUDE.md rule 5)");

  const files = [
    ...walk(join(ROOT, "app")),
    ...walk(join(ROOT, "components")),
  ];

  const hits: { file: string; line: number; pattern: string; text: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(line)) {
          hits.push({ file: relative(ROOT, file), line: index + 1, pattern: name, text: line.trim() });
        }
      }
    });
  }

  check(
    `No physical-direction Tailwind utility across ${files.length} files under app/ and components/`,
    hits.length === 0,
    hits
      .slice(0, 15)
      .map((h) => `${h.file}:${h.line} [${h.pattern}] ${h.text}`)
      .join("\n    ") + (hits.length > 15 ? `\n    … and ${hits.length - 15} more` : ""),
  );
}

// ── 3. Number/date formatting always goes through lib/format.ts ────────────

function checkNoInlineLocaleFormatting() {
  console.log("\nNumber/date formatting through lib/format.ts only (docs/02-architecture.md §8)");

  const files = [
    ...walk(join(ROOT, "app")),
    ...walk(join(ROOT, "components")),
    ...walk(join(ROOT, "lib")).filter((f) => !f.replace(/\\/g, "/").endsWith("lib/format.ts")),
  ];

  const pattern = /\.toLocale(String|DateString|TimeString)\s*\(/;
  const hits: { file: string; line: number }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push({ file: relative(ROOT, file), line: index + 1 });
    });
  }

  check(
    "No inline toLocaleString/toLocaleDateString/toLocaleTimeString outside lib/format.ts",
    hits.length === 0,
    hits.map((h) => `${h.file}:${h.line}`).join(", "),
  );
}

// ── 4. The root layout actually wires dir from the locale ──────────────────

function checkRootLayoutDirWiring() {
  console.log("\nRoot layout dir/lang wiring");

  const layoutPath = join(ROOT, "app/[locale]/layout.tsx");
  const source = readFileSync(layoutPath, "utf8");

  check(
    "app/[locale]/layout.tsx sets dir from the locale (rtl for ar, ltr otherwise)",
    /dir\s*=\s*\{?\s*(?:dir\b|.*?===\s*["']ar["'].*?["']rtl["'])/.test(source),
  );
  check(
    "app/[locale]/layout.tsx sets <html lang={locale}>",
    /<html[^>]*\blang=\{?\s*locale\b/.test(source),
  );
}

checkTranslationParity();
checkNoPhysicalDirectionClasses();
checkNoInlineLocaleFormatting();
checkRootLayoutDirWiring();

if (failures > 0) {
  console.error(`\n${failures} RTL check(s) failed.`);
  process.exit(1);
}
console.log("\nAll RTL checks passed.");
