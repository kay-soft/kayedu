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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import {
  acceptFamilyCode,
  activeChildLinks,
  familyAccessForStudent,
  issueBranchCode,
  revokeFamilyLink,
} from "../lib/db/parents.ts";
import { canInContext, type Permission } from "../lib/auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../lib/auth/relations.ts";
import { grantMembershipBranch, loadPermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { confirmGradePromotion, promotionPreview, undoGradePromotion } from "../lib/db/promotion.ts";
import { addTeacherMembership } from "../lib/db/teacher-membership.ts";
import { cancelBookingByStudent, confirmBooking, rejectBooking, requestBooking } from "../lib/db/session-bookings.ts";
import {
  MissingCenterScopeError,
  TenantScopeError,
  requireScopedById,
  scopedData,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import { scopedWith } from "../lib/db/scoped.ts";

const prisma = await gatePrisma();

const SLUG_A = "isolation-check-a";
const SLUG_B = "isolation-check-b";
// F1: a sibling branch in Center A's organization.
const SLUG_A2 = "isolation-check-a2";
const ROOT = join(import.meta.dirname, "..");

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
  // F3: the family section's audit rows (family.code.issue) name these centres.
  const fixtureCenters = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_A2] } }, select: { id: true } });
  if (fixtureCenters.length > 0) {
    await deleteAuditRows(prisma, { centerId: { in: fixtureCenters.map((center) => center.id) } });
  }
  await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: "isolation-family-" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "isolation-family-" } } });
  // The sibling first (it shares Center A's organization), then the rest.
  await prisma.center.deleteMany({ where: { slug: SLUG_A2 } });
  const orgs = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { organizationId: true } });
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({
    where: { id: { in: orgs.map((row) => row.organizationId) }, centers: { none: {} } },
  });
  // F4: promotion fixtures — catalog grades are global and do not cascade with the centres.
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: "Isolation-Check" } } });
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          "isolation-a@kayedu.test",
          "isolation-b@kayedu.test",
          "isolation-manager@kayedu.test",
          "isolation-teacher@kayedu.test",
          // F6 — after the centres: its booking (RESTRICT on the User) went with them.
          "isolation-f6-booker@kayedu.test",
        ],
      },
    },
  });
}

async function main() {
  await cleanup();

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Isolation A", organization: { create: { name: "Isolation A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Isolation B", organization: { create: { name: "Isolation B" } } },
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

  // Branch (the old location-under-a-tenant model) was retired at M11 — a
  // room now belongs to the centre directly, the same non-money,
  // centerId-scoped shape Branch used to have, so it exercises this gate
  // exactly as before (docs/03-build-order.md M11: "check:isolation passes
  // with ZERO changes to its assertions" — the fixture model changed because
  // the old one no longer exists, the assertions below did not).
  const roomA = await prisma.room.create({
    data: { centerId: centerA.id, name: "A main" },
  });
  const roomB = await prisma.room.create({
    data: { centerId: centerB.id, name: "B main" },
  });

  console.log("Tenant isolation check");

  // 1. The happy path still works inside the active center.
  const ownRoom = await scopedFindById(prisma.room, centerA.id, roomA.id);
  check("Center A reads its own room by id", ownRoom?.id === roomA.id);

  // 2. The acceptance gate: another center's id must not resolve.
  const foreignRoom = await scopedFindById(
    prisma.room,
    centerA.id,
    roomB.id,
  );
  check(
    "Center A cannot read a Center B room by id",
    foreignRoom === null,
    foreignRoom ? `leaked room ${foreignRoom.id}` : "",
  );

  // 3. requireScopedById turns the same attempt into a hard error.
  let threwScopeError = false;
  try {
    await requireScopedById(prisma.room, centerA.id, roomB.id, "Room");
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
    scopedWhere("", { id: roomB.id });
  } catch (error) {
    threwMissingScope = error instanceof MissingCenterScopeError;
  }
  check("scopedWhere refuses to build an unscoped where", threwMissingScope);

  await checkBranchTargetedAdds(centerA.id, centerB.id, userA.id);
  await checkFamilyLinks(centerA.id, centerB.id, userA.id, userB.id);
  await checkGradePromotionIsolation(centerA.id, centerB.id, userA.id);
  await checkSessionBookingIsolation(centerA.id, centerB.id, userA.id, userB.id);
}

