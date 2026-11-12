/**
 * Seed verification (P1) — read-only. Run after `npm run db:seed`:
 *
 *   npm run seed:verify
 *
 * Writes nothing. It proves the demo world is whole and usable:
 *   1. every centre has the provisioning baseline (settings, all baseline
 *      grant rows, an active payment method);
 *   2. every seed account lands on the nav its role is meant to have —
 *      computed through the SAME functions the shell uses (relation
 *      resolution, grant loading, `navForExperience`) and compared with an
 *      explicit, hand-written list per role (so a baseline that silently
 *      shrinks is caught, not echoed back);
 *   3. money reconciles — the analytics figures equal the raw sum of the
 *      frozen payment snapshots per branch, centre + teacher share = amount on
 *      every payment, each snapshot is what `lib/money.ts` computes for the cut
 *      in force, and the org roll-up equals the sum of its branches;
 *   4. no orphan rows — nothing points across a tenant boundary (an enrolment
 *      at one centre in another's class, a payment on another centre's
 *      session…), no class without a real teacher at its centre, no user with
 *      no relationship at all;
 *   5. every seed account is listed in docs/dev-accounts.md;
 *   6. the catalog shape (U3) — each subject once with its grade links, no
 *      two subjects sharing a name, every class's (grade, subject) pair
 *      linked — and the three bookable test classes;
 *   7. the entity counts, printed;
 *   9. (X1) premium, assistants and workspaces — who is premium (only
 *      teacher.premium and teacher.expired), each new account's experiences
 *      and nav, the assistant grants and their intersection, the workspace's
 *      counts, money and Earnings, the assessments, the multi-experience
 *      fixture link and the two dev-only codes. Hand-written expectations.
 *
 * X1 also counts a live assistant link as a relationship in section 4's
 * "no relationship at all" check: an assistant-only account (W7a) holds no
 * membership, profile or family link by design.
 *
 * SEC-2b adds the money-integrity invariants to 3: one active payment per
 * roster row, never voided-and-refunded, one live claim per payment, every
 * live settlement's total = its live claims, a cancelled settlement claims
 * nothing, every session carries a frozen timezone, no cancelled/rescheduled
 * session holds active money, no FIXED cut above its class price, voided
 * expenses out of the totals, and no audit row since SEC-2b carrying a name or
 * free text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Role, type SessionBookingMode } from "@prisma/client";
import { DEFAULT_ROLE_GRANTS, can, type PermissionGrants } from "../lib/auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../lib/auth/relations.ts";
import { expenseTotals, revenueTotals } from "../lib/db/analytics.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { revenueTotalsRollup } from "../lib/db/organizations.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import { activeChildLinks, hashFamilyCode } from "../lib/db/parents.ts";
import { baselineGrantKeys, centerBaselineGaps, hasFullBaseline } from "../lib/db/provision.ts";
import { splitShare } from "../lib/money.ts";
import { CENTER_NAV, TEACHER_NAV, TEACHER_WORKSPACE_ONLY_NAV, navForExperience } from "../components/shell/nav.ts";
import { EXPECTED_ASSISTANT_NAV, EXPECTED_TEACHER_NAV, EXPECTED_WORKSPACE_ONLY_TEACHER_NAV } from "./lib/expected-nav.ts";
import { seedSubjectLinkCounts } from "../prisma/seed-data/catalog.ts";
import { DEFAULT_SEED_EMAIL_DOMAIN, SEED_EMAIL_DOMAIN, mail } from "../prisma/seed-data/domain.ts";
import {
  BRANCHES,
  DEV_FAMILY_CODES,
  DEV_W_CODES,
  EXPIRED_WORKSPACE,
  PREMIUM_WORKSPACE,
  seedAccounts,
  type StaffRole,
} from "../prisma/seed-data/plan.ts";
import { loadExperiences } from "../lib/auth/experiences.ts";
import { isPremium } from "../lib/auth/premium.ts";
import { ASSISTANT_PERMISSIONS, detectPreset, sortPermissions } from "../lib/assistant-catalog.ts";
import { assistantNavItems } from "../lib/assistant-nav.ts";
import { assistantCan, resolveAssistantActing } from "../lib/db/assistant-acting.ts";
import { hashAssistantCode } from "../lib/db/assistants.ts";
import { ownedWorkspaceSources, sourceEarnings } from "../lib/db/teacher-earnings.ts";
import { ownedWorkspaceWhere } from "../lib/db/workspaces.ts";
import { addDays, dateKey, todayInTimezone } from "../lib/scheduling.ts";
import { pageGateFor } from "./lib/nav-gates.ts";
import {
  FIXTURE_STALE_AFTER_MS,
  fixtureVerdict,
  gateEmailPrefixes,
  gateSlugPrefixes,
  isGateFixtureSlug,
} from "./lib/gate-fixtures.ts";

const prisma = new PrismaClient();
const ROOT = join(import.meta.dirname, "..");

let failures = 0;
let warnings = 0;
/** `--strict-clean`: any gate fixture left in the database fails the run (the last step of check:all). */
const STRICT_CLEAN = process.argv.includes("--strict-clean");

function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** What each role is MEANT to see in the centre nav (labelKeys, in order). Written out by hand. */
const EXPECTED_CENTER_NAV: Record<StaffRole, string[]> = {
  OWNER: ["dashboard", "reception", "sessions", "approvals", "classes", "students", "teachers", "analytics", "expenses", "refunds", "settlements", "audit", "settings"],
  MANAGER: ["dashboard", "reception", "sessions", "approvals", "classes", "students", "teachers", "analytics", "expenses", "refunds", "settlements", "audit", "settings"],
  RECEPTIONIST: ["dashboard", "reception", "sessions", "students"],
  ACCOUNTANT: ["dashboard", "analytics", "expenses"],
};
// U7: Calendar joins the teacher, student and parent nav. (Teacher list: scripts/lib/expected-nav.ts.)
const EXPECTED_STUDENT_NAV = ["schedule", "calendar", "assessments", "discover", "reservations"];
const EXPECTED_PARENT_NAV = ["schedule", "calendar"];
// W6 (D-W35): + "premium" (Teachers).
const EXPECTED_ADMIN_NAV = ["centers", "platform", "catalog", "premium"];

/**
 * U3 — the bookable test classes (single-session attendance, F6) per branch
 * key, written out by hand: mode and per-session booking cap (null = none).
 */
