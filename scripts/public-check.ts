/**
 * Public Explore gate (F5) — static, no database:
 *
 *   npm run check:public
 *
 * Proves what a guest can and can't reach without an account:
 *   1. every `(public)` page (and the public components) reads only through
 *      `lib/db/public-catalog.ts` — no other data module, no direct Prisma;
 *   2. that module selects nothing a guest must never see: no phone, email,
 *      altPhone, parent* field, no StudentProfile / Enrollment / Payment field
 *      (an enrolment *count* only, inside `_count`, turned into a status), no
 *      `include`, and every read has an explicit `select`;
 *   3. what leaves the module carries no count — seats are a status;
 *   4. `?next=` refuses off-site values (`safeNextPath`), and a guest's Enrol
 *      goes to sign-in with the page as `next`;
 *   5. only ACTIVE/GRACE + `publicListing` branches are listed, the logo route
 *      serves a guest only a listed branch's logo, and `noindex` is set while
 *      ALLOW_AUTO_CONFIRM_DEMO is.
 *
 * The behaviour against a database (unlisted / ONBOARDING / SUSPENDED /
 * ARCHIVED branches and inactive or ended classes hidden; the teacher page
 * exposing no count) is `check:student-portal`'s F5 block.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { FEW_SEATS_LEFT, seatStatus } from "../lib/capacity.ts";
import { noIndexDemo } from "../lib/auth/auth-config.ts";
import { safeNextPath } from "../lib/routes.ts";
import { EXPLORE_BRANCH_PAGE_SIZE, EXPLORE_CLASS_PAGE_SIZE, PUBLIC_LIFECYCLE_STATES } from "../lib/db/public-catalog.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

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

/** Comments blanked — a doc comment may *name* a field; code may not select it. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const full = join(absolute, entry);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    return statSync(full).isDirectory() ? walk(rel) : /\.tsx?$/.test(entry) ? [rel] : [];
  });
}

/** The `{ … }` argument of each `db.<model>.<method>(` call, braces matched. */
function callArguments(source: string, methods: string[]): { call: string; body: string }[] {
  const found: { call: string; body: string }[] = [];
  const pattern = new RegExp(`db\\.(\\w+)\\.(${methods.join("|")})\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("{", match.index! + match[0].length);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({ call: `${match[1]}.${match[2]}`, body: source.slice(open, end + 1) });
  }
  return found;
}

console.log("check:public — public Explore (F5)\n");

// ── 1. Public pages read only through the public catalog ────────────────────
console.log("Public pages read only lib/db/public-catalog.ts");

const PUBLIC_FILES = [...walk("app/[locale]/(public)"), ...walk("components/explore")];
check("the (public) route group exists with its four pages", [
  "app/[locale]/(public)/explore/page.tsx",
  "app/[locale]/(public)/explore/[slug]/page.tsx",
  "app/[locale]/(public)/explore/[slug]/classes/[classId]/page.tsx",
  "app/[locale]/(public)/explore/[slug]/teachers/[teacherUserId]/page.tsx",
].every((page) => PUBLIC_FILES.includes(page)));

const ALLOWED_DB_IMPORTS = new Set(["@/lib/db/public-catalog", "@/lib/db/client"]);
const badImports: string[] = [];
const directPrisma: string[] = [];
for (const file of PUBLIC_FILES) {
  const source = code(file);
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const target = match[1];
    if (/(^@\/lib\/db\/|lib\/db\/|^@prisma\/client$)/.test(target) && !ALLOWED_DB_IMPORTS.has(target)) {
      badImports.push(`${file} → ${target}`);
    }
  }
  if (/\bprisma\.\w+\.\w+\(/.test(source) || /\bprisma\.\$/.test(source)) directPrisma.push(file);
}
check("no (public) file imports another data module or @prisma/client", badImports.length === 0, badImports.join(", "));
check("no (public) file queries Prisma directly", directPrisma.length === 0, directPrisma.join(", "));

// ── 2. The module's selects are allowlists ──────────────────────────────────
console.log("\nlib/db/public-catalog.ts selects nothing private");

const CATALOG = code("lib/db/public-catalog.ts");

const FORBIDDEN_FIELDS = [
  /\bphone\b/i,
  /\bemail\b/i,
  /\baltPhone\b/,
  /\bcontactPhone\b/,
  /\bparent\w*/i,
  /\bstudentProfiles?\s*:/,
  /\bstudentId\s*:/,
  /\bstudentUserId\b/,
  /\bpayments?\s*:/,
  /\breservations?\s*:/,
  /\battendees\s*:/,
  /\b(priceSnapshot|centerShare\w*|teacherShare\w*|centerShareType|centerShareValue)\b/,
  /\bsessionRating\b/,
  /\bpermissionGrants?\b/,
  /\binclude\s*:/,
];
for (const pattern of FORBIDDEN_FIELDS) {
  check(`never names ${pattern.source}`, !pattern.test(CATALOG));
}

// `enrollments` appears only as the one count inside `_count`, filtered to
// ACTIVE, and is read once — straight into `seatStatus`, never returned.
const enrollmentMentions = CATALOG.match(/\benrollments?\b/g)?.length ?? 0;
const countForm = CATALOG.match(/_count:\s*\{\s*select:\s*\{\s*enrollments:\s*\{\s*where:\s*\{\s*status:\s*"ACTIVE"\s*\}\s*\}\s*\}\s*\}/g)?.length ?? 0;
const countRead = CATALOG.match(/seatStatus\(row\._count\.enrollments,/g)?.length ?? 0;
check(
  "enrollments is named only as one ACTIVE _count, read only into seatStatus",
  countForm === 1 && countRead === 1 && enrollmentMentions === 2,
  `${enrollmentMentions} mention(s), ${countForm} _count form(s), ${countRead} seatStatus read(s)`,
);
check("_count is used exactly once", (CATALOG.match(/_count\s*:/g)?.length ?? 0) === 1);

const reads = callArguments(CATALOG, ["findMany", "findFirst", "findUnique"]);
const unselected = reads.filter((read) => !/\bselect\s*:/.test(read.body)).map((read) => read.call);
check(`every read (${reads.length}) has an explicit select`, reads.length > 0 && unselected.length === 0, unselected.join(", "));

const models = new Set(
  [...CATALOG.matchAll(/db\.(\w+)\.(findMany|findFirst|findUnique|count|groupBy|aggregate)\(/g)].map((match) => match[1]),
);
const allowedModels = new Set(["center", "classGroup", "membership", "catalogSubject", "catalogGrade"]);
check(
  "reads only center, classGroup, membership and the catalog",
  [...models].every((model) => allowedModels.has(model)),
  [...models].join(", "),
);
check("counts only branches (the pager), nothing else", [...CATALOG.matchAll(/db\.(\w+)\.count\(/g)].every((match) => match[1] === "center"));
check("no write of any kind", !/db\.\w+\.(create|update|upsert|delete)\w*\(/.test(CATALOG) && !/\$executeRaw|\$queryRaw/.test(CATALOG));

// Every class / teacher read is scoped to one branch (rule 1).
const classReads = callArguments(CATALOG, ["findMany", "findFirst"]).filter((read) =>
  ["classGroup.findMany", "classGroup.findFirst", "membership.findMany"].includes(read.call),
);
check(
  "every class and membership read goes through scopedWhere / publicClassWhere",
  classReads.length > 0 && classReads.every((read) => /scopedWhere\(|publicClassWhere\(/.test(read.body)),
);
check("membership reads are TEACHER only", callArguments(CATALOG, ["findMany"]).filter((read) => read.call === "membership.findMany").every((read) => /role:\s*TEACHER/.test(read.body)));

// ── 3. What leaves the module carries no count ──────────────────────────────
console.log("\nNo count leaves the module");

function typeBody(name: string): string {
  const start = CATALOG.indexOf(`export type ${name} = {`);
  if (start < 0) return "";
  return CATALOG.slice(start, CATALOG.indexOf("};", start));
}
for (const name of ["PublicBranch", "PublicClass", "PublicTeacher"]) {
  const body = typeBody(name);
  check(`${name} is exported`, body.length > 0);
  check(`${name} has no count, capacity, enrolled or seats-left field`, !/\b(count|_count|capacity|enrolled\w*|seatsLeft|remaining|ratingCount|ratings)\s*:/i.test(body));
}
check("PublicClass carries seats as a SeatStatus", /seats:\s*SeatStatus/.test(typeBody("PublicClass")));
check("ratings come only from the average-only teacherRatingAverages", /teacherRatingAverages/.test(CATALOG) && !/teacherRatingAverage\(/.test(CATALOG));

check("seatStatus: uncapped is open", seatStatus(500, 0) === "open");
check("seatStatus: more than FEW_SEATS_LEFT free is open", seatStatus(10 - FEW_SEATS_LEFT - 1, 10) === "open");
check(`seatStatus: ${FEW_SEATS_LEFT} or fewer free is few`, seatStatus(10 - FEW_SEATS_LEFT, 10) === "few" && seatStatus(9, 10) === "few");
check("seatStatus: at or over capacity is full", seatStatus(10, 10) === "full" && seatStatus(12, 10) === "full");
check("FEW_SEATS_LEFT is 3", FEW_SEATS_LEFT === 3);

// No public page or component renders a private field by name.
const renderLeaks = PUBLIC_FILES.filter((file) =>
  /\.(phone|email|altPhone|contactPhone|parent\w*|studentCode|_count)\b/.test(code(file)),
);
check("no public page or component reads a phone, email, parent, student or count field", renderLeaks.length === 0, renderLeaks.join(", "));

// ── 4. ?next= stays on this site ────────────────────────────────────────────
console.log("\n?next= refuses off-site values");

const OFF_SITE = [
  "//evil.com",
  "//evil.com/explore",
  "/\\evil.com",
  "https://evil.com",
  "http://evil.com/en/explore",
  "javascript:alert(1)",
  "evil.com/explore",
  "/%0d%0aLocation:%20https://evil.com".replace(/%0d%0a/, "\r\n"),
  "\t//evil.com",
  `/${"a".repeat(600)}`,
];
const leaks = OFF_SITE.filter((value) => safeNextPath(value) !== null);
check("safeNextPath refuses every off-site value", leaks.length === 0, leaks.map((value) => JSON.stringify(value)).join(", "));
check("safeNextPath keeps a class page as-is", safeNextPath("/explore/center-60/classes/abc-123") === "/explore/center-60/classes/abc-123");

const enrol = code("components/explore/enrol-action.tsx");
check("a guest's Enrol is sign-in with the page as next", /ROUTES\.login\}\?next=\$\{encodeURIComponent\(returnPath\)\}/.test(enrol));
check("a signed-in Enrol is the existing ReserveButton (reserveOrEnroll)", /<ReserveButton\b/.test(enrol));
check("login and sign-up still pass next through safeNextPath", (code("app/[locale]/(auth)/actions.ts").match(/safeNextPath\(next\)/g)?.length ?? 0) >= 2);

// ── 5. Listing, logos, robots, shell ────────────────────────────────────────
console.log("\nListing, logos, noindex, shell");

check("only ACTIVE and GRACE are listable", [...PUBLIC_LIFECYCLE_STATES].sort().join(",") === "ACTIVE,GRACE");
check("a listed branch also needs publicListing", /settings:\s*\{\s*is:\s*\{\s*publicListing:\s*true\s*\}\s*\}/.test(CATALOG));
check("a listed class is active, accepts new students and has not ended", /active:\s*true/.test(CATALOG) && /acceptsNewStudents:\s*true/.test(CATALOG) && /endDate:\s*\{\s*gte:\s*todayInTimezone\(/.test(CATALOG));
check("page sizes: branches 12, classes 20", EXPLORE_BRANCH_PAGE_SIZE === 12 && EXPLORE_CLASS_PAGE_SIZE === 20);

const logos = code("app/api/logos/[centerId]/route.ts");
check("logo route: a guest gets only a listed branch's logo", /publicBranchLogo\(/.test(logos) && /signedIn\s*\?\s*await centerLogoPath/.test(logos));
check("logo route: still refuses a path outside the centre", /isPathInCenter\(/.test(logos));

check("noIndexDemo is on only when ALLOW_AUTO_CONFIRM_DEMO=yes", noIndexDemo({ ALLOW_AUTO_CONFIRM_DEMO: "yes" }) && !noIndexDemo({}) && !noIndexDemo({ ALLOW_AUTO_CONFIRM_DEMO: "no" }));
const rootLayout = code("app/[locale]/layout.tsx");
check("the root layout sets robots noindex, nofollow under noIndexDemo", /noIndexDemo\(\)/.test(rootLayout) && /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/.test(rootLayout));

const pages = PUBLIC_FILES.filter((file) => file.endsWith("/page.tsx"));
const untitled = pages.filter((page) => !/export async function generateMetadata/.test(read(page)));
check("every public page sets its own metadata title", untitled.length === 0, untitled.join(", "));

const shell = code("components/explore/public-shell.tsx");
check("the public shell has the mark, Explore, the language toggle and the auth links", ["<ProductMark", "<LocaleToggle", "ROUTES.explore", "ROUTES.login", "ROUTES.register"].every((token) => shell.includes(token)));
check("a signed-out visitor to / lands on Explore", /if \(!identity\) redirect\(\{ href: ROUTES\.explore, locale \}\)/.test(code("app/[locale]/page.tsx")));

const discover = code("app/[locale]/(student)/student/discover/page.tsx");
const discoverClass = code("app/[locale]/(student)/student/discover/[centerId]/[classId]/page.tsx");
check("Discover reuses the shared ClassCard and ClassDetail (no fork)", /<ClassCard\b/.test(discover) && /<ClassDetail\b/.test(discoverClass));

console.log(failures === 0 ? "\nAll public checks passed." : `\n${failures} public check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