// ── 9. F6: a single-session booking belongs to one branch ──────────────────
// `SessionBooking` carries `centerId`; every read and every resolve is scoped
// by it. From another branch, the row does not resolve by id, cannot be
// confirmed, rejected or cancelled, and never appears in that branch's queue.
async function checkSessionBookingIsolation(centerAId: string, centerBId: string, actorAId: string, actorBId: string) {
  console.log("\nF6 — a session booking is one branch's");
  const DAY = 24 * 60 * 60 * 1000;
  const d = new Date(Date.now() + 3 * DAY);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const classA = await prisma.classGroup.create({
    data: scopedData(centerAId, {
      startDate: new Date("2026-01-01"),
      endDate: new Date("2027-12-31"),
      teacherId: actorAId,
      price: 10_000,
      sessionBookingMode: "APPROVAL",
    }),
  });
  const sessionA = await prisma.session.create({
    data: scopedData(centerAId, { classGroupId: classA.id, teacherId: actorAId, date, startTime: "15:00", endTime: "16:00", priceSnapshot: 10_000 }),
  });
  const student = await prisma.user.create({
    data: { email: "isolation-f6-booker@kayedu.test", firstName: "Booker", lastName: "F6" },
  });
  const requested = await prisma.$transaction((tx) =>
    requestBooking(tx, { centerId: centerAId, sessionId: sessionA.id, studentUserId: student.id }),
  );
  check("The booking is written at its own branch", requested.ok && requested.booking.centerId === centerAId);
  const bookingId = requested.ok ? requested.booking.id : "";

  check("Branch B cannot read Branch A's booking by id", (await scopedFindById(prisma.sessionBooking, centerBId, bookingId)) === null);
  const confirmFromB = await prisma.$transaction((tx) => confirmBooking(tx, centerBId, bookingId, actorBId));
  const rejectFromB = await prisma.$transaction((tx) => rejectBooking(tx, centerBId, bookingId, actorBId));
  const cancelFromB = await cancelBookingByStudent(prisma, centerBId, bookingId, student.id);
  check(
    "Branch B cannot confirm, reject or cancel it (notFound each time)",
    !confirmFromB.ok && confirmFromB.error === "notFound" &&
      !rejectFromB.ok && rejectFromB.error === "notFound" &&
      !cancelFromB.ok && cancelFromB.error === "notFound",
  );
  const bookFromB = await prisma.$transaction((tx) =>
    requestBooking(tx, { centerId: centerBId, sessionId: sessionA.id, studentUserId: student.id }),
  );
  check("A booking request naming Branch B for Branch A's session is notFound", !bookFromB.ok && bookFromB.error === "notFound");
  const queueB = await scopedWith(prisma, {
    center: { id: centerBId },
    user: { locale: "en" },
    role: "OWNER",
    isPlatformAdmin: false,
    settings: null,
  }).sessionBookings.listPending();
  check("Branch B's approvals queue never lists it", !queueB.some((row) => row.id === bookingId));
  const untouched = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: bookingId } });
  check("…and it is still PENDING, untouched", untouched.status === "PENDING" && untouched.resolvedAt === null);
}

// ── 8. F4: a promotion batch belongs to one branch, and only to it ─────────
// `GradePromotionBatch` carries `centerId`; every read and write is scoped by
// it. The preview, the confirm and the undo are asserted from another
// customer's branch AND from a sibling branch of the same organization —
// centerId is the sole key, so a sibling gets no more than a stranger.