const EXPECTED_BOOKABLE: Record<string, { mode: SessionBookingMode; cap: number | null }[]> = {
  downtown: [
    { mode: "INSTANT", cap: 3 },
    { mode: "INSTANT", cap: null },
  ],
  nasrcity: [{ mode: "APPROVAL", cap: null }],
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

async function count(sql: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(sql)) as { n: bigint | number }[];
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  console.log("Seed verification (read-only)");

  // Gate fixtures (scripts/lib/gate-fixtures.ts) are not the seed world: sections
  // 1, 3, 4 and 7 leave them out, section 8 reports them.
  const allCenters = await prisma.center.findMany({ orderBy: { slug: "asc" } });
  // W8a old → new (the W8a prompt's allowed change; D-W20, D-W38): the seed
  // world — the provisioning baseline (1), the orphan checks (4) and the counts
  // (3, 7) — is BRANCH centres only. A teacher's PERSONAL workspace has no
  // baseline and picks no catalogue entries by design, so it is left out of
  // every seed-world section exactly like a gate fixture (and is not one).
  const centers = allCenters.filter((center) => !isGateFixtureSlug(center.slug) && center.kind === "BRANCH");
  const fixtureCenters = allCenters.filter((center) => isGateFixtureSlug(center.slug));
  const fixtureIds = fixtureCenters.map((center) => center.id);
  const outsideSeedIds = [...fixtureIds, ...allCenters.filter((center) => center.kind === "PERSONAL").map((center) => center.id)];
  const seedCenterWhere = { centerId: { notIn: outsideSeedIds } };
  /** SQL list of the centre ids outside the seed world; a sentinel keeps `NOT IN ()` valid when there are none. */
  const fixtureIdList =
    outsideSeedIds.length > 0 ? outsideSeedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ") : "''";
  const seedCenter = (alias: string, column = "centerId") => `${alias}."${column}" NOT IN (${fixtureIdList})`;
  const notFixtureUser = (alias: string) =>
    gateEmailPrefixes()
      .map((prefix) => `COALESCE(LOWER(${alias}."email"), '') NOT LIKE '${prefix.replace(/'/g, "''")}%'`)
      .join(" AND ");
  const accounts = seedAccounts();
  const localDatabase = (() => {
    try {
      return ["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL ?? "").hostname);
    } catch {
      return false;
    }
  })();

  // ── 1. The baseline ──────────────────────────────────────────────────
  console.log("\n1. Every centre has the provisioning baseline");
  check("There are centres to verify", centers.length > 0, "run npm run db:seed first");
  const expectedRows = baselineGrantKeys().length;
  for (const center of centers) {
    const gaps = await centerBaselineGaps(prisma, center.id);
    check(
      `${center.slug}: settings + ${expectedRows} grant rows + an active payment method`,
      hasFullBaseline(gaps),
      `missing settings=${gaps.missingSettings}, missing grants=${gaps.missingGrants.length}, active methods=${gaps.activePaymentMethods}`,
    );
  }

  // ── 2. Nav per account ───────────────────────────────────────────────
  console.log("\n2. Every seed account lands on the nav its role is meant to have");
  const byEmail = new Map(
    (
      await prisma.user.findMany({
        where: { email: { in: accounts.map((account) => account.email) } },
        include: { memberships: { where: { active: true }, include: { center: true } } },
      })
    ).map((user) => [user.email, user]),
  );

  for (const account of accounts) {
    const user = byEmail.get(account.email);
    check(`${account.email} exists (${account.role})`, Boolean(user));
    if (!user) continue;
    if (!localDatabase) check(`${account.email} is linked to a Supabase Auth user`, Boolean(user.authId));
  }

  for (const branch of BRANCHES) {
    for (const staff of branch.staff) {
      const user = byEmail.get(staff.email ?? "");
      if (!user) continue;
      const relations = await resolveCenterRelations(prisma, user.id);
      if (branch.lifecycle === "SUSPENDED") {
        check(`${staff.email}: a SUSPENDED centre's member resolves no centre (sign-in refused)`, relations.length === 0, `${relations.length} relation(s)`);
        continue;
      }
      const own = relations.filter((relation) => relation.roles.includes(staff.role));
      check(`${staff.email}: resolves at least one centre as ${staff.role}`, own.length > 0);
      for (const relation of own) {
        const role = roleForExperience(relation, "center") as Role;
        const grants = await loadPermissionGrants(prisma, relation.center.id, role);
        const labels = navForExperience("center", role, grants).map((item) => item.labelKey);
        check(
          `${staff.email} @ ${relation.center.slug}: ${staff.role} nav = ${EXPECTED_CENTER_NAV[staff.role].length} items`,
          same(labels, EXPECTED_CENTER_NAV[staff.role]),
          `got [${labels.join(", ")}]`,
        );
      }
      if (staff.role === "OWNER" && branch.orgKey === "center60") {
        check(`${staff.email}: the org-level owner reaches both Center 60 branches`, own.length === 2, `${own.length}`);
      }
    }
  }

  // Teachers with a centre (the zero-centre one is checked separately below).
  const teacherEmails = accounts
    .filter((account) => account.role === "Teacher")
    .map((account) => account.email);
  for (const email of teacherEmails) {
    const user = byEmail.get(email);
    if (!user) continue;
    const relations = (await resolveCenterRelations(prisma, user.id)).filter((relation) => relation.roles.includes("TEACHER"));
    check(`${email}: resolves a teacher relation`, relations.length > 0);
    for (const relation of relations) {
      const grants = await loadPermissionGrants(prisma, relation.center.id, "TEACHER");
      const labels = navForExperience("teacher", "TEACHER", grants).map((item) => item.labelKey);
      check(`${email} @ ${relation.center.slug}: teacher nav`, same(labels, EXPECTED_TEACHER_NAV), `got [${labels.join(", ")}]`);
    }
  }
  const sharedTeacher = byEmail.get(mail("teacher.shared"));
  if (sharedTeacher) {
    const rows = await prisma.membership.findMany({ where: { userId: sharedTeacher.id, role: "TEACHER" }, include: { center: true } });
    check("The shared teacher has TWO memberships (both Center 60 branches), one User", rows.length === 2 && new Set(rows.map((r) => r.center.organizationId)).size === 1);
  }
  const crossOrg = byEmail.get(mail("teacher.crossorg"));
  if (crossOrg) {
    const rows = await prisma.membership.findMany({ where: { userId: crossOrg.id, role: "TEACHER" }, include: { center: true } });
    check("The cross-organization teacher teaches in two different organizations", new Set(rows.map((r) => r.center.organizationId)).size === 2);
  }
  const walid = byEmail.get(mail("teacher.new"));
  if (walid) {
    const relations = await resolveCenterRelations(prisma, walid.id);
    check("The zero-centre teacher resolves no centre (lands on the centre directory)", relations.length === 0);
  }

  const studentAccounts = accounts.filter((account) => account.role.startsWith("Student"));
  for (const account of studentAccounts) {
    const user = byEmail.get(account.email);
    if (!user) continue;
    const profiles = await prisma.studentProfile.count({ where: { userId: user.id, active: true } });
    const expectsProfile = !account.role.includes("no centre");
    check(
      `${account.email}: student ${expectsProfile ? `has ${profiles} profile(s)` : "has no centre yet"}`,
      expectsProfile ? profiles > 0 : profiles === 0,
    );
  }
  const both = byEmail.get(mail("student.both"));
  if (both) {
    const profiles = await prisma.studentProfile.findMany({ where: { userId: both.id }, include: { center: true } });
    check("The shared student studies in two organizations", new Set(profiles.map((p) => p.center.organizationId)).size === 2);
  }
  check("Student nav is the 5 student items", same(navForExperience("student", "STUDENT").map((i) => i.labelKey), EXPECTED_STUDENT_NAV));
  check("Parent nav is the 2 parent items", same(navForExperience("parent", "PARENT").map((i) => i.labelKey), EXPECTED_PARENT_NAV));

  // F3: families are FamilyLinks (a real code issued and accepted, or the
  // migration's LEGACY_VERIFIED copy of a verified ParentLink).
  const family = byEmail.get(mail("parent.family"));
  if (family) {
    const links = await activeChildLinks(prisma, family.id);
    const branches = new Set(links.flatMap((link) => link.studentUser.studentProfiles.map((profile) => profile.center.slug)));
    check(
      "The family parent has 2 ACTIVE children, one per Center 60 branch",
      links.length === 2 && branches.has("center-60-downtown") && branches.has("center-60-nasr-city"),
      `${links.length} links at ${[...branches].join(", ")}`,
    );
  }
  const nokhbaParent = byEmail.get(mail("parent.nokhba"));
  if (nokhbaParent) {
    const links = await activeChildLinks(prisma, nokhbaParent.id);
    const slugs = links.flatMap((link) => link.studentUser.studentProfiles.map((profile) => profile.center.slug));
    check(
      "The second parent's one child shows at both her branches (Al Nokhba and Downtown)",
      links.length === 1 && slugs.includes("al-nokhba-academy") && slugs.includes("center-60-downtown"),
      slugs.join(", "),
    );
  }
  for (const [label, code] of [
    ["student invitation", DEV_FAMILY_CODES.studentInvite],
    ["branch code", DEV_FAMILY_CODES.branchCode],
  ] as const) {
    const row = await prisma.familyInvitation.findUnique({ where: { codeHash: hashFamilyCode(code) } });
    check(`The dev ${label} ${code.slice(0, 4)}-${code.slice(4)} exists (PENDING until someone uses it)`, row !== null, row?.status ?? "missing");
  }
  const plaintextRows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "FamilyInvitation" WHERE "codeHash" !~ '^[0-9a-f]{64}$'`;
  check("Every parent code is stored as a sha256 only", (plaintextRows[0]?.n ?? 1) === 0);

  const admin = byEmail.get(mail("admin"));
  check("The platform admin is flagged", admin?.isPlatformAdmin === true);

  // SEC-2a: seed accounts are created confirmed, so the app rows carry the
  // stamp REQUIRE_EMAIL_CONFIRMATION reads; and the demo world has no
  // half-finished account claim in it.
  const unstamped = [...byEmail.values()].filter((user) => user.authId && !user.emailVerifiedAt);
  check(
    "Every seed account linked to Supabase Auth carries emailVerifiedAt (SEC-2a)",
    unstamped.length === 0,
    `${unstamped.length} without it — re-run the seed`,
  );
  check("No account claim is pending in the demo world", (await prisma.accountClaim.count({ where: { status: "PENDING" } })) === 0);
  check("Admin nav is the 4 platform items", same(navForExperience("admin", "PLATFORM_ADMIN").map((i) => i.labelKey), EXPECTED_ADMIN_NAV));

  // The nav ⇄ page-gate rule (docs/02 §6.2) holds for the real definitions.
  for (const [experience, defs] of [["center", CENTER_NAV], ["teacher", TEACHER_NAV]] as const) {
    const differing = defs.filter((def) => {
      const page = pageGateFor(experience, def.href);
      return page.found && page.permission !== (def.permission ?? null);
    });
    check(`${experience} nav items match their page gates`, differing.length === 0, differing.map((d) => d.href).join(", "));
  }
  // …and a role's expected nav is really what `can()` allows from the baseline.
  // P1b: derived from the real nav definitions, not a hand-counted literal — a
  // new nav item can no longer leave this check stale (it was `=== 12` and
  // tested one fixed permission, so SEC-2c's 13th item broke it).
  for (const role of ["OWNER", "MANAGER"] as const) {
    const baseline: PermissionGrants = Object.fromEntries(DEFAULT_ROLE_GRANTS[role].map((permission) => [permission, true]));
    const missing = CENTER_NAV.filter(
      (def) => def.permission && !(DEFAULT_ROLE_GRANTS[role].includes(def.permission) && can(role, def.permission, baseline)),
    ).map((def) => `${def.labelKey}:${def.permission}`);
    check(`${role} holds every permission their nav items need (baseline + can())`, missing.length === 0, missing.join(", "));
    check(
      `${role}'s hand-written expected nav lists every centre nav item`,
      same(EXPECTED_CENTER_NAV[role], CENTER_NAV.map((def) => def.labelKey)),
    );
  }

  // ── 3. Money reconciles ──────────────────────────────────────────────
  console.log("\n3. Money: analytics = the sum of the frozen payment snapshots");
  const active = centers.filter((center) => center.lifecycleState === "ACTIVE");
  const branchTotals: { id: string; slug: string; collected: number; centerShare: number; teacherShare: number; paymentCount: number }[] = [];
  for (const center of active) {
    const raw = (await prisma.$queryRaw<{ amount: bigint | null; c: bigint | null; t: bigint | null; n: bigint }[]>`
      SELECT SUM("amount") AS amount, SUM("centerShareSnapshot") AS c, SUM("teacherShareSnapshot") AS t, COUNT(*) AS n
      FROM "Payment" WHERE "centerId" = ${center.id} AND "voided" = false AND "refunded" = false`)[0];
    const analytics = await revenueTotals(prisma, center.id, { from: null, to: null });
    const rawAmount = Number(raw.amount ?? 0);
    branchTotals.push({ id: center.id, slug: center.slug, collected: analytics.collected, centerShare: analytics.centerShare, teacherShare: analytics.teacherShare, paymentCount: analytics.paymentCount });
    check(
      `${center.slug}: analytics collected (${analytics.collected}) = raw sum of snapshots (${rawAmount}) over ${Number(raw.n)} payments`,
      analytics.collected === rawAmount &&
        analytics.centerShare === Number(raw.c ?? 0) &&
        analytics.teacherShare === Number(raw.t ?? 0) &&
        analytics.paymentCount === Number(raw.n),
    );
    check(`${center.slug}: centre share + teacher share = collected`, analytics.centerShare + analytics.teacherShare === analytics.collected);
  }

  const badSplit = await count(`SELECT COUNT(*)::int AS n FROM "Payment" p WHERE (p."centerShareSnapshot" + p."teacherShareSnapshot" <> p."amount" OR p."amount" <> p."priceSnapshot") AND ${seedCenter("p")}`);
  check("Every payment: centre share + teacher share = amount = price snapshot", badSplit === 0, `${badSplit} violate`);

  // Each snapshot is what lib/money.ts computes for the cut that was in force.
  const payments = await prisma.payment.findMany({
    where: seedCenterWhere,
    select: {
      amount: true,
      centerShareSnapshot: true,
      teacherShareSnapshot: true,
      session: {
        select: {
          centerShareType: true,
          centerShareValue: true,
          classGroup: { select: { centerShareType: true, centerShareValue: true } },
        },
      },
    },
  });
  let mismatched = 0;
  for (const payment of payments) {
    const type = payment.session.centerShareType ?? payment.session.classGroup?.centerShareType;
    const value = payment.session.centerShareValue ?? payment.session.classGroup?.centerShareValue;
    if (!type || value === null || value === undefined) continue;
    const split = splitShare(payment.amount, type, value);
    if (split.centerShare !== payment.centerShareSnapshot || split.teacherShare !== payment.teacherShareSnapshot) mismatched += 1;
  }
  check(`All ${payments.length} payments equal lib/money.ts's split for their cut`, mismatched === 0, `${mismatched} differ`);

  const center60 = branchTotals.filter((branch) => branch.slug.startsWith("center-60-"));
  if (center60.length === 2) {
    const rollup = await revenueTotalsRollup(prisma, center60.map((b) => b.id), { from: null, to: null });
    check(
      "Center 60's org roll-up = the sum of its two branches, exactly",
      rollup.collected === center60[0].collected + center60[1].collected &&
        rollup.centerShare === center60[0].centerShare + center60[1].centerShare &&
        rollup.teacherShare === center60[0].teacherShare + center60[1].teacherShare,
    );
  }
  const voided = await prisma.payment.count({ where: { voided: true, ...seedCenterWhere } });
  const changes = await prisma.sessionAttendanceChange.count({ where: seedCenterWhere });
  check("The live absent-switch voids left change-log rows", voided === 0 || changes >= voided, `${voided} voided, ${changes} change rows`);
  const settlementStates = await prisma.settlement.groupBy({ by: ["status"], where: seedCenterWhere, _count: { _all: true } });
  check(
    "Settlements cover PAID, APPROVED and DRAFT",
    ["PAID", "APPROVED", "DRAFT"].every((status) => settlementStates.some((row) => row.status === status)),
    settlementStates.map((row) => `${row._count._all} ${row.status}`).join(", "),
  );

  // ── SEC-2b invariants: money integrity, concurrency, anti-fraud ────────
  check(
    "At most one non-voided payment per roster row (SEC-05)",
    (await count(`SELECT COUNT(*)::int AS n FROM (SELECT "sessionAttendeeId" FROM "Payment" WHERE NOT "voided" GROUP BY 1 HAVING COUNT(*) > 1) x`)) === 0,
  );
  check(
    "No payment is both voided and refunded (SEC-12)",
    (await count(`SELECT COUNT(*)::int AS n FROM "Payment" WHERE "voided" AND "refunded"`)) === 0,
  );
  check(
    "No payment holds two live settlement claims (D-05)",
    (await count(`SELECT COUNT(*)::int AS n FROM (SELECT "paymentId" FROM "SettlementClaim" WHERE "releasedAt" IS NULL GROUP BY 1 HAVING COUNT(*) > 1) x`)) === 0,
  );
  check(
    "Every live settlement's total = the sum of its live claims' frozen teacher shares (D-05)",
    (await count(`SELECT COUNT(*)::int AS n FROM "Settlement" st WHERE st."status" <> 'CANCELLED'
      AND st."totalAmount" <> COALESCE((SELECT SUM(c."teacherShare") FROM "SettlementClaim" c WHERE c."settlementId" = st."id" AND c."releasedAt" IS NULL), 0)`)) === 0,
  );
  check(
    "Every live claim is a non-voided payment of the settlement's own teacher and centre",
    (await count(`SELECT COUNT(*)::int AS n FROM "SettlementClaim" c
      JOIN "Settlement" st ON st."id" = c."settlementId" JOIN "Payment" p ON p."id" = c."paymentId"
      WHERE c."releasedAt" IS NULL AND (p."voided" OR p."teacherId" <> st."teacherId" OR p."centerId" <> st."centerId" OR c."centerId" <> st."centerId")`)) === 0,
  );
  check(
    "A cancelled settlement holds no live claim, and the demo has one (D-16)",
    (await count(`SELECT COUNT(*)::int AS n FROM "SettlementClaim" c JOIN "Settlement" st ON st."id" = c."settlementId" WHERE st."status" = 'CANCELLED' AND c."releasedAt" IS NULL`)) === 0 &&
      settlementStates.some((row) => row.status === "CANCELLED"),
  );
  check(
    "Every session carries its frozen timezone (D-14)",
    (await count(`SELECT COUNT(*)::int AS n FROM "Session" WHERE "timezone" IS NULL`)) === 0,
  );
  check(
    "No cancelled or rescheduled session holds an active payment (D-07)",
    (await count(`SELECT COUNT(DISTINCT s."id")::int AS n FROM "Session" s JOIN "Payment" p ON p."sessionId" = s."id" AND NOT p."voided" AND NOT p."refunded"
      WHERE s."status" = 'CANCELLED' OR s."rescheduledToId" IS NOT NULL`)) === 0,
  );
  check(
    "No class carries a FIXED cut above its price (D-15)",
    (await count(`SELECT COUNT(*)::int AS n FROM "ClassGroup" WHERE "centerShareType" = 'FIXED' AND "centerShareValue" > "price"`)) === 0,
  );
  for (const center of active) {
    const rawExpense = (await prisma.$queryRaw<{ total: bigint | null; voided: bigint }[]>`
      SELECT SUM("amount") FILTER (WHERE NOT "voided") AS total, COUNT(*) FILTER (WHERE "voided") AS voided
      FROM "Expense" WHERE "centerId" = ${center.id}`)[0];
    const expenses = await expenseTotals(prisma, center.id, { from: null, to: null });
    check(
      `${center.slug}: expense totals (${expenses.total}) skip the ${Number(rawExpense.voided)} voided expense(s) (D-24)`,
      expenses.total === Number(rawExpense.total ?? 0),
    );
  }
  const sec2b = await prisma.$queryRaw<{ finished_at: Date | null }[]>`
    SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '20261018090000_sec2b_money_integrity'`;
  const since = sec2b[0]?.finished_at ?? null;
  if (since) {
    const recent = await prisma.auditLog.findMany({
      where: { createdAt: { gte: since }, NOT: { action: { startsWith: "platform.catalog." } } },
      select: { action: true, before: true, after: true },
    });
    const dirty = recent.filter((row) => forbiddenAuditKey(row.before) ?? forbiddenAuditKey(row.after));
    check(
      `Audit rows written since SEC-2b carry no names or free text (D-20) — ${recent.length} checked`,
      dirty.length === 0,
      dirty.slice(0, 3).map((row) => row.action).join(", "),
    );
  }

  // ── 4. No orphan rows ────────────────────────────────────────────────
  console.log("\n4. No orphan rows (nothing crosses a tenant boundary)");
  const orphanChecks: [string, string][] = [
    ["Enrolments in another centre's class", `SELECT COUNT(*)::int AS n FROM "Enrollment" e JOIN "ClassGroup" c ON c."id" = e."classGroupId" WHERE c."centerId" <> e."centerId"`],
    ["Enrolments of another centre's student", `SELECT COUNT(*)::int AS n FROM "Enrollment" e JOIN "StudentProfile" s ON s."id" = e."studentProfileId" WHERE s."centerId" <> e."centerId"`],
    ["Sessions of another centre's class", `SELECT COUNT(*)::int AS n FROM "Session" x JOIN "ClassGroup" c ON c."id" = x."classGroupId" WHERE c."centerId" <> x."centerId"`],
    ["Sessions in another centre's room", `SELECT COUNT(*)::int AS n FROM "Session" x JOIN "Room" r ON r."id" = x."roomId" WHERE r."centerId" <> x."centerId"`],
    ["Classes in another centre's room", `SELECT COUNT(*)::int AS n FROM "ClassGroup" c JOIN "Room" r ON r."id" = c."roomId" WHERE r."centerId" <> c."centerId"`],
    ["Roster rows on another centre's session", `SELECT COUNT(*)::int AS n FROM "SessionAttendee" a JOIN "Session" x ON x."id" = a."sessionId" WHERE x."centerId" <> a."centerId"`],
    ["Roster rows for another centre's student", `SELECT COUNT(*)::int AS n FROM "SessionAttendee" a JOIN "StudentProfile" s ON s."id" = a."studentProfileId" WHERE s."centerId" <> a."centerId"`],
    ["Payments on another centre's session", `SELECT COUNT(*)::int AS n FROM "Payment" p JOIN "Session" x ON x."id" = p."sessionId" WHERE x."centerId" <> p."centerId"`],
    ["Payments with another centre's method", `SELECT COUNT(*)::int AS n FROM "Payment" p JOIN "CenterPaymentMethod" m ON m."id" = p."paymentMethodId" WHERE m."centerId" <> p."centerId"`],
    ["Classes whose teacher is not an active TEACHER at that centre", `SELECT COUNT(*)::int AS n FROM "ClassGroup" c WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = c."teacherId" AND m."centerId" = c."centerId" AND m."role" = 'TEACHER' AND m."active")`],
    ["Settlements for a teacher who is not at that centre", `SELECT COUNT(*)::int AS n FROM "Settlement" s WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = s."teacherId" AND m."centerId" = s."centerId" AND m."role" = 'TEACHER')`],
    ["Students whose grade the centre never picked", `SELECT COUNT(*)::int AS n FROM "StudentProfile" s WHERE s."gradeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CenterCatalogSelection" x WHERE x."centerId" = s."centerId" AND x."kind" = 'GRADE' AND x."gradeId" = s."gradeId")`],
    ["Classes whose subject the centre never picked", `SELECT COUNT(*)::int AS n FROM "ClassGroup" c WHERE c."subjectId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CenterCatalogSelection" x WHERE x."centerId" = c."centerId" AND x."kind" = 'SUBJECT' AND x."subjectId" = c."subjectId")`],
    ["Branch parent codes for a student the branch has no record of", `SELECT COUNT(*)::int AS n FROM "FamilyInvitation" i WHERE i."source" = 'CENTER_CODE' AND i."issuingCenterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StudentProfile" s WHERE s."userId" = i."studentUserId" AND s."centerId" = i."issuingCenterId")`],
    ["Reservations for another centre's class", `SELECT COUNT(*)::int AS n FROM "Reservation" r JOIN "ClassGroup" c ON c."id" = r."classGroupId" WHERE c."centerId" <> r."centerId"`],
    ["Memberships at a centre that does not exist", `SELECT COUNT(*)::int AS n FROM "Membership" m WHERE NOT EXISTS (SELECT 1 FROM "Center" c WHERE c."id" = m."centerId")`],
    [
      "Users with no relationship to anything",
      `SELECT COUNT(*)::int AS n FROM "User" u WHERE NOT u."isPlatformAdmin"
         AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = u."id")
         AND NOT EXISTS (SELECT 1 FROM "StudentProfile" s WHERE s."userId" = u."id")
         AND NOT EXISTS (SELECT 1 FROM "FamilyLink" p WHERE p."parentUserId" = u."id")
         AND NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r."studentId" = u."id")
         AND NOT EXISTS (SELECT 1 FROM "ChangeRequest" q WHERE q."requestedBy" = u."id")
         AND NOT EXISTS (SELECT 1 FROM "TeacherAssistant" t WHERE t."assistantUserId" = u."id" AND t."revokedAt" IS NULL)`,
    ],
  ];
  for (const [name, rawSql] of orphanChecks) {
    // Gate fixtures are left out: every query ends in its WHERE, and names its primary table first.
    const [, table, alias] = /FROM "(\w+)" (\w+)/.exec(rawSql) ?? [];
    const scope =
      table === "User" ? notFixtureUser(alias) : table === "FamilyInvitation" ? seedCenter(alias, "issuingCenterId") : seedCenter(alias);
    const sql = `${rawSql} AND ${scope}`;
    const n = await count(sql);
    check(`${name}: 0`, n === 0, `${n}`);
  }

  // ── 5. The accounts doc ──────────────────────────────────────────────
  console.log("\n5. docs/dev-accounts.md lists every seed account");
  let doc = "";
  try {
    doc = readFileSync(join(ROOT, "docs", "dev-accounts.md"), "utf8");
  } catch {
    // reported below
  }
  check("docs/dev-accounts.md exists", doc.length > 0);
  const missing = accounts.filter((account) => !doc.includes(account.email));
  check(
    `All ${accounts.length} accounts are listed with their @${SEED_EMAIL_DOMAIN} address`,
    missing.length === 0,
    missing.length > 0
      ? `${missing.length} missing (e.g. ${missing[0].email})${SEED_EMAIL_DOMAIN !== DEFAULT_SEED_EMAIL_DOMAIN ? " — SEED_EMAIL_DOMAIN differs from the committed doc: run npm run seed:docs" : ""}`
      : "",
  );
  check("The doc never prints the password", !/SEED_PASSWORD\s*=\s*\S/.test(doc));

  // ── 6. Catalog shape and the bookable classes (U3) ──────────────────
  console.log("\n6. Catalog: each subject once, linked to its grades (U3); the bookable classes");
  const nameKey = (column: string) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
  check(
    "No two subjects share an English name (case-insensitive, across the catalog)",
    (await count(`SELECT COUNT(*)::int AS n FROM (SELECT ${nameKey('"nameEn"')} FROM "CatalogSubject" GROUP BY 1 HAVING COUNT(*) > 1) d`)) === 0,
  );
  check(
    "No two subjects share an Arabic name (across the catalog)",
    (await count(`SELECT COUNT(*)::int AS n FROM (SELECT ${nameKey('"nameAr"')} FROM "CatalogSubject" GROUP BY 1 HAVING COUNT(*) > 1) d`)) === 0,
  );
  for (const [subjectEn, links] of Object.entries(seedSubjectLinkCounts())) {
    const rows = await prisma.catalogSubject.findMany({
      where: { nameEn: subjectEn },
      select: { _count: { select: { gradeLinks: true } } },
    });
    check(
      `${subjectEn}: one subject row, linked to ${links} grades`,
      rows.length === 1 && rows[0]._count.gradeLinks === links,
      `${rows.length} row(s)${rows[0] ? `, ${rows[0]._count.gradeLinks} link(s)` : ""}`,
    );
  }
  const unlinkedPairs = `NOT EXISTS (SELECT 1 FROM "CatalogSubjectGrade" l WHERE l."subjectId" = x."subjectId" AND l."gradeId" = x."gradeId")`;
  check(
    "Every class with a subject has a grade, and the pair is linked: 0 unlinked",
    (await count(`SELECT COUNT(*)::int AS n FROM "ClassGroup" x WHERE x."subjectId" IS NOT NULL AND (x."gradeId" IS NULL OR ${unlinkedPairs})`)) === 0,
  );
  check(
    "Every one-time session with a subject and a grade names a linked pair: 0 unlinked",
    (await count(`SELECT COUNT(*)::int AS n FROM "Session" x WHERE x."classGroupId" IS NULL AND x."subjectId" IS NOT NULL AND x."gradeId" IS NOT NULL AND ${unlinkedPairs}`)) === 0,
  );

  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const inTwoWeeks = new Date(today.getTime() + 14 * 86_400_000);
  for (const [branchKey, expected] of Object.entries(EXPECTED_BOOKABLE)) {
    const branch = BRANCHES.find((row) => row.key === branchKey);
    const center = centers.find((row) => row.name === branch?.name);
    check(`${branchKey}: the branch exists`, Boolean(center));
    if (!center) continue;
    const bookable = await prisma.classGroup.findMany({
      where: { centerId: center.id, active: true, sessionBookingMode: { not: "OFF" } },
      include: {
        room: { select: { capacity: true } },
        extraRooms: { select: { room: { select: { capacity: true } } } },
        _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
      },
    });
    const shape = (rows: { mode: SessionBookingMode; cap: number | null }[]) =>
      rows.map((row) => `${row.mode}/${row.cap ?? "none"}`).sort().join(", ");
    const found = bookable.map((row) => ({ mode: row.sessionBookingMode, cap: row.maxBookingSeats }));
    check(
      `${branchKey}: bookable classes are ${shape(expected)}`,
      shape(found) === shape(expected),
      shape(found) || "none",
    );
    for (const row of bookable) {
      const upcoming = await prisma.session.count({
        where: {
          classGroupId: row.id,
          status: "SCHEDULED",
          rescheduledToId: null,
          date: { gte: today, lt: inTwoWeeks },
        },
      });
      const capacities = [row.room?.capacity ?? 0, ...row.extraRooms.map((extra) => extra.room.capacity)];
      const seats = capacities.includes(0) ? 0 : capacities.reduce((sum, value) => sum + value, 0);
      const enrolled = row._count.enrollments;
      check(
        `${branchKey} ${row.sessionBookingMode}/${row.maxBookingSeats ?? "none"}: sessions in the coming two weeks, seats partly used`,
        upcoming > 0 && enrolled > 0 && (seats === 0 || enrolled < seats) && row.acceptsNewStudents,
        `upcoming=${upcoming}, enrolled=${enrolled}, seats=${seats || "unlimited"}, accepts=${row.acceptsNewStudents}`,
      );
    }
  }

  // ── 7. Counts ────────────────────────────────────────────────────────
  console.log("\n7. Entity counts (seed world, gate fixtures left out; catalog rows are global)");
  const counts: [string, number][] = [
    ["Organizations", await prisma.organization.count({ where: { ownerUserId: null, NOT: { centers: { some: { id: { in: fixtureIds } } } } } })],
    ["Centres", centers.length],
    ["Users", await count(`SELECT COUNT(*)::int AS n FROM "User" u WHERE ${notFixtureUser("u")}`)],
    ["Memberships", await prisma.membership.count({ where: seedCenterWhere })],
    ["Student profiles", await prisma.studentProfile.count({ where: seedCenterWhere })],
    ["Family links", await prisma.familyLink.count()],
    ["Parent codes (hashed)", await prisma.familyInvitation.count()],
    ["Permission grant rows", await prisma.permissionGrant.count({ where: seedCenterWhere })],
    ["Catalog education systems", await prisma.catalogEducationSystem.count()],
    ["  grades", await prisma.catalogGrade.count()],
    ["  subjects", await prisma.catalogSubject.count()],
    ["  subject–grade links", await prisma.catalogSubjectGrade.count()],
    ["Rooms", await prisma.room.count({ where: seedCenterWhere })],
    ["Room links", await prisma.roomLink.count({ where: seedCenterWhere })],
    ["Terms", await prisma.centerTerm.count({ where: seedCenterWhere })],
    ["Holidays", await prisma.holiday.count({ where: seedCenterWhere })],
    ["Payment methods", await prisma.centerPaymentMethod.count({ where: seedCenterWhere })],
    ["Classes", await prisma.classGroup.count({ where: seedCenterWhere })],
    ["Sessions", await prisma.session.count({ where: seedCenterWhere })],
    ["  closed", await prisma.session.count({ where: { closedAt: { not: null }, ...seedCenterWhere } })],
    ["  cancelled", await prisma.session.count({ where: { status: "CANCELLED", ...seedCenterWhere } })],
    ["  rescheduled", await prisma.session.count({ where: { rescheduledToId: { not: null }, ...seedCenterWhere } })],
    ["  manual / one-time", await prisma.session.count({ where: { isManual: true, ...seedCenterWhere } })],
    ["Enrolments", await prisma.enrollment.count({ where: seedCenterWhere })],
    ["Roster rows (attendance)", await prisma.sessionAttendee.count({ where: seedCenterWhere })],
    ["Attendance changes", await prisma.sessionAttendanceChange.count({ where: seedCenterWhere })],
    ["Payments", await prisma.payment.count({ where: seedCenterWhere })],
    ["  voided", voided],
    ["Settlements", await prisma.settlement.count({ where: seedCenterWhere })],
    ["Expenses", await prisma.expense.count({ where: seedCenterWhere })],
    ["Ratings", await prisma.sessionRating.count({ where: { session: seedCenterWhere } })],
    ["Reservations", await prisma.reservation.count({ where: seedCenterWhere })],
    ["Change requests", await prisma.changeRequest.count({ where: seedCenterWhere })],
    ["Audit log rows", await prisma.auditLog.count({ where: { OR: [{ centerId: null }, seedCenterWhere] } })],
  ];
  for (const [label, value] of counts) console.log(`  ${label.padEnd(36)} ${value}`);
  for (const center of centers) {
    const students = await prisma.studentProfile.count({ where: { centerId: center.id } });
    const sessions = await prisma.session.count({ where: { centerId: center.id } });
    const classes = await prisma.classGroup.count({ where: { centerId: center.id } });
    console.log(`  ${center.slug.padEnd(28)} ${String(center.lifecycleState).padEnd(10)} students=${students} classes=${classes} sessions=${sessions}`);
  }

  // ── 8. Gate fixtures left behind ─────────────────────────────────────
  // A running gate owns rows of this shape until its `finally` deletes them, so
  // a young one is a WARN (do not run this while a gate runs); one past the
  // stale limit was left by an interrupted gate: FAIL. --strict-clean: any is a FAIL.
  console.log(`\n8. Gate fixtures left behind${STRICT_CLEAN ? " (--strict-clean: none allowed)" : ""}`);
  const now = Date.now();
  const likeAny = (column: string, prefixes: string[]) =>
    prefixes.map((prefix) => `${column} ILIKE '${prefix.replace(/'/g, "''").replace(/[%_]/g, "\\$&")}%'`).join(" OR ");
  const leftovers = (
    await Promise.all([
      prisma.$queryRawUnsafe<{ what: string; createdAt: Date }[]>(
        `SELECT 'centre ' || "slug" AS what, "createdAt" FROM "Center" WHERE ${likeAny('"slug"', gateSlugPrefixes())}`,
      ),
      prisma.$queryRawUnsafe<{ what: string; createdAt: Date }[]>(
        `SELECT 'user ' || COALESCE("email", "id") AS what, "createdAt" FROM "User" WHERE ${likeAny('"email"', gateEmailPrefixes())}`,
      ),
      prisma.$queryRawUnsafe<{ what: string; createdAt: Date }[]>(
        `SELECT 'catalog subject ' || "nameEn" AS what, "createdAt" FROM "CatalogSubject" WHERE ${likeAny('"nameEn"', gateSlugPrefixes())}`,
      ),
      prisma.$queryRawUnsafe<{ what: string; createdAt: Date }[]>(
        `SELECT 'catalog grade ' || "nameEn" AS what, "createdAt" FROM "CatalogGrade" WHERE ${likeAny('"nameEn"', gateSlugPrefixes())}`,
      ),
    ])
  ).flat();
  let leftBehind = 0;
  for (const row of leftovers) {
    const ageMs = now - new Date(row.createdAt).getTime();
    const minutes = Math.round(ageMs / 60_000);
    if (fixtureVerdict(ageMs, STRICT_CLEAN) === "FAIL") {
      leftBehind += 1;
      check(`${row.what} — ${minutes} min old, left behind (stale after ${FIXTURE_STALE_AFTER_MS / 60_000} min)`, false, "an interrupted gate; re-run it to clean up");
    } else {
      warnings += 1;
      console.log(`  WARN  ${row.what} — ${minutes} min old: a gate may still be running (do not run seed:verify mid-gate)`);
    }
  }
  if (leftovers.length === 0) check("No gate fixture is left in the database", true);
  else if (leftBehind === 0) console.log(`  ${warnings} young gate fixture(s): a WARN, not a failure`);

  await verifyWWorld({ byEmail, centers, allCenters, localDatabase });

  console.log(
    failures === 0
      ? `\nAll seed checks passed.${warnings > 0 ? ` (${warnings} warning(s))` : ""}`
      : `\n${failures} seed check(s) FAILED.`,
  );
  if (failures > 0) process.exitCode = 1;
}

