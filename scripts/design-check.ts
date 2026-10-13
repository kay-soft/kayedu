/**
 * Design-pass check — the R10a gate (docs/03-build-order.md R10a,
 * docs/04-design-system.md §5 "Language toggle" / "Page header" / "Filter row").
 *
 * Run with:  npm run check:design
 *
 * CLAUDE.md rule 1 forbids browser testing, so — like `check:rtl` — this
 * statically enforces the mechanisms the presentation pass put in place so
 * they cannot quietly regress:
 *
 *   1. There is exactly one locale switch (`LocaleToggle`), it carries the
 *      query string across, and it is rendered by every shell and the auth
 *      layout. No second locale-switching component or `Link locale=` exists.
 *   2. No nav item is `disabled`, and the "Soon" row is gone from the shell.
 *   3. No native `<select>` in `app/` or `components/` (the shadcn/Base UI
 *      `Select` is the product's one dropdown).
 *   4. No hardcoded hex colour, and no arbitrary or palette-scale colour
 *      class, in `app/` or `components/` — apart from a short, justified
 *      allowlist below. Colour comes from the tokens in `app/globals.css`.
 *   5. KPI cards carry no accent colour (semantic colours are for status
 *      only), and the dashboard does not reintroduce one.
 *   6. Every page is covered by `docs/06-design-pass-survey.md`, and every
 *      page that is not an auth/print/redirect screen opens with
 *      `PageHeader` (directly, or through its route group's layout).
 *   7. The sidebar, the header and the branch switcher all take the centre's
 *      name from the same `brand.name`, so the avatar initial cannot drift
 *      from the label beside it.
 *
 * Pure static analysis — no database needed. (The "no change under prisma/,
 * lib/db/, lib/money.ts, lib/auth/" constraint is reported with
 * `git diff --stat` in the R10a summary rather than gated here.)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every `.tsx`/`.ts` source file under `app/` and `components/`, repo-relative. */