async function checkGradePromotionIsolation(centerAId: string, centerBId: string, actorId: string) {
  console.log("\nF4 - grade promotion across branches");
  const sibling = await prisma.center.findUniqueOrThrow({ where: { slug: SLUG_A2 } });
  const gFrom = await prisma.catalogGrade.create({ data: { nameAr: "Isolation-Check From", nameEn: "Isolation-Check From" } });
  const gTo = await prisma.catalogGrade.create({ data: { nameAr: "Isolation-Check To", nameEn: "Isolation-Check To" } });
  for (const centerId of [centerAId, centerBId, sibling.id]) {
    for (const grade of [gFrom, gTo]) {
      await prisma.centerCatalogSelection.create({ data: { centerId, kind: "GRADE", gradeId: grade.id } });
    }
  }
  // One person, a profile at A and another at the sibling branch, both in the From grade.
  const person = await prisma.user.create({ data: { email: "isolation-family-promoted@kayedu.test", firstName: "Promo", lastName: "Ted" } });
  const atA = await prisma.studentProfile.create({ data: { userId: person.id, centerId: centerAId, studentCode: "ISO-P1", gradeId: gFrom.id } });
  const atSibling = await prisma.studentProfile.create({ data: { userId: person.id, centerId: sibling.id, studentCode: "ISO-P2", gradeId: gFrom.id } });
  const gradeOf = async (id: string) => (await prisma.studentProfile.findUniqueOrThrow({ where: { id } })).gradeId;

  check(
    "A branch's promotion preview lists only its own students (another customer's and a sibling's see none of them)",
    (await promotionPreview(prisma, centerAId, gFrom.id)).map((row) => row.id).join() === atA.id &&
      (await promotionPreview(prisma, centerBId, gFrom.id)).length === 0,
  );

  const done = await confirmGradePromotion(prisma, { centerId: centerAId, actorUserId: actorId, fromGradeId: gFrom.id, toGradeId: gTo.id, studentIds: [atA.id, atSibling.id] });
  check(
    "Promoting at A moves A's profile and ignores a sibling branch's profile of the same person, named by id",
    done.ok && done.count === 1 && done.skipped === 1 && (await gradeOf(atA.id)) === gTo.id && (await gradeOf(atSibling.id)) === gFrom.id,
    JSON.stringify(done),
  );
  const strangerMove = await confirmGradePromotion(prisma, { centerId: centerBId, actorUserId: actorId, fromGradeId: gTo.id, toGradeId: gFrom.id, studentIds: [atA.id] });
  check("Another customer's branch cannot move A's student by naming its id", !strangerMove.ok && (await gradeOf(atA.id)) === gTo.id);
  const siblingMove = await confirmGradePromotion(prisma, { centerId: sibling.id, actorUserId: actorId, fromGradeId: gTo.id, toGradeId: gFrom.id, studentIds: [atA.id] });
  check("A sibling branch of the same organization cannot either", !siblingMove.ok && (await gradeOf(atA.id)) === gTo.id);

  for (const [label, centerId] of [["Another customer's branch", centerBId], ["A sibling branch", sibling.id]] as const) {
    const undo = done.ok ? await undoGradePromotion(prisma, { centerId, actorUserId: actorId, batchId: done.batchId }) : null;
    check(`${label} cannot undo A's batch (notFound), and sees no batch of A's`, undo !== null && !undo.ok && undo.error === "notFound" && (await prisma.gradePromotionBatch.count({ where: scopedWhere(centerId) })) === 0);
  }
  check("…and A's student is still in the To grade", (await gradeOf(atA.id)) === gTo.id);
  const own = done.ok ? await undoGradePromotion(prisma, { centerId: centerAId, actorUserId: actorId, batchId: done.batchId }) : null;
  check("A's own undo works, and touches only A's profile", own?.ok === true && (await gradeOf(atA.id)) === gFrom.id && (await gradeOf(atSibling.id)) === gFrom.id);
}

// ── 7. F3: family links are global, their reads and writes are not ─────────
// A FamilyLink names two global Users (no centerId), but every staff read or
// write of one goes through a StudentProfile at the acting branch, and the
// parent reads only the child's own profiles. centerId stays the sole key:
// a sibling branch of the same organization gets no more than a stranger.

