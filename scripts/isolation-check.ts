/**
 * Tenant isolation check — the M1 acceptance gate:
 * "a user of Center A cannot load a Center B record by ID."
 *
 * Run with:  npm run check:isolation
 *
 * It exercises the real scoping primitives from lib/db/tenant-scope.ts (the
 * same ones lib/db/scoped.ts is built on), creates two throwaway centers,
 * asserts the cross-center reads are denied, and cleans up after itself.
 */
import { PrismaClient } from "@prisma/client";
import {
  MissingCenterScopeError,
  TenantScopeError,
  requireScopedById,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";

const prisma = new PrismaClient();

const SLUG_A = "isolation-check-a";
const SLUG_B = "isolation-check-b";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({
    where: { email: { in: ["isolation-a@kayedu.test", "isolation-b@kayedu.test"] } },
  });
}

async function main() {
  await cleanup();

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Isolation A" },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Isolation B" },
  });

  const userA = await prisma.user.create({
    data: {
      email: "isolation-a@kayedu.test",
      firstName: "Owner",
      lastName: "A",
    },
  });
  const userB = await prisma.user.create({
    data: {
      email: "isolation-b@kayedu.test",
      firstName: "Owner",
      lastName: "B",
    },
  });

  await prisma.membership.create({
    data: { userId: userA.id, centerId: centerA.id, role: "OWNER" },
  });
  const membershipB = await prisma.membership.create({
    data: { userId: userB.id, centerId: centerB.id, role: "OWNER" },
  });

  const branchA = await prisma.branch.create({
    data: { centerId: centerA.id, name: "A main" },
  });
  const branchB = await prisma.branch.create({
    data: { centerId: centerB.id, name: "B main" },
  });

  console.log("Tenant isolation check");

  // 1. The happy path still works inside the active center.
  const ownBranch = await scopedFindById(prisma.branch, centerA.id, branchA.id);
  check("Center A reads its own branch by id", ownBranch?.id === branchA.id);

  // 2. The acceptance gate: another center's id must not resolve.
  const foreignBranch = await scopedFindById(
    prisma.branch,
    centerA.id,
    branchB.id,
  );
  check(
    "Center A cannot read a Center B branch by id",
    foreignBranch === null,
    foreignBranch ? `leaked branch ${foreignBranch.id}` : "",
  );

  // 3. requireScopedById turns the same attempt into a hard error.
  let threwScopeError = false;
  try {
    await requireScopedById(prisma.branch, centerA.id, branchB.id, "Branch");
  } catch (error) {
    threwScopeError = error instanceof TenantScopeError;
  }
  check("requireScopedById throws TenantScopeError across centers", threwScopeError);

  // 4. A scoped list never contains another center's rows.
  const membershipsInA = await prisma.membership.findMany({
    where: scopedWhere(centerA.id),
  });
  check(
    "Scoped membership list excludes Center B rows",
    membershipsInA.every((row) => row.centerId === centerA.id) &&
      !membershipsInA.some((row) => row.id === membershipB.id),
  );

  // 5. Building a scoped query without a centerId is a loud failure, never a
  //    silent unscoped read.
  let threwMissingScope = false;
  try {
    scopedWhere("", { id: branchB.id });
  } catch (error) {
    threwMissingScope = error instanceof MissingCenterScopeError;
  }
  check("scopedWhere refuses to build an unscoped where", threwMissingScope);
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} isolation check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll isolation checks passed.");
  });