// ── 9. Premium, assistants and workspaces (X1) ─────────────────────────────
//
// Hand-written expectations, independent of the seed's code (prisma/seed-data/
// w-world.ts): who is premium, each new account's experiences and nav, the
// assistant grants, the workspace's counts and money, the assessments, and the
// two dev-only codes. Audit timestamps are deliberately NOT ordered here: the
// backdated writers (teacher.expired, the closed exams) write audit rows at
// the real time.

/** FULL's grants and the custom check-in assistant's, written out by hand (lib/assistant-catalog.ts is the code). */
const EXPECTED_FULL_GRANTS = ["assessments.review", "assessments.manage", "classes.view", "requests.manage", "checkin.workspace", "payments.workspace", "analytics.view"];
const EXPECTED_CHECKIN_GRANTS = ["checkin.workspace", "payments.workspace"];

type VerifyUser = { id: string; email: string | null; authId: string | null; premiumUntil: Date | null };

async function verifyWWorld(input: {
  byEmail: Map<string | null, VerifyUser>;
  centers: { id: string; kind: string; slug: string }[];
  allCenters: { id: string; kind: string; name: string }[];
  localDatabase: boolean;
}) {
  console.log("\n9. Premium, assistants and workspaces (X1)");
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const get = (local: string) => input.byEmail.get(mail(local));
  const premium = get("teacher.premium");
  const expired = get("teacher.expired");
  const full = get("assistant.premium");
  const checkinAssistant = get("assistant.checkin");
  const wsStudent = get("student.workspace");
  const invited = get("student.invited");
  const multi = get("multi.experience");
  const studentNew = get("student.new");
  const youssef = get("student.downtown");
  if (!premium || !expired || !full || !checkinAssistant || !wsStudent || !invited || !multi || !studentNew || !youssef) {
    check("The seven X1 accounts exist", false, "run npm run db:seed");
    return;
  }
  const kindsOf = async (userId: string) => (await loadExperiences(prisma, userId)).map((entry) => entry.kind).sort();
  const loginOnly = (user: VerifyUser, name: string, run: () => Promise<void>) =>
    input.localDatabase && !user.authId ? (console.log(`  SKIP  ${name} — needs a login (local database)`), Promise.resolve()) : run();

  // Premium: only teacher.premium and teacher.expired are ever premium in the seed.
  check("teacher.premium is premium now", isPremium(premium, now), String(premium.premiumUntil));
  check(
    "teacher.expired's premium has lapsed (premiumUntil in the past)",
    expired.premiumUntil !== null && expired.premiumUntil.getTime() < now.getTime(),
    String(expired.premiumUntil),
  );
  const otherPremium = seedAccounts()
    .filter((account) => account.email !== premium.email && account.email !== expired.email)
    .filter((account) => input.byEmail.get(account.email)?.premiumUntil);
  check(
    "No other seed account is premium — teacher.downtown (the e2e premium target), teacher.shared and the rest never are",
    otherPremium.length === 0,
    otherPremium.map((account) => account.email).join(", "),
  );

  // PERSONAL centres stay out of sections 1, 3, 4 and 7.
  const workspaces = input.allCenters.filter((center) => center.kind === "PERSONAL");
  check("The seed world of sections 1, 3, 4 and 7 holds no PERSONAL centre", input.centers.every((center) => center.kind === "BRANCH"));
  const premiumWs = await prisma.center.findMany({ where: ownedWorkspaceWhere(premium.id), select: { id: true, name: true, archivedAt: true } });
  const expiredWs = await prisma.center.findMany({ where: ownedWorkspaceWhere(expired.id), select: { id: true, name: true } });
  check(
    `teacher.premium owns exactly one live workspace, "${PREMIUM_WORKSPACE.name}"`,
    premiumWs.length === 1 && premiumWs[0].name === PREMIUM_WORKSPACE.name && premiumWs[0].archivedAt === null,
    premiumWs.map((row) => row.name).join(", "),
  );
  check(`teacher.expired owns exactly one workspace, "${EXPIRED_WORKSPACE.name}"`, expiredWs.length === 1 && expiredWs[0].name === EXPIRED_WORKSPACE.name);
  check("Both seeded workspaces are PERSONAL centres", [...premiumWs, ...expiredWs].every((row) => workspaces.some((center) => center.id === row.id)));
  const downtownTeacher = get("teacher.downtown");
  if (downtownTeacher) {
    check(
      "teacher.downtown (the free teacher) has no workspace and no assistant",
      (await prisma.center.count({ where: ownedWorkspaceWhere(downtownTeacher.id) })) === 0 &&
        (await prisma.teacherAssistant.count({ where: { teacherUserId: downtownTeacher.id, revokedAt: null } })) === 0,
    );
  }

  // Experiences and nav.
  const premiumRelations = (await resolveCenterRelations(prisma, premium.id)).filter((relation) => relation.roles.includes("TEACHER"));
  check("teacher.premium resolves one teacher relation, at Downtown", premiumRelations.length === 1 && premiumRelations[0].center.slug === "center-60-downtown");
  for (const relation of premiumRelations) {
    const grants = await loadPermissionGrants(prisma, relation.center.id, "TEACHER");
    const labels = navForExperience("teacher", "TEACHER", grants).map((item) => item.labelKey);
    check("teacher.premium @ Downtown: the teacher nav (premium does not change it)", same(labels, EXPECTED_TEACHER_NAV), `got [${labels.join(", ")}]`);
  }
  check("teacher.premium has one experience: Teacher", same(await kindsOf(premium.id), ["teacher"]));
  check("teacher.expired has no branch, one experience (Teacher, workspace only)", (await resolveCenterRelations(prisma, expired.id)).length === 0 && same(await kindsOf(expired.id), ["teacher"]));
  check(
    "The workspace-only teacher nav is the hand-written list",
    same(TEACHER_WORKSPACE_ONLY_NAV.map((item) => item.labelKey), EXPECTED_WORKSPACE_ONLY_TEACHER_NAV),
  );
  check("multi.experience holds three kinds of experience: Teacher, Student, Parent", same(await kindsOf(multi.id), ["parent", "student", "teacher"]), (await kindsOf(multi.id)).join(", "));
  const multiLink = await prisma.familyLink.findUnique({ where: { parentUserId_studentUserId: { parentUserId: multi.id, studentUserId: studentNew.id } } });
  check(
    "multi.experience → student.new: the fixture link's exact shape (ACTIVE, STUDENT_INVITE, no invitation, never revoked)",
    multiLink !== null && multiLink.status === "ACTIVE" && multiLink.source === "STUDENT_INVITE" && multiLink.invitationId === null && multiLink.revokedAt === null,
  );
  check(
    "multi.experience: a TEACHER membership and a student profile at Downtown",
    (await prisma.membership.count({ where: { userId: multi.id, role: "TEACHER", active: true, center: { slug: "center-60-downtown" } } })) === 1 &&
      (await prisma.studentProfile.count({ where: { userId: multi.id, active: true, center: { slug: "center-60-downtown" } } })) === 1,
  );

  // Assistants: links, grants, effective experiences, nav and the three-way intersection.
  const grantsOf = async (teacherUserId: string, assistantUserId: string) => {
    const link = await prisma.teacherAssistant.findFirst({ where: { teacherUserId, assistantUserId, revokedAt: null }, include: { grants: true } });
    return link ? sortPermissions(link.grants.map((grant) => grant.permission)) : null;
  };
  const fullGrants = await grantsOf(premium.id, full.id);
  const checkinGrants = await grantsOf(premium.id, checkinAssistant.id);
  await loginOnly(full, "assistant links", async () => {
    check("assistant.premium → teacher.premium: the FULL grants", fullGrants !== null && same(fullGrants, EXPECTED_FULL_GRANTS), fullGrants?.join(", ") ?? "no link");
    check(
      "assistant.checkin → teacher.premium: exactly check-in + payments, read as Custom",
      checkinGrants !== null && same(checkinGrants, EXPECTED_CHECKIN_GRANTS) && detectPreset(checkinGrants) === "CUSTOM",
      checkinGrants?.join(", ") ?? "no link",
    );
    check("teacher.expired keeps one live assistant link (inert while lapsed)", (await prisma.teacherAssistant.count({ where: { teacherUserId: expired.id, revokedAt: null } })) === 1);
    const fullExperiences = await loadExperiences(prisma, full.id);
    check(
      "assistant.premium has one experience: teacher.premium's assistant (the lapsed teacher's never shows)",
      fullExperiences.length === 1 && fullExperiences[0].kind === "assistant" && fullExperiences[0].teacherUserId === premium.id,
      fullExperiences.map((entry) => `${entry.kind}:${entry.teacherUserId ?? ""}`).join(", "),
    );
    check("assistant.checkin has one experience: an assistant", same(await kindsOf(checkinAssistant.id), ["assistant"]));
    for (const [label, assistant, expected] of [
      ["FULL", full, EXPECTED_ASSISTANT_NAV.FULL],
      ["custom check-in", checkinAssistant, EXPECTED_ASSISTANT_NAV.CHECKIN],
    ] as const) {
      const acting = await resolveAssistantActing(prisma, { assistantUserId: assistant.id, teacherUserId: premium.id, now });
      const labels = acting ? assistantNavItems(premium.id, acting).map((item) => item.labelKey) : [];
      check(`The ${label} assistant's nav is the hand-written list`, acting !== null && same(labels, [...expected]), `got [${labels.join(", ")}]`);
      if (acting && label === "custom check-in") {
        const everywhere = [...acting.branches.map((branch) => branch.centerId), ...acting.workspaces.map((ws) => ws.centerId)];
        check("The custom assistant cannot see Earnings anywhere (no analytics.view)", everywhere.every((centerId) => !assistantCan(acting, "analytics.view", centerId)));
        check(
          "The custom assistant does nothing at the branch, and checks in and takes payments in the workspace",
          acting.branches.every((branch) => ASSISTANT_PERMISSIONS.every((key) => !assistantCan(acting, key, branch.centerId))) &&
            acting.workspaces.every((ws) => assistantCan(acting, "checkin.workspace", ws.centerId) && assistantCan(acting, "payments.workspace", ws.centerId)),
        );
      }
      if (acting && label === "FULL") {
        check(
          "The FULL assistant sees Earnings and works at Downtown and in the workspace",
          acting.branches.some((branch) => assistantCan(acting, "analytics.view", branch.centerId)) &&
            acting.workspaces.some((ws) => assistantCan(acting, "checkin.workspace", ws.centerId)),
        );
      }
    }
  });

  // The workspace: counts, money, Earnings.
  const ws = premiumWs[0];
  if (ws) {
    const classes = await prisma.classGroup.findMany({ where: { centerId: ws.id }, select: { id: true, price: true, centerShareType: true, centerShareValue: true } });
    check(
      "The workspace has 2 classes, both PERCENTAGE 0, at different prices",
      classes.length === 2 && classes.every((row) => row.centerShareType === "PERCENTAGE" && row.centerShareValue === 0) && classes[0].price !== classes[1].price,
    );
    const profiles = await prisma.studentProfile.count({ where: { centerId: ws.id, active: true } });
    const enrolments = await prisma.enrollment.count({ where: { centerId: ws.id, status: "ACTIVE" } });
    check("The workspace has 9 students, each enrolled in one class", profiles === 9 && enrolments === 9, `${profiles} profiles, ${enrolments} enrolments`);
    const methods = await prisma.centerPaymentMethod.findMany({ where: { centerId: ws.id }, select: { id: true, name: true } });
    check("The workspace has its one hidden Cash method", methods.length === 1 && methods[0].name === "Cash");
    const pastClosed = await prisma.session.count({ where: { centerId: ws.id, date: { lt: today }, closedAt: { not: null } } });
    check("The workspace's last 45 days hold at least 10 closed sessions", pastClosed >= 10, `${pastClosed}`);
    const payments = await prisma.payment.findMany({ where: { centerId: ws.id }, select: { id: true, amount: true, centerShareSnapshot: true, teacherShareSnapshot: true, voided: true, refunded: true, paymentMethodId: true } });
    check("Every workspace payment: centre share 0, teacher share = amount, the Cash method", payments.length > 0 && payments.every((p) => p.centerShareSnapshot === 0 && p.teacherShareSnapshot === p.amount && p.paymentMethodId === methods[0]?.id));
    check(
      "The workspace has exactly one voided and one refunded payment",
      payments.filter((p) => p.voided).length === 1 && payments.filter((p) => p.refunded).length === 1,
      `${payments.filter((p) => p.voided).length} voided, ${payments.filter((p) => p.refunded).length} refunded`,
    );
    check("No workspace payment is claimed by a settlement (D-W24, D-W40)", (await prisma.settlementClaim.count({ where: { paymentId: { in: payments.map((p) => p.id) } } })) === 0);
    const gross = payments.filter((p) => !p.voided).reduce((sum, p) => sum + p.teacherShareSnapshot, 0);
    const refundRows = await prisma.$queryRaw<{ t: bigint | null }[]>`
      SELECT SUM(r."teacherShareReversed") AS t FROM "Refund" r JOIN "Payment" p ON p."id" = r."paymentId" WHERE p."centerId" = ${ws.id}`;
    const refunds = Number(refundRows[0]?.t ?? 0);
    const sources = (await ownedWorkspaceSources(prisma, premium.id, 0, now)).filter((source) => source.centerId === ws.id);
    const zone = "Africa/Cairo";
    const to = todayInTimezone(zone, now);
    const earnings = sources[0]
      ? await sourceEarnings(prisma, sources[0], premium.id, { period: "custom", from: dateKey(addDays(to, -90)), to: dateKey(to), invalid: false }, now)
      : null;
    check(
      `Workspace Earnings = payments − refunds: ${gross} − ${refunds} = ${gross - refunds}`,
      earnings !== null && earnings.teacherShare === gross && earnings.refunds === refunds && earnings.net === gross - refunds,
      earnings ? `Earnings read ${earnings.teacherShare} − ${earnings.refunds} = ${earnings.net}` : "no source",
    );
    const live = await prisma.session.findFirst({ where: { centerId: ws.id, date: to, isManual: true }, include: { _count: { select: { attendees: true } } } });
    console.log(live ? `  INFO  today's live workspace session ${live.startTime}–${live.endTime}: ${live._count.attendees} checked in, ${live.closedAt ? "ended" : "open"}` : "  INFO  no live workspace session today (the seed skips it before 00:40 Cairo)");

    // Workspace assessments (W9).
    const wsAssessments = await prisma.assessment.findMany({ where: { centerId: ws.id }, include: { _count: { select: { attempts: { where: { submittedAt: { not: null } } } } } } });
    const byTitle = (title: string) => wsAssessments.find((row) => row.title === title);
    const kinematics = byTitle("Kinematics quiz");
    const forces = byTitle("Forces test");
    check("Workspace: an exam open now", kinematics?.status === "PUBLISHED" && kinematics.windowStart !== null && kinematics.windowEnd !== null && kinematics.windowStart <= now && kinematics.windowEnd > now);
    check("Workspace: a closed exam with answers and score revealed", forces?.status === "PUBLISHED" && forces.windowEnd !== null && forces.windowEnd < now && forces.showCorrectAnswers && forces.showScore);
    check("Workspace: a published homework and one draft", byTitle("Homework: motion graphs")?.status === "PUBLISHED" && byTitle("Energy exam (draft)")?.status === "DRAFT");

    // Students: the accepted link, the pending invitation, the unused share code.
    await loginOnly(wsStudent, "student.workspace's link", async () => {
      check("student.workspace holds a linked profile in the workspace, and is a student", (await prisma.studentProfile.count({ where: { centerId: ws.id, userId: wsStudent.id, active: true } })) === 1 && same(await kindsOf(wsStudent.id), ["student"]));
      const forcesAttempt = forces ? await prisma.assessmentAttempt.count({ where: { assessmentId: forces.id, studentProfile: { userId: wsStudent.id }, submittedAt: { not: null } } }) : 0;
      check("student.workspace submitted the closed workspace exam", forcesAttempt === 1);
    });
    await loginOnly(invited, "student.invited's invitation", async () => {
      check(
        "student.invited has one PENDING invitation from the workspace and no profile there",
        (await prisma.workspaceInvitation.count({ where: { centerId: ws.id, targetUserId: invited.id, status: "PENDING" } })) === 1 &&
          (await prisma.studentProfile.count({ where: { centerId: ws.id, userId: invited.id } })) === 0,
      );
    });
  }

  // teacher.premium's Downtown class: FIXED, upcoming only, no money.
  const downtownClass = await prisma.classGroup.findFirst({
    where: { teacherId: premium.id, center: { slug: "center-60-downtown" } },
    select: { id: true, price: true, centerShareType: true, centerShareValue: true, _count: { select: { enrollments: { where: { status: "ACTIVE" } } } } },
  });
  check("teacher.premium's Downtown class: FIXED 30 EGP of 150 EGP", downtownClass?.centerShareType === "FIXED" && downtownClass.centerShareValue === 3_000 && downtownClass.price === 15_000);
  if (downtownClass) {
    check("…11 enrolled, student.downtown among them", downtownClass._count.enrollments === 11 && (await prisma.enrollment.count({ where: { classGroupId: downtownClass.id, studentProfile: { userId: youssef.id }, status: "ACTIVE" } })) === 1, `${downtownClass._count.enrollments}`);
    check(
      "…no history and no money: no past session, no roster row, no payment",
      (await prisma.session.count({ where: { classGroupId: downtownClass.id, date: { lt: today } } })) === 0 &&
        (await prisma.sessionAttendee.count({ where: { session: { classGroupId: downtownClass.id } } })) === 0 &&
        (await prisma.payment.count({ where: { session: { classGroupId: downtownClass.id } } })) === 0,
    );
    const branchAssessments = await prisma.assessment.findMany({ where: { classGroupId: downtownClass.id }, select: { id: true, title: true, status: true, type: true, windowStart: true, windowEnd: true, showScore: true, showCorrectAnswers: true } });
    const t = (title: string) => branchAssessments.find((row) => row.title === title);
    const electricity = t("Electricity quiz");
    const waves = t("Waves exam");
    const optics = t("Optics exam");
    check("Downtown: an exam open now and a published homework", electricity?.status === "PUBLISHED" && electricity.windowEnd !== null && electricity.windowEnd > now && t("Homework: circuits")?.status === "PUBLISHED");
    check("Downtown: a closed exam with answers and score revealed", waves?.status === "PUBLISHED" && waves.windowEnd !== null && waves.windowEnd < now && waves.showCorrectAnswers && waves.showScore);
    check("Downtown: a closed exam still hidden (no score, no answers)", optics?.status === "PUBLISHED" && optics.windowEnd !== null && optics.windowEnd < now && !optics.showCorrectAnswers && !optics.showScore);
    const youssefAttempts = await prisma.assessmentAttempt.count({ where: { assessmentId: { in: [waves?.id ?? "", optics?.id ?? ""] }, studentProfile: { userId: youssef.id }, submittedAt: { not: null } } });
    check("student.downtown submitted both closed Downtown exams", youssefAttempts === 2);
    check("student.downtown's bell has notices (published assessments)", (await prisma.notification.count({ where: { userId: youssef.id } })) > 0);
  }
  console.log("  INFO  teacher.premium's bell: no notification kind is addressed to a teacher (W1, D-W12), so it stays empty by design");

  // The two dev-only codes: waiting, unexpired, stored as a sha256 only.
  const invite = await prisma.assistantInvite.findUnique({ where: { codeHash: hashAssistantCode(DEV_W_CODES.assistantInvite) } });
  check(
    `The dev assistant invite ${DEV_W_CODES.assistantInvite.slice(0, 4)}-${DEV_W_CODES.assistantInvite.slice(4, 8)}-${DEV_W_CODES.assistantInvite.slice(8)} is teacher.premium's, waiting and unexpired (re-run db:seed to renew)`,
    invite !== null && invite.teacherUserId === premium.id && invite.usedAt === null && invite.revokedAt === null && invite.expiresAt > now,
    invite ? `used=${Boolean(invite.usedAt)} revoked=${Boolean(invite.revokedAt)} expires=${invite.expiresAt.toISOString()}` : "missing",
  );
  const shareCode = await prisma.workspaceShareCode.findUnique({ where: { codeHash: hashAssistantCode(DEV_W_CODES.shareCode) } });
  check(
    `The dev share code ${DEV_W_CODES.shareCode.slice(0, 4)}-${DEV_W_CODES.shareCode.slice(4, 8)}-${DEV_W_CODES.shareCode.slice(8)} is the workspace's, waiting and unexpired (re-run db:seed to renew)`,
    shareCode !== null && shareCode.centerId === ws?.id && shareCode.usedAt === null && shareCode.revokedAt === null && shareCode.expiresAt > now,
    shareCode ? `used=${Boolean(shareCode.usedAt)} revoked=${Boolean(shareCode.revokedAt)} expires=${shareCode.expiresAt.toISOString()}` : "missing",
  );
  const plainCodes = await prisma.$queryRaw<{ n: number }[]>`
    SELECT ((SELECT COUNT(*) FROM "AssistantInvite" WHERE "codeHash" !~ '^[0-9a-f]{64}$') + (SELECT COUNT(*) FROM "WorkspaceShareCode" WHERE "codeHash" !~ '^[0-9a-f]{64}$'))::int AS n`;
  check("Every assistant invite and share code is stored as a sha256 only", (plainCodes[0]?.n ?? 1) === 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