async function checkFamilyLinks(centerAId: string, centerBId: string, ownerAId: string, ownerBId: string) {
  console.log("\nF3 — family links across branches");
  const sibling = await prisma.center.findUniqueOrThrow({ where: { slug: SLUG_A2 } });
  const person = (tag: string) =>
    prisma.user.create({ data: { email: `isolation-family-${tag}@kayedu.test`, firstName: "Family", lastName: tag } });
  const child = await person("child");
  const profileA = await prisma.studentProfile.create({ data: { userId: child.id, centerId: centerAId, studentCode: "ISO-F1" } });
  const strangerChild = await person("stranger-child");
  await prisma.studentProfile.create({ data: { userId: strangerChild.id, centerId: centerBId, studentCode: "ISO-F2" } });
  const parent = await person("parent");

  const issued = await issueBranchCode(prisma, { centerId: centerAId, studentProfileId: profileA.id, actorUserId: ownerAId });
  const linked = issued.ok
    ? await acceptFamilyCode(prisma, { acceptorUserId: parent.id, code: issued.code, ip: "isolation-family-ip" })
    : null;
  check("Branch A issues a code for its own student and the parent links", issued.ok && linked?.ok === true);

  const readable = (await activeChildLinks(prisma, parent.id)).flatMap((link) => link.studentUser.studentProfiles);
  check(
    "The parent reads only the linked child's own profile — never another branch's student",
    readable.length === 1 && readable[0].id === profileA.id,
  );
  check(
    "Another customer's branch reads nothing of Branch A's student's parent access",
    (await familyAccessForStudent(prisma, centerBId, profileA.id)) === null,
  );
  check(
    "A sibling branch of the same organization reads nothing either (centerId is the sole key)",
    (await familyAccessForStudent(prisma, sibling.id, profileA.id)) === null,
  );
  const crossIssue = await issueBranchCode(prisma, { centerId: centerBId, studentProfileId: profileA.id, actorUserId: ownerBId });
  check("Branch B cannot issue a code for Branch A's student by naming its profile id (notFound)", !crossIssue.ok && crossIssue.error === "notFound");
  const crossRevoke = linked?.ok
    ? await revokeFamilyLink(prisma, { by: "branch", linkId: linked.linkId, actorUserId: ownerBId, centerId: centerBId, studentUserId: child.id, reason: "isolation" })
    : null;
  check("Branch B cannot revoke a link of a student it has no record of (notFound)", crossRevoke !== null && !crossRevoke.ok && crossRevoke.error === "notFound");
  check(
    "…and the link is still ACTIVE",
    linked?.ok === true && (await prisma.familyLink.findUniqueOrThrow({ where: { id: linked.linkId } })).status === "ACTIVE",
  );
}

// ── 6. F1: a branch-targeted invite / Add teacher ──────────────────────────
// Settings → Staff "Invite" and Teachers → "Add teacher" post a branch id.
// The actions re-resolve the actor at that branch through
// `getTenantContextForBranch` (lib/auth/tenant.ts) — the relation resolution
// + `buildContext` + `ctxCan` every request runs. That module needs the
// Next runtime, so this composes the same primitives it is built on:
// `resolveCenterRelations` → `roleForExperience("center")` →
// `loadPermissionGrants` → `canInContext`.

async function permittedAt(userId: string, centerId: string, permission: Permission): Promise<boolean> {
  const relations = await resolveCenterRelations(prisma, userId);
  const relation = relations.find((item) => item.center.id === centerId);
  if (!relation) return false;
  const role = roleForExperience(relation, "center");
  if (role === null) return false;
  const grants = role === "STUDENT" ? {} : await loadPermissionGrants(prisma, centerId, role);
  return canInContext({ experienceDenied: false, role, grants }, permission);
}

