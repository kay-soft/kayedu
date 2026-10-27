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
 *   8. (R10b) The initials rule: the first letter of the displayed name, no
 *      leading-word skipping, Arabic and Latin — asserted by running
 *      `lib/initials.ts`, not by reading it.
 *   9. (R10b) The four detail pages open with `PageHeader` and lay out with
 *      `DetailLayout`; their verbs are one `ActionBar`; the student and teacher
 *      Delete lives in `DeleteRecordCard`, not in the edit form.
 *  10. (R10b) The Add student / Add teacher dialogs are the shared
 *      `DialogShell` with `FormSection`s (mounted by `DialogLauncher`), keep
 *      what was typed on a refused submit, and put the duplicate-match panel
 *      under the phone field.
 *
 * 12. (T4) URL state is soft: no GET filter form outside the shared
 *      interceptor (`UrlFilterForm`; Reception's scan field is the one
 *      allow-listed hard submit), every pager/tab link is a `SoftLink`, every
 *      list/report page marks its results with `ResultsRegion`, and the merge
 *      that turns a submitted form into the next query string is asserted by
 *      running it (`lib/ui/url-filter-params.ts`).
 *
 * 13. (T6) Whole Management is analytics-only: every `"use server"` file
 *      under `(center)` calls `requireBranchScope` straight after each
 *      `getTenantContext(` (an allowlist, with a reason per entry, is the only
 *      way out); every centre page — and every centre print page — except
 *      Analytics returns `PickBranchScreen` straight after its context (the
 *      Dashboard redirects to Analytics); the T1 `RollupNotice` is gone; and
 *      the guard itself is asserted by running it (`lib/auth/branch-scope.ts`).
 *
 * Pure static analysis — no database needed. (The "no change under prisma/,
 * lib/db/, lib/money.ts, lib/auth/" constraint is reported with
 * `git diff --stat` in the R10a summary rather than gated here.)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import { PICK_BRANCH, isPickBranch, requireBranchScope } from "../lib/auth/branch-scope.ts";
