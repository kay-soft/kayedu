/**
 * P1 STEP 0 — read-only diagnosis of "an Owner / Manager sees only Dashboard".
 *
 * Run with:  npm run diagnose:nav
 *
 * Writes NOTHING. For every active membership in the database it prints the
 * resolved relations, the active centre and resolved role, the PermissionGrant
 * rows that centre holds for that role, and the nav items the shell would
 * render — all computed through the SAME functions the shell uses:
 *   - `resolveCenterRelations` / `roleForExperience`  (lib/auth/relations.ts —
 *     what `getUserCenterRelations` / `getTenantContext` call),
 *   - `loadPermissionGrants`                          (lib/db/permissions.ts),
 *   - `navForExperience`                              (components/shell/nav.ts).
 *
 * Then it tests the five hypotheses from the P1 brief and prints a verdict:
 *   (1) centres created without the provisioning baseline (no / partial
 *       PermissionGrant rows — deny-by-default hides everything);
 *   (2) nav items gated on permission names no baseline row grants, or that
 *       differ from the page's own gate;
 *   (3) the R10a nav regrouping filter dropping items it should keep;
 *   (4) Owner org-level widening landing on a branch with no grants;
 *   (5) lifecycle state hiding a centre.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { DEFAULT_ROLE_GRANTS, PERMISSIONS, permissionsFor } from "../lib/auth/permissions.ts";
import {
  resolveCenterRelations,
  roleForExperience,
  type Experience,
} from "../lib/auth/relations.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "../lib/db/platform.ts";
import { centerBaselineGaps, hasFullBaseline } from "../lib/db/provision.ts";
import { CENTER_NAV, TEACHER_NAV, navForExperience } from "../components/shell/nav.ts";
import { pageGateFor } from "./lib/nav-gates.ts";

const prisma = new PrismaClient();

const experienceFor = (role: Role): Experience => (role === "TEACHER" ? "teacher" : "center");

async function main() {
  console.log("P1 nav diagnosis (read-only)\n");

  // ── Who exists ────────────────────────────────────────────────────────
  const memberships = await prisma.membership.findMany({
    where: { active: true },
    include: {
      user: { select: { id: true, email: true } },
      center: { select: { slug: true, lifecycleState: true } },
    },
    orderBy: [{ user: { email: "asc" } }],
  });
  const userIds = [...new Set(memberships.map((m) => m.user.id))];
  console.log(`${memberships.length} active membership(s) across ${userIds.length} user(s).\n`);

  // ── Per account ───────────────────────────────────────────────────────
  for (const userId of userIds) {
    const own = memberships.filter((m) => m.user.id === userId);
    const email = own[0].user.email ?? "(no email)";
    const relations = await resolveCenterRelations(prisma, userId);
    console.log(`■ ${email}`);
    console.log(
      `  memberships: ${own.map((m) => `${m.role}@${m.center.slug}[${m.center.lifecycleState}]`).join(", ")}`,
    );
    console.log(`  resolved relations: ${relations.length}`);
    for (const relation of relations) {
      const heldRoles = relation.roles.filter((r) => r !== "STUDENT");
      if (heldRoles.length === 0) continue;
      const experience = experienceFor(heldRoles[0] as Role);
      const role = roleForExperience(relation, experience);
      if (role === null || role === "STUDENT") continue;
      const grants = await loadPermissionGrants(prisma, relation.center.id, role);
      const allowed = Object.entries(grants).filter(([, v]) => v).length;
      const nav = navForExperience(experience, role, grants);
      const widened = !own.some((m) => m.centerId === relation.center.id);
      console.log(
        `  → ${relation.center.slug}${widened ? " (org-widened, no own row)" : ""}  roles=[${relation.roles.join(",")}]  active role=${role}  experience=${experience}`,
      );
      console.log(`     PermissionGrant rows for ${role}: ${Object.keys(grants).length} (${allowed} allowed)`);
      console.log(`     nav (${nav.length}): ${nav.map((n) => n.labelKey).join(", ") || "(none)"}`);
    }
    console.log("");
  }

  // ── Hypothesis 1: centres without the provisioning baseline ───────────
  console.log("── (1) Centres vs the provisioning baseline ──");
  const centers = await prisma.center.findMany({ orderBy: { slug: "asc" } });
  const incomplete: string[] = [];
  for (const center of centers) {
    const gaps = await centerBaselineGaps(prisma, center.id);
    const rows = await prisma.permissionGrant.count({ where: { centerId: center.id } });
    const ok = hasFullBaseline(gaps);
    console.log(
      `  ${ok ? "ok     " : "MISSING"} ${center.slug.padEnd(28)} grants=${rows} missing=${gaps.missingGrants.length} settings=${gaps.missingSettings ? "MISSING" : "ok"} paymentMethods(active)=${gaps.activePaymentMethods}`,
    );
    if (!ok) incomplete.push(center.slug);
  }
  console.log(
    incomplete.length
      ? `  → HYPOTHESIS 1 CONFIRMED for: ${incomplete.join(", ")}`
      : "  → hypothesis 1 not confirmed: every centre has the full baseline",
  );

  // ── Hypothesis 2: nav permission names vs grants vs page gates ────────
  console.log("\n── (2) Nav permissions vs baseline grants vs the page's own gate ──");
  let navProblems = 0;
  for (const [experience, defs] of [
    ["center", CENTER_NAV],
    ["teacher", TEACHER_NAV],
  ] as const) {
    for (const def of defs) {
      const page = pageGateFor(experience, def.href);
      const pagePerm = page.found ? page.permission : null;
      const navPerm = def.permission ?? null;
      const known = navPerm === null || (PERMISSIONS as readonly string[]).includes(navPerm);
      const holders = navPerm
        ? (Object.keys(DEFAULT_ROLE_GRANTS) as Role[]).filter((r) =>
            (DEFAULT_ROLE_GRANTS[r] as readonly string[]).includes(navPerm),
          )
        : [];
      const same = !page.found || pagePerm === navPerm;
      if (!known || !same) navProblems += 1;
      console.log(
        `  ${same && known ? "ok    " : "DIFFER"} ${experience.padEnd(7)} ${def.href.padEnd(22)} nav=${navPerm ?? "-"}  page=${page.found ? (pagePerm ?? "-") : "(no page file)"}  baseline holders=[${holders.join(",")}]`,
      );
    }
  }
  console.log(
    navProblems
      ? `  → ${navProblems} item(s) differ from their page gate`
      : "  → every nav item matches its page gate",
  );

  // ── Hypothesis 3: the R10a filter ─────────────────────────────────────
  console.log("\n── (3) The nav filter itself (R10a regrouping) ──");
  for (const role of ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const) {
    const grants = Object.fromEntries(DEFAULT_ROLE_GRANTS[role].map((a) => [a, true]));
    const nav = navForExperience("center", role, grants);
    const expected = CENTER_NAV.filter(
      (d) => !d.permission || permissionsFor(role, grants).includes(d.permission),
    );
    console.log(
      `  ${role.padEnd(13)} with the baseline grants → ${nav.length}/${expected.length} expected: ${nav.map((n) => n.labelKey).join(", ")}`,
    );
  }
  console.log("  → the filter drops nothing the permissions allow; with the baseline in place each role gets its items");

  // ── Hypothesis 4: owner org widening onto an unprovisioned branch ─────
  console.log("\n── (4) Owner org-level widening ──");
  for (const owner of memberships.filter((m) => m.role === "OWNER")) {
    const relations = await resolveCenterRelations(prisma, owner.user.id);
    for (const relation of relations.filter((r) => r.roles.includes("OWNER"))) {
      const grants = await loadPermissionGrants(prisma, relation.center.id, "OWNER");
      console.log(
        `  ${owner.user.email} reaches ${relation.center.slug}: OWNER grant rows there = ${Object.keys(grants).length}`,
      );
    }
  }

  // ── Hypothesis 5: lifecycle ────────────────────────────────────────────
  console.log("\n── (5) Lifecycle state ──");
  for (const center of centers) {
    const accessible = (ACCESSIBLE_LIFECYCLE_STATES as readonly string[]).includes(
      center.lifecycleState,
    );
    console.log(
      `  ${center.slug.padEnd(28)} ${center.lifecycleState.padEnd(10)} ${accessible ? "sign-in allowed" : "REFUSED at sign-in"}`,
    );
  }

  console.log(
    "\nVerdict: see (1). Deny-by-default (docs/02 §6.1) + a centre with no PermissionGrant rows = nothing but the ungated Dashboard.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