function uiFiles(): string[] {
  return [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    .filter((file) => /\.(tsx|ts)$/.test(file))
    .map((file) => norm(relative(ROOT, file)));
}

/** Source with block and line comments blanked, so prose is never matched. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const FILES = uiFiles();

// ── 1. One locale toggle ────────────────────────────────────────────────────

function checkLocaleToggle() {
  console.log("Language toggle");

  const toggleFile = "components/shared/locale-toggle.tsx";
  check("components/shared/locale-toggle.tsx exists", existsSync(join(ROOT, toggleFile)));

  const stray = FILES.filter((file) => /locale-?(switch|toggle|picker|select)/i.test(file) && file !== toggleFile);
  check("No other locale-switch component file exists", stray.length === 0, stray.join(", "));

  // The only place a locale is chosen to navigate to is the toggle: nothing
  // else may iterate `routing.locales` or pass `locale=` to a `Link`.
  const importsRouting: string[] = [];
  const linkWithLocale: string[] = [];
  const routerSwitch: string[] = [];
  for (const file of FILES) {
    if (file === toggleFile) continue;
    // The root layout validates the URL's locale and enumerates static params;
    // it never offers the user a choice of language.
    if (file === "app/[locale]/layout.tsx") continue;
    const source = stripComments(read(file));
    if (/from\s+["']@\/lib\/i18n\/routing["']/.test(source)) importsRouting.push(file);
    const flat = source.replace(/\n/g, " ");
    if (/<Link\b[^>]*\blocale=/.test(flat)) linkWithLocale.push(file);
    if (/\.(replace|push)\([^)]*\{\s*locale\b/.test(flat)) routerSwitch.push(file);
  }
  check("Nothing but the toggle imports the locale list (routing)", importsRouting.length === 0, importsRouting.join(", "));
  check('No other component passes `locale=` to a Link', linkWithLocale.length === 0, linkWithLocale.join(", "));
  check("No other component switches locale through the router", routerSwitch.length === 0, routerSwitch.join(", "));

  const toggle = read(toggleFile);
  check("The toggle carries the query string (useSearchParams)", /useSearchParams/.test(toggle));
  check("The toggle navigates with next-intl's Link and the target locale", /<Link\b[\s\S]*?locale=\{target\}/.test(toggle));
  check("The toggle is wrapped in Suspense (useSearchParams)", /<Suspense/.test(toggle));
  check("The toggle names its target in aria-label", /aria-label=\{label\}/.test(toggle));

  const renderers = [
    "components/shell/app-shell.tsx",
    "app/[locale]/(auth)/layout.tsx",
    "app/[locale]/not-found.tsx",
  ];
  for (const file of renderers) {
    check(`${file} renders <LocaleToggle />`, /<LocaleToggle\b/.test(read(file)));
  }

  // Every experience layout is a shell, and a shell is `AppShell`.
  for (const group of ["(center)", "(teacher)", "(student)", "(parent)", "(admin)"]) {
    const layout = `app/[locale]/${group}/layout.tsx`;
    check(`${layout} wraps its pages in AppShell`, /<AppShell\b/.test(read(layout)));
  }
}

// ── 2. No "Soon" / disabled nav ─────────────────────────────────────────────

function checkNav() {
  console.log("\nNavigation");

  const nav = stripComments(read("components/shell/nav.ts"));
  check("No nav item is `disabled`", !/\bdisabled\b/.test(nav));

  const navItem = stripComments(read("components/shell/nav-item.tsx"));
  check("NavItem has no disabled/'Soon' branch", !/disabled|soon/i.test(navItem));

  const shell = stripComments(read("components/shell/app-shell.tsx"));
  check("AppShell passes no 'Soon' label", !/soon/i.test(shell));

  for (const locale of ["en", "ar"]) {
    const messages = JSON.parse(read(`messages/${locale}.json`));
    check(`messages/${locale}.json has no Shell.soon key`, !("soon" in (messages.Shell ?? {})));
  }
}

// ── 3. No native <select> ───────────────────────────────────────────────────

function checkNativeSelect() {
  console.log("\nControls");

  const offenders = FILES.filter((file) => {
    if (!file.endsWith(".tsx")) return false;
    return /<select[\s>]/.test(stripComments(read(file)));
  });
  check("No native <select> in app/ or components/", offenders.length === 0, offenders.join(", "));
}

// ── 4. Tokens, not hardcoded colours ────────────────────────────────────────

/**
 * Files allowed to carry a hex literal, each with the reason. Anything not
 * listed here must take its colour from `app/globals.css`.
 */
const HEX_ALLOWLIST: Record<string, string> = {
  "app/[locale]/(admin)/admin/centers/create-center-form.tsx":
    "the new-centre form's default theme colour — the same value as the --brand token, stored as data",
  "app/[locale]/(admin)/layout.tsx": "the platform-admin shell's default brand — the --brand token's value, passed as data",
  "app/[locale]/(parent)/layout.tsx": "the parent shell's default brand — the --brand token's value, passed as data",
  "app/[locale]/(teacher)/layout.tsx": "the zero-centre teacher shell's default brand — the --brand token's value, passed as data",
  "app/[locale]/(center)/settings/card/card-style-controls.tsx":
    "ID-card colour swatches and fallbacks — a centre's own card colours are user content, not UI chrome",
};

const COLOUR_UTILITIES = "bg|text|border|ring|outline|divide|fill|stroke|from|to|via|shadow|accent|caret|decoration|placeholder";
const PALETTE_NAMES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

function checkTokens() {
  const hexOffenders: string[] = [];
  const arbitrary: string[] = [];
  const palette: string[] = [];

  for (const file of FILES) {
    if (!file.endsWith(".tsx")) continue;
    const source = stripComments(read(file));
    if (/#[0-9a-fA-F]{3,8}\b/.test(source) && !(file in HEX_ALLOWLIST)) hexOffenders.push(file);
    if (new RegExp(`\\b(${COLOUR_UTILITIES})-\\[(#|rgb|hsl|oklch|color)`).test(source)) arbitrary.push(file);
    if (new RegExp(`\\b(${COLOUR_UTILITIES})-(${PALETTE_NAMES})-\\d{2,3}\\b`).test(source)) palette.push(file);
  }

  check("No hex colour outside the justified allowlist", hexOffenders.length === 0, hexOffenders.join(", "));
  check("No arbitrary colour class (bg-[#…], text-[rgb(…)])", arbitrary.length === 0, arbitrary.join(", "));
  check("No palette-scale colour class (bg-green-500, text-slate-900, …)", palette.length === 0, palette.join(", "));

  for (const [file, reason] of Object.entries(HEX_ALLOWLIST)) {
    check(`Allowlisted file still exists: ${file}`, existsSync(join(ROOT, file)), reason);
  }
}

// ── 5. Semantic colours are for status only ─────────────────────────────────

function checkNoDecorativeAccents() {
  console.log("\nKPI cards");

  const statCard = stripComments(read("components/shared/stat-card.tsx"));
  check("StatCard has no accent prop / top-border colour", !/\baccent\b/.test(statCard));

  const offenders = FILES.filter((file) => file.endsWith(".tsx") && /<StatCard\b[^>]*\baccent=/.test(stripComments(read(file)).replace(/\n/g, " ")));
  check("No page passes accent= to a StatCard", offenders.length === 0, offenders.join(", "));

  const dashboard = stripComments(read("app/[locale]/(center)/dashboard/page.tsx"));
  check(
    "The dashboard colours nothing but status badges (no success/warning/info utilities outside <Badge>)",
    !/\b(?:bg|text|border|ring)-(?:success|warning|info|danger)\b/.test(dashboard),
  );
}

// ── 6. Survey coverage and PageHeader ───────────────────────────────────────

/** Pages that are not "a page with a title": signed-out, print, or redirect-only. */
const PAGEHEADER_EXEMPT: Record<string, string> = {
  "app/[locale]/page.tsx": "entry redirect — renders nothing",
  "app/[locale]/(student)/student/profile/page.tsx": "redirect-only (the layout renders the profile form)",
  "app/[locale]/(auth)/login/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/register/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/invite/[token]/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/select-center/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(print)/sessions/[id]/print/page.tsx": "print sheet — no app chrome",
  "app/[locale]/(print)/students/[id]/card/page.tsx": "print sheet — no app chrome",
  "app/[locale]/(print)/students/[id]/paper/page.tsx": "print sheet — no app chrome",
  "app/[locale]/(print)/teacher/sessions/[id]/print/page.tsx": "print sheet — no app chrome",
};

function checkPages() {
  console.log("\nPages");

  const pages = FILES.filter((file) => file.endsWith("/page.tsx") && file.startsWith("app/[locale]/"));
  const survey = read("docs/06-design-pass-survey.md");

  const unsurveyed = pages.filter((page) => !survey.includes(page));
  check(
    `docs/06-design-pass-survey.md covers every page (${pages.length})`,
    unsurveyed.length === 0,
    unsurveyed.join(", "),
  );

  const missing: string[] = [];
  for (const page of pages) {
    if (page in PAGEHEADER_EXEMPT) continue;
    if (/<PageHeader\b/.test(read(page))) continue;
    // A route group's (or the settings section's) layout may supply it.
    const segments = page.split("/");
    let covered = false;
    for (let depth = segments.length - 1; depth >= 2; depth -= 1) {
      const layout = [...segments.slice(0, depth), "layout.tsx"].join("/");
      if (existsSync(join(ROOT, layout)) && /<PageHeader\b/.test(read(layout))) {
        covered = true;
        break;
      }
    }
    if (!covered) missing.push(page);
  }
  check("Every non-exempt page opens with PageHeader (itself or via its layout)", missing.length === 0, missing.join(", "));

  for (const exempt of Object.keys(PAGEHEADER_EXEMPT)) {
    check(`Exempt page still exists: ${exempt}`, existsSync(join(ROOT, exempt)));
  }
}

// ── 7. One name for the centre across the shell ─────────────────────────────

function checkShellBrandName() {
  console.log("\nShell branding");

  const shell = stripComments(read("components/shell/app-shell.tsx"));
  const flatShell = shell.replace(/\n/g, " ");
  check("The sidebar avatar takes brand.name", /<BrandAvatar[^>]*\bname=\{brand\.name\}/.test(flatShell));
  check("The branch switcher takes brand.name", /<BranchSwitcher[^>]*\bactiveName=\{brand\.name\}/.test(flatShell));
  check("The header's own label is brand.name", /\{brand\.name\}\s*<\/span>/.test(shell));

  // `name.charAt(0)` (half a surrogate pair, takes a quote mark, ignores the
  // generic-word rule) is what once made two screens disagree with the
  // sidebar about a centre's initial. `BrandAvatar` is the only way to draw one.
  const rawInitials = FILES.filter(
    (file) => file.endsWith(".tsx") && /\.name\.trim\(\)\.charAt\(0\)/.test(stripComments(read(file))),
  );
  check("No screen derives a centre initial with name.charAt(0)", rawInitials.length === 0, rawInitials.join(", "));
}

checkLocaleToggle();
checkNav();
checkNativeSelect();
console.log("\nTokens");
checkTokens();
checkNoDecorativeAccents();
checkPages();
checkShellBrandName();

if (failures > 0) {
  console.error(`\n${failures} design check(s) failed.`);
  process.exit(1);
}
console.log("\nAll design checks passed.");