async function checkBranchTargetedAdds(centerAId: string, centerBId: string, ownerAId: string) {
  console.log("\nF1 — branch-targeted invite and Add teacher");

  // A second branch in Center A's organization, with the baseline matrix.
  const centerA = await prisma.center.findUniqueOrThrow({ where: { id: centerAId } });
  const sibling = await prisma.center.create({
    data: { slug: SLUG_A2, name: "Isolation A2", organizationId: centerA.organizationId },
  });
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, sibling.id));
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, centerAId));

  const manager = await prisma.user.create({ data: { email: "isolation-manager@kayedu.test", firstName: "Manager", lastName: "A" } });
  const managerMembership = await prisma.membership.create({ data: { userId: manager.id, centerId: centerAId, role: "MANAGER" } });

  check(
    "An Owner may invite at a sibling branch of their organization (membership.role.assign resolves there)",
    await permittedAt(ownerAId, sibling.id, "membership.role.assign"),
  );
  check(
    "A branch-aware invite to a branch the actor doesn't hold is refused — another customer's branch resolves nothing",
    !(await permittedAt(ownerAId, centerBId, "membership.role.assign")) &&
      !(await permittedAt(ownerAId, centerBId, "teacher.manage")),
  );
  check(
    "A MANAGER with no branch grant resolves nothing at the sibling branch — Add teacher there is refused",
    !(await permittedAt(manager.id, sibling.id, "teacher.manage")),
  );
  await grantMembershipBranch(prisma, managerMembership.id, sibling.id, ownerAId);
  check(
    "Granted the sibling branch, the MANAGER may add a teacher there (teacher.manage at that branch's own matrix)…",
    await permittedAt(manager.id, sibling.id, "teacher.manage"),
  );
  check(
    "…but still cannot invite there: D-22, inviting is OWNER-only at every branch",
    !(await permittedAt(manager.id, sibling.id, "membership.role.assign")),
  );
  await prisma.permissionGrant.update({
    where: { centerId_role_action: { centerId: sibling.id, role: "MANAGER", action: "teacher.manage" } },
    data: { allowed: false },
  });
  check(
    "The permission is checked at the target branch: switching teacher.manage off there refuses it, though the home branch still grants it",
    !(await permittedAt(manager.id, sibling.id, "teacher.manage")) && (await permittedAt(manager.id, centerAId, "teacher.manage")),
  );

  // The row lands in the target branch: the action writes with the target
  // context's centre id, through the one teacher-creation path.
  const added = await prisma.$transaction((tx) =>
    addTeacherMembership(
      tx,
      sibling.id,
      { firstName: "Isolation", lastName: "Teacher", email: "isolation-teacher@kayedu.test", phone: null, altPhone: null, locale: "en" },
      { actorUserId: ownerAId, linkUserId: null, via: "teacher.add", refusePrivileged: false },
    ),
  );
  const teacherRows = added.ok ? await prisma.membership.findMany({ where: { userId: added.userId } }) : [];
  check(
    "A teacher added for the sibling branch has exactly one membership, at that branch",
    added.ok && teacherRows.length === 1 && teacherRows[0].centerId === sibling.id && teacherRows[0].role === "TEACHER",
    JSON.stringify(added),
  );

  // Static: the actions never trust the posted id.
  const tenant = readFileSync(join(ROOT, "lib", "auth", "tenant.ts"), "utf8");
  const staffActions = readFileSync(join(ROOT, "app", "[locale]", "(center)", "settings", "staff", "actions.ts"), "utf8");
  const teacherActions = readFileSync(join(ROOT, "app", "[locale]", "(center)", "teachers", "actions.ts"), "utf8");
  check(
    "getTenantContextForBranch looks the id up among the actor's own relations and builds the context the usual way (static)",
    /export async function getTenantContextForBranch[\s\S]{0,600}getUserCenterRelations\(user\.id\)[\s\S]{0,300}buildContext\(user, relation, experience\)/.test(tenant),
  );
  check(
    "createInvitationAction checks membership.role.assign on the target context and writes through scoped(target) (static)",
    /getTenantContextForBranch\(branchId, "center"\)/.test(staffActions) &&
      /ctxCan\(target, "membership\.role\.assign"\)/.test(staffActions) &&
      /scoped\(target\)/.test(staffActions),
  );
  check(
    "createTeacherAction resolves teacherScope(branchId) — getTenantContextForBranch + teacher.manage at that branch (static)",
    /teacherScope\(branchId\)/.test(teacherActions) &&
      /getTenantContextForBranch\(branchId, "center"\)/.test(teacherActions) &&
      /ctxCan\(ctx, "teacher\.manage"\)/.test(teacherActions) &&
      /createTeacherMembership\(\s*prisma,\s*scope\.ctx\.center\.id/.test(teacherActions),
  );

  // T6: "Whole Management" is refused above the data layer (the branch-scope
  // guard in every centre action and page); the scoping primitives never see
  // a roll-up, so `centerId` stays the sole isolation key.
  const scopedSource = readFileSync(join(ROOT, "lib", "db", "scoped.ts"), "utf8");
  const tenantScopeSource = readFileSync(join(ROOT, "lib", "db", "tenant-scope.ts"), "utf8");
  check(
    "The scoped data layer never reads rollupOrganizationId or the branch-scope guard (static)",
    !/rollupOrganizationId|branch-scope|requireBranchScope/.test(scopedSource) &&
      !/rollupOrganizationId|branch-scope|requireBranchScope/.test(tenantScopeSource),
  );
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