import { centerInitial, nameInitial, personInitials } from "../lib/initials.ts";
import { mergeFilterParams } from "../lib/ui/url-filter-params.ts";

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
    "components/shared/public-header.tsx",
  ];
  for (const file of renderers) {
    check(`${file} renders <LocaleToggle />`, /<LocaleToggle\b/.test(read(file)));
  }
  // DES: every screen outside a shell carries the public header (mark + toggle).
  for (const file of ["app/[locale]/not-found.tsx", "app/[locale]/error.tsx", "app/[locale]/page.tsx"]) {
    check(`${file} renders <PublicHeader />`, /<PublicHeader\b/.test(read(file)));
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
  "app/[locale]/layout.tsx":
    "the viewport themeColor for the mobile browser's chrome — the --bg-canvas token's value, which Next needs as a literal (DES)",
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

  // DES (docs/04 §2): text drawn in a status colour uses the darker `-fg`
  // shade — the base shades failed AA on their own tints (amber 1.93:1).
  const baseStatusText = FILES.filter(
    (file) => file.endsWith(".tsx") && /text-(success|warning|danger|info|destructive)(?!-)/.test(stripComments(read(file))),
  );
  check(
    "Status-coloured text uses the -fg shade (text-success-fg …), never the base token",
    baseStatusText.length === 0,
    baseStatusText.join(", "),
  );
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
  "app/[locale]/page.tsx":
    "entry point — redirects a signed-in visitor home; signed out it is the public landing, whose h1 is the product name (DES)",
  "app/[locale]/[...rest]/page.tsx": "unknown-path catch-all — calls notFound(), renders nothing (DES)",
  "app/[locale]/(student)/student/profile/page.tsx": "redirect-only (the layout renders the profile form)",
  "app/[locale]/(auth)/login/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/register/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/invite/[token]/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/select-center/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/account-pending/page.tsx": "signed-out screen — AuthCard carries the heading",
  "app/[locale]/(auth)/family/join/page.tsx": "auth screen (F3, guests too) — AuthCard carries the heading",
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

// ── 8. Initials: the first letter of the displayed name ─────────────────────

function checkInitials() {
  console.log("\nInitials");

  const cases: [string, string, string][] = [
    // [name as displayed, expected, why]
    ["مركز النور", "م", "Arabic: no skipping of the generic word مركز"],
    ["النور", "ا", "Arabic: the literal first letter (the article ال is not skipped either)"],
    ["أحمد علي", "أ", "Arabic person: the hamza stays on the letter"],
    ["Nour Academy", "N", "Latin: first letter"],
    ["Academy of Nour", "A", "Latin: a generic leading word is not skipped"],
    ["The Nile School", "T", "Latin: 'The' is not skipped"],
    ["nour", "N", "Latin: upper-cased"],
    ['"نور"', "ن", "a leading quote mark is not the initial"],
    ["  (Nour)", "N", "leading whitespace and a bracket are not the initial"],
    ["\u{1D4D0}bc", "\u{1D4D0}", "astral code point is kept whole, not half a surrogate"],
    ["7 Stars", "7", "a digit counts"],
    ["", "?", "empty"],
    ["—", "?", "no letter or digit at all"],
  ];
  for (const [name, expected, why] of cases) {
    check(
      `nameInitial(${JSON.stringify(name)}) = ${expected} — ${why}`,
      nameInitial(name) === expected,
      `got ${nameInitial(name)}`,
    );
  }

  check("centerInitial is the same rule as nameInitial", centerInitial === nameInitial);
  check(
    "centerInitial('مركز النور') = م (the sidebar shows the first letter it displays)",
    centerInitial("مركز النور") === "م",
  );
  check("personInitials('Mona', 'Salem') = MS", personInitials("Mona", "Salem") === "MS");
  check("personInitials('منى', 'سالم') = مس", personInitials("منى", "سالم") === "مس");
  check("personInitials('Mona', '-') = M (single-name placeholder)", personInitials("Mona", "-") === "M");

  const source = stripComments(read("lib/initials.ts"));
  check("lib/initials.ts has no generic-word list", !/GENERIC|academy|مركز/i.test(source));

  for (const file of ["components/shared/brand-avatar.tsx", "components/shared/person-avatar.tsx"]) {
    check(`${file} takes its letter from lib/initials.ts`, /from\s+["']@\/lib\/initials["']/.test(read(file)));
  }
}

// ── 9. Detail pages ─────────────────────────────────────────────────────────

const DETAIL_PAGES = [
  "app/[locale]/(center)/classes/[id]/page.tsx",
  "app/[locale]/(center)/sessions/[id]/page.tsx",
  "app/[locale]/(center)/teachers/[id]/page.tsx",
  "app/[locale]/(center)/students/[id]/page.tsx",
];

function checkDetailPages() {
  console.log("\nDetail pages");

  for (const page of DETAIL_PAGES) {
    const source = stripComments(read(page));
    check(`${page} opens with <PageHeader>`, /<PageHeader\b/.test(source));
    check(`${page} lays out with <DetailLayout>`, /<DetailLayout\b/.test(source));
    check(`${page} links back through PageHeader's back prop`, /\bback=\{\{/.test(source));
    check(`${page} hand-rolls no two-column grid`, !/xl:grid-cols-|lg:grid-cols-\[/.test(source));
    check(`${page} uses no raw <Card> (DetailCard carries the card)`, !/<Card\b/.test(source));
  }

  // The verbs are one ActionBar in the header, on the pages that have verbs.
  for (const page of [DETAIL_PAGES[0], DETAIL_PAGES[1], DETAIL_PAGES[3]]) {
    const flat = stripComments(read(page)).replace(/\n/g, " ");
    check(`${page} puts its verbs in <ActionBar inHeader>`, /<ActionBar\s+inHeader\b/.test(flat));
  }

  const layout = stripComments(read("components/shared/detail-layout.tsx"));
  check(
    "DetailLayout is main (2fr) + side (1fr) from lg",
    /lg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/.test(layout),
  );
  check("DetailLayout is one column below lg", !/(^|[\s"`])grid-cols-\[/.test(layout));

  const header = stripComments(read("components/shared/page-header.tsx"));
  check(
    "PageHeader supports back / leading / meta",
    /\bback\b/.test(header) && /\bleading\b/.test(header) && /\bmeta\b/.test(header),
  );
  check("PageHeader's back arrow mirrors in Arabic", /rtl:-scale-x-100/.test(header));

  // Delete is a danger zone at the foot, not a button beside Save.
  for (const form of [
    "app/[locale]/(center)/students/[id]/student-profile-form.tsx",
    "app/[locale]/(center)/teachers/[id]/teacher-profile-form.tsx",
  ]) {
    const source = stripComments(read(form));
    check(`${form} no longer carries Delete`, !/delete(Student|Teacher)Action|confirmingDelete|canDelete/.test(source));
  }
  for (const page of [DETAIL_PAGES[2], DETAIL_PAGES[3]]) {
    const source = stripComments(read(page));
    check(
      `${page} renders the danger zone (DeleteRecordCard) only behind its delete permission`,
      /ctxCan\(ctx,\s*"(student|teacher)\.delete"\)[\s\S]{0,40}<DeleteRecordCard/.test(source),
    );
  }
  check(
    "The class page keeps Delete/Deactivate in the Edit class dialog (unchanged)",
    /deleteClassAction/.test(stripComments(read("app/[locale]/(center)/classes/[id]/class-profile-form.tsx"))),
  );

  const session = stripComments(read(DETAIL_PAGES[1]));
  check(
    "The session page still gates End session, Delete session and the lifecycle verbs behind the same conditions",
    /canEnd\s*=\s*!rosterReadOnly\s*&&\s*displayStatus === "LIVE"\s*&&\s*ctxCan\(ctx,\s*"session\.close"\)/.test(session) &&
      /canDelete\s*=\s*deleteBlockers !== null && deleteBlockers\.length === 0/.test(session) &&
      /locked=\{rosterReadOnly\}/.test(session),
  );
}

// ── 10. Add student / Add teacher dialogs ───────────────────────────────────

function checkAddDialogs() {
  console.log("\nAdd dialogs");

  const dialogs: [string, string][] = [
    ["app/[locale]/(center)/students/add-student-dialog.tsx", "app/[locale]/(center)/students/student-form.tsx"],
    ["app/[locale]/(center)/teachers/add-teacher-dialog.tsx", "app/[locale]/(center)/teachers/teacher-form.tsx"],
  ];
  for (const [launcher, form] of dialogs) {
    const launcherSource = stripComments(read(launcher));
    const formSource = stripComments(read(form));
    check(`${launcher} mounts through DialogLauncher (fresh on every open)`, /<DialogLauncher\b/.test(launcherSource));
    check(`${launcher} does not use the bare Dialog primitives`, !/components\/ui\/dialog/.test(launcherSource));
    check(`${form} is the shared <DialogShell>`, /<DialogShell\b/.test(formSource));
    check(
      `${form} is built from <FormSection>s in <DialogSections>`,
      /<FormSection\b/.test(formSource) && /<DialogSections>/.test(formSource),
    );
    check(
      `${form} has Cancel + a primary in the shell footer (cancelLabel / submitLabel)`,
      /cancelLabel=/.test(formSource) && /submitLabel=/.test(formSource),
    );
    check(
      `${form} keeps what was typed on a refused submit (startTransition, not <form action>)`,
      /startTransition\(\(\) => formAction\(formData\)\)/.test(formSource) && !/<form\b[^>]*\baction=/.test(formSource),
    );
  }

  const studentForm = stripComments(read(dialogs[0][1])).replace(/\n/g, " ");
  check(
    "Add student: the match panel is passed to ContactFields' belowPhone slot",
    /belowPhone=\{[\s\S]*<MatchPanel\b/.test(studentForm),
  );
  check("Add student: the primary is held back while a match waits", /submitDisabled=\{match !== null\}/.test(studentForm));
  const newTeacherFields = stripComments(read("components/center/new-teacher-fields.tsx")).replace(/\n/g, " ");
  check(
    "Add teacher: the match panel is passed to ContactFields' belowPhone slot",
    /belowPhone=\{[\s\S]*<MatchPanel\b/.test(newTeacherFields),
  );

  const contact = stripComments(read("components/center/contact-fields.tsx"));
  const phoneAt = contact.indexOf("-phone`}");
  const altAt = contact.indexOf("-altPhone`}");
  const belowAt = contact.indexOf("belowPhone ?");
  const emailAt = contact.indexOf("-email`}");
  check(
    "ContactFields renders the phone, then the alternate, then belowPhone, then the email",
    phoneAt > 0 && phoneAt < altAt && altAt < belowAt && belowAt < emailAt,
  );

  const match = stripComments(read("components/center/match-panel.tsx"));
  check(
    "The match panel's affirmative action is its own solid button (not a SubmitButton)",
    /<Button\s+type="submit"/.test(match) && !/SubmitButton/.test(match),
  );
}


// ── 10. Centring never mixes a logical inset with a physical translate (SYS) ─
// `start-1/2` resolves to `right: 50%` in Arabic while `-translate-x-1/2`
// always moves left — every dialog sat half its width off-centre in RTL.
// Centre with symmetric insets + auto margins, or translate on both axes
// with a physical-free layout.

function checkRtlCentring() {
  const offenders = FILES.filter((file) => {
    const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
    return /(?:^|[\s"'`])(?:\w+:)*(?:start|end)-1\/2/.test(source) && /-?translate-x-/.test(source);
  });
  check(
    "No element is centred with a logical start/end-1/2 plus a physical translate-x (RTL off-centre, SYS)",
    offenders.length === 0,
    offenders.join(", "),
  );
}

// ── 11. Every mutation answers (DES Phase 3, docs/04 §14.2) ─────────────────

/** Route groups under app/[locale]: each keeps a way out of its own failures. */
function checkRouteGroupBoundaries() {
  const base = join(ROOT, "app", "[locale]");
  const groups = readdirSync(base).filter(
    (entry) => /^\(.+\)$/.test(entry) && statSync(join(base, entry)).isDirectory(),
  );
  const missing = groups.flatMap((group) =>
    ["error.tsx", "not-found.tsx"]
      .filter((file) => !existsSync(join(base, group, file)))
      .map((file) => `${group}/${file}`),
  );
  check(
    `Every route group has error.tsx and not-found.tsx (${groups.length} groups)`,
    groups.length > 0 && missing.length === 0,
    missing.join(", "),
  );
}

/**
 * Form state comes from `useGuardedActionState` (a network failure becomes a
 * Retry toast), and every state it returns is reported: a toast through
 * `useActionFeedback`, or the state's own error/status/field errors rendered.
 */
function checkActionsReport() {
  const plain: string[] = [];
  const unreported: string[] = [];
  for (const file of FILES) {
    if (!file.endsWith(".tsx")) continue;
    const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
    if (/\buseActionState\(/.test(source)) plain.push(file);
    for (const match of source.matchAll(/const\s*\[\s*(\w+)\s*,[^\]]*\]\s*=\s*useGuardedActionState\(/g)) {
      const name = match[1];
      const isReported = (n: string) =>
        new RegExp(`\\b${n}\\.(error|status|fieldErrors)\\b`).test(source) ||
        new RegExp(`useActionFeedback\\(\\s*${n}\\b`).test(source);
      // Two modes of one form merged into one state (`const state = a ? x : y`).
      const aliases = [...source.matchAll(new RegExp(`const\\s+(\\w+)\\s*(?::[^=]+)?=[^;]*\\b${name}\\b`, "g"))].map(
        (alias) => alias[1],
      );
      if (!isReported(name) && !aliases.some(isReported)) unreported.push(`${file} (${name})`);
    }
  }
  check(
    "Form state comes from useGuardedActionState, never a bare useActionState (network failures are retryable)",
    plain.length === 0,
    plain.join(", "),
  );
  check(
    "Every action state is reported — a toast, or its error/status rendered (no silent mutation)",
    unreported.length === 0,
    unreported.join(", "),
  );
}

/** The auth actions that end in `redirect()` — they never return to a form. */
const VOID_ACTION_ALLOWLIST: Record<string, string> = {
  signOutAction: "ends in redirect() to the sign-in page",
  selectCenterAction: "ends in redirect() into the chosen branch",
};

function checkActionsReturnResults() {
  const offenders: string[] = [];
  for (const file of FILES) {
    if (!file.endsWith(".ts")) continue;
    const raw = readFileSync(join(ROOT, file), "utf8");
    if (!/^\s*["']use server["']/.test(raw)) continue;
    const source = stripComments(raw);
    for (const match of source.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^()]*\)\s*:\s*Promise<void>/g)) {
      if (!(match[1] in VOID_ACTION_ALLOWLIST)) offenders.push(`${file} (${match[1]})`);
    }
  }
  check(
    "No Server Action returns void — a refusal must not look like a success",
    offenders.length === 0,
    offenders.join(", "),
  );
}

/** A `catch` that swallows silently, each with the reason it may. */
const SILENT_CATCH_ALLOWLIST: Record<string, string> = {
  "components/center/slot-conflict-notice.tsx":
    "an advisory preview — the server's own conflict check still answers on submit",
  "app/[locale]/(center)/settings/card/card-form.tsx":
    "getBBox() throws while the card is display:none; there is nothing to measure, not a failure",
  "components/family/join-family-form.tsx":
    "sessionStorage can be blocked (a private window); the parent code then has to be typed again — nothing failed (F3)",
};

function checkNoSilentCatches() {
  const offenders = FILES.filter((file) => {
    if (file in SILENT_CATCH_ALLOWLIST) return false;
    const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
    return (
      /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(source) ||
      /\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/.test(source)
    );
  });
  check(
    "No empty or comment-only catch outside the allowlist (errors are never silent)",
    offenders.length === 0,
    offenders.join(", "),
  );
}

// ── 12. URL state is soft navigation (T4, docs/02-architecture.md §14) ──────

/** Every `<form …>` opening tag in a source file, comments blanked. */
function formTags(source: string): string[] {
  return [...stripComments(source).matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
}

/** The one hard (full-document) GET submit left, and why. */
const HARD_GET_SUBMIT_ALLOWLIST: Record<string, string> = {
  "app/[locale]/(center)/reception/reception-search.tsx":
    "Reception's scan field: the barcode scanner's type-fast-then-Enter submit is verified against the full-page GET (docs/04 §11.8 Scanner contract)",
};

/** Controls that change URL state — a page rendering any of them must mark its results region. */
const URL_STATE_CONTROLS = [
  "<Pagination",
  "<FilterBar",
  "<ClassFilters",
  "<SessionFilters",
  "<TeacherSessionFilters",
  "<DiscoverFilters",
  "<ChildSelector",
  "<ParentDateFilter",
  "<ScheduleDateFilter",
  "<TypeAheadSearch",
  "<AddAttendeeSearch",
  "<QueueTabs",
];

function checkSoftUrlState() {
  // The merge, by running it.
  const query = (current: string, fields: [string, string][]) =>
    mergeFilterParams(new URLSearchParams(current), fields).toString();
  check(
    "mergeFilterParams: a field replaces what the URL held, an empty field removes the param",
    query("status=LIVE&q=ali", [
      ["status", ""],
      ["teacherId", "t1"],
    ]) === "q=ali&teacherId=t1",
  );
  check(
    "mergeFilterParams: params the form does not own are kept",
    query("child=c1&date=2026-10-01", [["date", "2026-10-02"]]) === "child=c1&date=2026-10-02",
  );
  check(
    "mergeFilterParams: page resets when a filter changed",
    !query("status=LIVE&page=3", [["status", "COMPLETED"]]).includes("page="),
  );
  check(
    "mergeFilterParams: page survives re-submitting the same filters",
    query("status=LIVE&page=3", [["status", "LIVE"]]).split("&").sort().join("&") === "page=3&status=LIVE",
  );
  check(
    "mergeFilterParams: a whitespace-only value is not written to the URL",
    query("q=ali", [["q", "   "]]) === "",
  );

  // The interceptor.
  const filters = read("components/shared/url-filters.tsx");
  check(
    "The interceptor navigates inside a transition, with scroll: false, on next-intl's router",
    /useTransition\(\)/.test(filters) &&
      /startTransition\(/.test(filters) &&
      /scroll:\s*false/.test(filters) &&
      /from\s+"@\/lib\/i18n\/navigation"/.test(filters),
  );
  check(
    "The interceptor is a form with no action (a plain GET without JavaScript) that only preventDefaults in onSubmit",
    /<form\b[\s\S]*?onSubmit=/.test(filters) && !/\baction=/.test(stripComments(filters)),
  );

  // No bare GET form anywhere: a `<form>` with neither an action nor a handler
  // reloads the document. The soft ones are the interceptor and its callers.
  const bare: string[] = [];
  for (const file of FILES) {
    if (!file.endsWith(".tsx")) continue;
    const source = read(file);
    for (const tag of formTags(source)) {
      const flat = tag.replace(/\s+/g, " ");
      if (/\baction=/.test(flat) || /\bonSubmit=/.test(flat) || /\{\.\.\./.test(flat)) continue;
      bare.push(file);
    }
    if (/\bmethod=["']get["']/i.test(stripComments(source))) bare.push(`${file} (method="get")`);
  }
  check(
    'No GET filter form outside the shared interceptor (UrlFilterForm) — no bare <form>, no method="get"',
    bare.length === 0,
    bare.join(", "),
  );

  const filterBar = read("components/shared/filter-bar.tsx");
  check(
    "FilterBar renders the interceptor, not its own <form>",
    /<UrlFilterForm\b/.test(filterBar) && !/<form\b/.test(stripComments(filterBar)),
  );
  for (const file of [
    "app/[locale]/(center)/classes/class-filters.tsx",
    "app/[locale]/(teacher)/teacher/sessions/session-filters.tsx",
    "app/[locale]/(student)/student/discover/discover-filters.tsx",
    "app/[locale]/(student)/student/schedule/schedule-date-filter.tsx",
    "app/[locale]/(parent)/parent/parent-date-filter.tsx",
    "app/[locale]/(parent)/parent/child-selector.tsx",
  ]) {
    check(`${file} filters through UrlFilterForm`, /<UrlFilterForm\b/.test(read(file)));
  }

  // The type-ahead's submit is soft except where it is allow-listed.
  const typeAhead = stripComments(read("components/center/type-ahead-search.tsx"));
  check(
    "TypeAheadSearch submits through useUrlFilters unless softSubmit is false",
    /useUrlFilters\(\)/.test(typeAhead) &&
      /urlFilters\.submit\(/.test(typeAhead) &&
      /softSubmit\s*=\s*true/.test(typeAhead),
  );
  const hard = FILES.filter((file) => /softSubmit=\{false\}/.test(stripComments(read(file))));
  check(
    "Only the allow-listed scan field opts out of the soft submit",
    hard.length === Object.keys(HARD_GET_SUBMIT_ALLOWLIST).length &&
      hard.every((file) => file in HARD_GET_SUBMIT_ALLOWLIST),
    hard.join(", "),
  );

  // Pagers, tabs and resets are SoftLinks, not scrolling Links or bare anchors.
  const pagination = stripComments(read("components/center/pagination.tsx"));
  check("Pagination links are SoftLinks", /<SoftLink\b/.test(pagination) && !/<Link\b/.test(pagination));
  const soft = stripComments(read("components/shared/soft-link.tsx"));
  check(
    "SoftLink keeps the scroll position (scroll={false}) and reports pending",
    /scroll\s*=\s*false/.test(soft) && /useLinkStatus/.test(soft) && /useReportUrlPending/.test(soft),
  );
  const dateFilter = stripComments(read("components/shared/date-filter.tsx"));
  check(
    "The date filter's Reset is a SoftLink, not a reloading <a>",
    /<SoftLink\b/.test(dateFilter) && !/<a\b/.test(dateFilter),
  );
  const audit = stripComments(read("app/[locale]/(center)/audit/page.tsx"));
  check("The audit filter tabs are SoftLinks", /<SoftLink\b[\s\S]*?hrefFor\(kind\)/.test(audit));
  // F7: the approvals type tabs — SoftLink pills from `sm`, a Select (moved
  // through useUrlFilters) below it, and never a horizontally scrolling strip.
  const queueTabs = stripComments(read("components/shared/queue-tabs.tsx"));
  check(
    "The approvals type tabs are SoftLinks from sm and a Select (useUrlFilters) below it, with no sideways scroll",
    /<SoftLink\b/.test(queueTabs) &&
      /useUrlFilters\(\)/.test(queueTabs) &&
      /<Select\b/.test(queueTabs) &&
      /hidden[^"]*sm:flex/.test(queueTabs) &&
      /sm:hidden/.test(queueTabs) &&
      !/overflow-x/.test(queueTabs),
  );

  // Results regions: every page with URL-state controls dims its results while pending.
  const region = stripComments(read("components/shared/results-region.tsx"));
  check(
    "ResultsRegion marks aria-busy and dims with opacity only (no skeleton, no height change)",
    /aria-busy=\{pending\}/.test(region) &&
      /opacity-60/.test(region) &&
      !/Skeleton|animate-pulse|min-h-|h-\[/.test(region),
  );
  const missingRegion = FILES.filter((file) => {
    if (!/\/page\.tsx$/.test(file)) return false;
    const source = stripComments(read(file));
    return URL_STATE_CONTROLS.some((control) => source.includes(control)) && !source.includes("<ResultsRegion");
  });
  check(
    "Every page with URL-state controls wraps its results in ResultsRegion",
    missingRegion.length === 0,
    missingRegion.join(", "),
  );
}

// ── 13. Whole Management is analytics-only (T6) ─────────────────────────────

/**
 * `"use server"` files under `(center)` that may skip the branch-scope guard,
 * each with its reason. Empty: every centre action reads or writes one
 * branch. (selectCenterAction, sign-out and Account actions are not centre
 * data and live outside `(center)`.)
 */
const BRANCH_GUARD_ACTION_ALLOWLIST: Record<string, string> = {};

/** Centre pages that may render under a roll-up, each with its reason. */
const BRANCH_GUARD_PAGE_ALLOWLIST: Record<string, string> = {
  "app/[locale]/(center)/analytics/page.tsx":
    "sums the organization — a union of per-branch scoped queries (docs/02 §4)",
  "app/[locale]/(center)/dashboard/page.tsx":
    "redirects to Analytics under a roll-up (asserted on its own below)",
};

/** Indexes of every line of `source` that calls `getTenantContext(`. */
function contextLines(lines: string[]): number[] {
  return lines.flatMap((line, index) => (/\bgetTenantContext\(/.test(line) ? [index] : []));
}

/** The guard follows within `window` non-blank lines of the context call. */
function guardedAfter(lines: string[], index: number, pattern: RegExp, window = 3): boolean {
  const following = lines.slice(index + 1).filter((line) => line.trim() !== "").slice(0, window);
  return following.some((line) => pattern.test(line));
}

function checkBranchScopeGuard() {
  const rollup = { rollupOrganizationId: "00000000-0000-4000-8000-000000000001" };
  const branch = { rollupOrganizationId: null };
  check(
    "requireBranchScope refuses a roll-up context with pickBranch, passes a branch context",
    requireBranchScope(rollup) === PICK_BRANCH &&
      PICK_BRANCH.error === "pickBranch" &&
      requireBranchScope(branch) === null &&
      isPickBranch(requireBranchScope(rollup)) &&
      !isPickBranch({ error: "pickBranch" }),
  );

  const actionFiles = FILES.filter(
    (file) =>
      file.startsWith("app/[locale]/(center)/") &&
      /\.tsx?$/.test(file) &&
      /^\s*["']use server["']/.test(read(file)),
  );
  const unguarded: string[] = [];
  for (const file of actionFiles) {
    if (file in BRANCH_GUARD_ACTION_ALLOWLIST) continue;
    const lines = stripComments(read(file)).split(/\r?\n/);
    const calls = contextLines(lines);
    if (calls.length === 0) unguarded.push(`${file} (no getTenantContext — allowlist it with a reason)`);
    for (const index of calls) {
      if (!guardedAfter(lines, index, /\brequireBranchScope\(/)) unguarded.push(`${file}:${index + 1}`);
    }
  }
  check(
    `Every centre Server Action calls requireBranchScope after getTenantContext (${actionFiles.length} files)`,
    actionFiles.length > 0 && unguarded.length === 0,
    unguarded.join(", "),
  );
  const staleActions = Object.keys(BRANCH_GUARD_ACTION_ALLOWLIST).filter((file) => !actionFiles.includes(file));
  check("The action-guard allowlist names only real centre action files", staleActions.length === 0, staleActions.join(", "));

  // Centre pages, and the print pages that resolve a centre context.
  const pages = FILES.filter(
    (file) =>
      /\/page\.tsx$/.test(file) &&
      (file.startsWith("app/[locale]/(center)/") ||
        (file.startsWith("app/[locale]/(print)/") && /getTenantContext\("center"\)/.test(read(file)))),
  );
  const unscreened: string[] = [];
  for (const file of pages) {
    if (file in BRANCH_GUARD_PAGE_ALLOWLIST) continue;
    const lines = stripComments(read(file)).split(/\r?\n/);
    const first = contextLines(lines)[0];
    if (
      first === undefined ||
      !guardedAfter(lines, first, /if \(requireBranchScope\(ctx\)\) return [^;]*<PickBranchScreen ctx=\{ctx\} \/>/, 1)
    ) {
      unscreened.push(file);
    }
  }
  check(
    `Every centre page but Analytics returns PickBranchScreen straight after its context (${pages.length} pages)`,
    pages.length > 0 && unscreened.length === 0,
    unscreened.join(", "),
  );
  const stalePages = Object.keys(BRANCH_GUARD_PAGE_ALLOWLIST).filter((file) => !pages.includes(file));
  check("The page-guard allowlist names only real centre pages", stalePages.length === 0, stalePages.join(", "));

  const dashboard = stripComments(read("app/[locale]/(center)/dashboard/page.tsx")).split(/\r?\n/);
  const dashboardCtx = contextLines(dashboard)[0];
  check(
    "The Dashboard redirects to Analytics under a roll-up, before any read",
    dashboardCtx !== undefined &&
      guardedAfter(
        dashboard,
        dashboardCtx,
        /if \(requireBranchScope\(ctx\)\) redirect\(\{ href: ROUTES\.centerAnalytics\b/,
        1,
      ),
  );

  const settingsLayout = stripComments(read("app/[locale]/(center)/settings/layout.tsx")).split(/\r?\n/);
  const settingsCtx = contextLines(settingsLayout)[0];
  check(
    "The settings layout renders only the page under a roll-up (no branch's settings chrome)",
    settingsCtx !== undefined &&
      guardedAfter(settingsLayout, settingsCtx, /if \(requireBranchScope\(ctx\)\) return children;/, 1),
  );

  const shell = stripComments(read("app/[locale]/(center)/center-shell.tsx"));
  check(
    "The T1 RollupNotice is gone (component, shell use and message)",
    !existsSync(join(ROOT, "components/shell/rollup-notice.tsx")) &&
      !/RollupNotice/.test(shell) &&
      !/rollupShowingBranch/.test(read("messages/en.json")) &&
      !/rollupShowingBranch/.test(read("messages/ar.json")),
  );
  check(
    "Under a roll-up every centre nav item except Analytics is disabled",
    /disabledHrefs:\s*rollupGroup\s*\?\s*nav\.filter\(\(item\) => item\.href !== ROUTES\.centerAnalytics\)/.test(shell),
  );
}

checkLocaleToggle();
checkNav();
checkNativeSelect();
console.log("\nTokens");
checkTokens();
checkNoDecorativeAccents();
checkPages();
checkShellBrandName();
checkInitials();
checkDetailPages();
checkAddDialogs();
checkRtlCentring();
console.log("\nFeedback (DES)");
checkRouteGroupBoundaries();
checkActionsReport();
checkActionsReturnResults();
checkNoSilentCatches();
console.log("\nSoft URL state (T4)");
checkSoftUrlState();
console.log("\nWhole Management is analytics-only (T6)");
checkBranchScopeGuard();

if (failures > 0) {
  console.error(`\n${failures} design check(s) failed.`);
  process.exit(1);
}
console.log("\nAll design checks passed.");
