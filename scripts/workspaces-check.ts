/**
 * `npm run check:workspaces` (W8a, D-W20, D-W21, D-W28, D-W38) — PERSONAL
 * workspaces: creation and its baseline, owner-only authority, premium on
 * every write but archive, the 100-ACTIVE cap under the lock (and under
 * concurrency), archive and unarchive, the forced 0 cut and the offered pairs,
 * Discover / Explore / reservations / bookings, every centre-wide exclusion
 * by a read, isolation, ids-only audit, the workspace-only teacher's
 * experience, and the statics.
 *
 * Writes and cleans up its own fixtures (users `workspaces-check-…`, the
 * branch and catalogue rows `workspaces-check-…`, and every centre under the
 * fixture users' personal organizations). Fenced by S1 (`gatePrisma`): staging
 * or a local database only.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { readSource } from "./lib/source.ts";
import { loadExperiences } from "../lib/auth/experiences.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { isPairOffered } from "../lib/db/catalog.ts";
import { discoverCenter, discoverClassesForCenter } from "../lib/db/discover.ts";
import { organizationBranches } from "../lib/db/organizations.ts";
import {
  ACCESSIBLE_CENTER,
  COUNTED_BRANCHES,
  addBranchToOrganization,
  listAccessibleCenters,
  lockOrganizationBranches,
  platformAdoptionTrend,
  platformCenterById,
  platformCenterCounts,
  platformCenterList,
  platformOrganizationById,
  platformOrganizationList,
  platformSessionCount,
  platformStudentCount,
  platformTeacherCount,
} from "../lib/db/platform.ts";
import { centerBaselineGaps, provisionCenterBaseline } from "../lib/db/provision.ts";
import { listPublicBranches, publicBranchBySlug, searchPublicClasses } from "../lib/db/public-catalog.ts";
import { reserveOrEnroll } from "../lib/db/reservations.ts";
import { requestBooking } from "../lib/db/session-bookings.ts";
import { scopedFindById } from "../lib/db/tenant-scope.ts";
import {
  WORKSPACE_ACTIVE_CAP,
  WORKSPACE_OWNER_CAPABILITIES,
  archiveWorkspace,
  cancelWorkspaceSession,
  countActiveWorkspaces,
  createWorkspace,
  createWorkspaceClass,
  createWorkspaceSession,
  deleteWorkspaceClass,
  deleteWorkspaceSession,
  listOwnedWorkspaces,
  renameWorkspace,
  rescheduleWorkspaceSession,
  resolveWorkspaceAccess,
  setWorkspaceClassActive,
  unarchiveWorkspace,
  updateWorkspaceClass,
  workspaceCan,
  workspaceClasses,
  workspaceSessions,
  writeWorkspaceClassSlot,
} from "../lib/db/workspaces.ts";
import { ROUTES } from "../lib/routes.ts";
import { addDays, todayInTimezone } from "../lib/scheduling.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const STEM = "workspaces-check";
const EMAIL_PREFIX = `${STEM}-`;
const ORG_NAME = "Workspaces Check";
const RUN = randomUUID().slice(0, 8);
const TZ = "Africa/Cairo";

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function fixtureUserIds(): Promise<string[]> {
  return (await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })).map((row) => row.id);
}

async function cleanup() {
  const userIds = await fixtureUserIds();
  const personalOrgs = userIds.length > 0
    ? await prisma.organization.findMany({ where: { ownerUserId: { in: userIds } }, select: { id: true } })
    : [];
  const centers = await prisma.center.findMany({
    where: { OR: [{ slug: { startsWith: STEM } }, { organizationId: { in: personalOrgs.map((org) => org.id) } }] },
    select: { id: true },
  });
  const centerIds = centers.map((center) => center.id);
  // Audit rows first: AuditLog has no cascade, and it is append-only (maintenance mode).
  if (centerIds.length > 0) await deleteAuditRows(prisma, { centerId: { in: centerIds } });
  if (userIds.length > 0) await deleteAuditRows(prisma, { actorUserId: { in: userIds } });
  await prisma.center.deleteMany({ where: { id: { in: centerIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: personalOrgs.map((org) => org.id) } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: ORG_NAME }, centers: { none: {} } } });
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: STEM } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: STEM } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

let seq = 0;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
async function makeUser(tag: string, extra: { premium?: boolean; isPlatformAdmin?: boolean } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: "Fixture",
      lastName: `${tag}${seq}`,
      email: `${EMAIL_PREFIX}${tag}-${seq}-${RUN}@kayedu.test`,
      locale: "en",
      emailVerifiedAt: new Date(),
      premiumUntil: extra.premium ? inDays(30) : null,
      isPlatformAdmin: extra.isPlatformAdmin ?? false,
    },
  });
}

const setPremium = (userId: string, until: Date | null) =>
  prisma.user.update({ where: { id: userId }, data: { premiumUntil: until } });

const read = (path: string) => readSource(join(ROOT, path));

async function main() {
  await cleanup();
  const now = new Date();
  const today = todayInTimezone(TZ, now);
  const tomorrow = addDays(today, 1);

  // ── 0. Fixtures ───────────────────────────────────────────────────────
  console.log("0. Fixtures");
  const grade = await prisma.catalogGrade.create({ data: { nameAr: `${STEM} صف`, nameEn: `${STEM} grade ${RUN}` } });
  const offGrade = await prisma.catalogGrade.create({ data: { nameAr: `${STEM} صف ٢`, nameEn: `${STEM} grade off ${RUN}`, active: false } });
  const subject = await prisma.catalogSubject.create({
    data: { nameAr: `${STEM} مادة`, nameEn: `${STEM} subject ${RUN}`, gradeLinks: { create: [{ gradeId: grade.id }, { gradeId: offGrade.id }] } },
  });
  const unlinked = await prisma.catalogSubject.create({ data: { nameAr: `${STEM} مادة ٢`, nameEn: `${STEM} subject unlinked ${RUN}` } });

  const branchOrg = await prisma.organization.create({ data: { name: `${ORG_NAME} ${RUN}`, maxBranches: 3 } });
  const branch = await prisma.center.create({ data: { slug: `${STEM}-branch-${RUN}`, name: `${ORG_NAME} Branch`, organizationId: branchOrg.id } });
  await provisionCenterBaseline(prisma, branch.id);

  const ownerA = await makeUser("teacher-a", { premium: true });
  const ownerB = await makeUser("teacher-b", { premium: true });
  const ownerC = await makeUser("teacher-cap", { premium: true });
  const never = await makeUser("never-premium");
  const admin = await makeUser("platform-admin", { premium: true, isPlatformAdmin: true });
  const assistant = await makeUser("assistant", { premium: true });
  const student = await makeUser("student", { premium: true });
  const staff = {
    OWNER: await makeUser("owner", { premium: true }),
    MANAGER: await makeUser("manager", { premium: true }),
    RECEPTIONIST: await makeUser("receptionist", { premium: true }),
    ACCOUNTANT: await makeUser("accountant", { premium: true }),
    TEACHER: await makeUser("branch-teacher", { premium: true }),
  };
  for (const [role, user] of Object.entries(staff)) {
    await prisma.membership.create({
      data: { userId: user.id, centerId: branch.id, role: role as keyof typeof staff, firstName: "M", lastName: role, joinedAt: now },
    });
  }
  // A teaches at the branch too: a workspace never joins that relation.
  await prisma.membership.create({ data: { userId: ownerA.id, centerId: branch.id, role: "TEACHER", firstName: "A", lastName: "Teacher", joinedAt: now } });
  await prisma.studentProfile.create({ data: { userId: student.id, centerId: branch.id, studentCode: `${STEM}-${RUN}` } });
  await prisma.teacherAssistant.create({ data: { teacherUserId: ownerA.id, assistantUserId: assistant.id, preset: "CO_TEACHER" } });
  check("Fixtures built", true);

  // The platform figures before any workspace exists (they must not move).
  const kpisBefore = {
    counts: await platformCenterCounts(prisma),
    teachers: await platformTeacherCount(prisma),
    students: await platformStudentCount(prisma),
    sessions: await platformSessionCount(prisma),
    adoption: JSON.stringify(await platformAdoptionTrend(prisma)),
  };

  // ── 1. Creation and its baseline ──────────────────────────────────────
  console.log("\n1. Creation: premium, the personal organization, the minimal rows, no baseline");
  const refusedNever = await createWorkspace(prisma, never.id, { name: "Never" });
  check(
    "A never-premium account is refused (premiumRequired) and gets no organization",
    !refusedNever.ok && refusedNever.error === "premiumRequired" &&
      (await prisma.organization.count({ where: { ownerUserId: never.id } })) === 0,
  );
  check("A blank name is refused before anything", !(await createWorkspace(prisma, ownerA.id, { name: "   " })).ok);
  const createdA = await createWorkspace(prisma, ownerA.id, { name: "A Physics" });
  const createdB = await createWorkspace(prisma, ownerB.id, { name: "B Maths" });
  check("A premium teacher creates a workspace", createdA.ok && createdB.ok);
  if (!createdA.ok || !createdB.ok) return;
  const wsA = createdA.workspaceId;
  const wsB = createdB.workspaceId;
  const centerA = await prisma.center.findUniqueOrThrow({ where: { id: wsA }, include: { organization: true, settings: true } });
  check(
    "The centre is PERSONAL, ACTIVE, not archived, under the teacher's own organization, with a generated non-public slug",
    centerA.kind === "PERSONAL" && centerA.lifecycleState === "ACTIVE" && centerA.archivedAt === null &&
      centerA.organization.ownerUserId === ownerA.id && centerA.slug.startsWith("ws-"),
  );
  check(
    "A minimal CenterSettings row: Africa/Cairo, conflict policy WARN",
    centerA.settings?.timezone === TZ && centerA.settings?.scheduleConflictPolicy === "WARN",
  );
  const membershipsA = await prisma.membership.findMany({ where: { centerId: wsA } });
  check(
    "Exactly one membership: the owner's ACTIVE TEACHER one",
    membershipsA.length === 1 && membershipsA[0].userId === ownerA.id && membershipsA[0].role === "TEACHER" && membershipsA[0].active,
  );
  const gaps = await centerBaselineGaps(prisma, wsA);
  check(
    "No baseline: no PermissionGrant row, no payment method (by design — not a gap to fill)",
    (await prisma.permissionGrant.count({ where: { centerId: wsA } })) === 0 &&
      (await prisma.centerPaymentMethod.count({ where: { centerId: wsA } })) === 0 &&
      gaps.missingGrants.length > 0,
  );
  check("One hidden default room, capacity 0 (no seat limit)", (await prisma.room.findMany({ where: { centerId: wsA } })).map((room) => room.capacity).join() === "0");
  const secondA = await createWorkspace(prisma, ownerA.id, { name: "A Chemistry" });
  check(
    "A second workspace reuses the one personal organization",
    secondA.ok && (await prisma.organization.count({ where: { ownerUserId: ownerA.id } })) === 1 &&
      (await prisma.center.findUniqueOrThrow({ where: { id: secondA.ok ? secondA.workspaceId : "" } })).organizationId === centerA.organizationId,
  );
  let triggerRefused = false;
  try {
    await prisma.center.create({ data: { slug: `${STEM}-bad-${RUN}`, name: "bad", kind: "PERSONAL", organizationId: branchOrg.id } });
  } catch {
    triggerRefused = true;
  }
  check("The database refuses a PERSONAL centre under an organization with no owner (trigger)", triggerRefused);
  let checkRefused = false;
  try {
    await prisma.center.update({ where: { id: branch.id }, data: { archivedAt: now, archivedByUserId: ownerA.id } });
  } catch {
    checkRefused = true;
  }
  check("The database refuses an archive flag on a BRANCH (CHECK)", checkRefused);

  // ── 2. Classes: the forced cut, the owner as teacher, the offered pairs ──
  console.log("\n2. Classes: the engine with the workspace's forced values");
  const slot = { dayOfWeek: tomorrow.getUTCDay(), startTime: "16:00", endTime: "18:00" };
  const classInput = {
    educationSystemId: null,
    gradeId: grade.id,
    subjectId: subject.id,
    price: 15_000,
    lateThresholdMinutes: 10,
    startDate: today,
    endDate: addDays(today, 27),
  };
  const options = { confirmConflicts: false, locale: "en" };
  const fixedCut = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, slots: [slot], centerShareType: "FIXED", centerShareValue: 500 }, options);
  const pctCut = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, slots: [slot], centerShareType: "PERCENTAGE", centerShareValue: 15 }, options);
  check(
    "Any cut other than PERCENTAGE 0 is refused (workspaceCutFixed) and writes nothing",
    !fixedCut.ok && fixedCut.error === "workspaceCutFixed" && !pctCut.ok && pctCut.error === "workspaceCutFixed" &&
      (await prisma.classGroup.count({ where: { centerId: wsA } })) === 0,
  );
  const unlinkedPair = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, subjectId: unlinked.id, slots: [slot] }, options);
  const offPair = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, gradeId: offGrade.id, slots: [slot] }, options);
  check("An unlinked pair is refused (subjectNotInGrade)", !unlinkedPair.ok && unlinkedPair.error === "subjectNotInGrade");
  check("An inactive catalogue grade is refused (gradeNotFound)", !offPair.ok && offPair.error === "gradeNotFound");
  check(
    "The pair rule's PERSONAL branch: a linked active pair is offered in a workspace with no CenterCatalogSelection, and not at a branch that never picked it",
    (await prisma.centerCatalogSelection.count({ where: { centerId: wsA } })) === 0 &&
      (await isPairOffered(prisma, wsA, grade.id, subject.id)) &&
      !(await isPairOffered(prisma, wsA, grade.id, unlinked.id)) &&
      !(await isPairOffered(prisma, branch.id, grade.id, subject.id)),
  );
  const created = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, slots: [slot] }, options);
  check("A class with a weekly slot is created", created.ok, created.ok ? "" : JSON.stringify(created));
  if (!created.ok) return;
  const classId = created.classGroupId;
  const row = await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } });
  check(
    "The class: the owner teaches it, PERCENTAGE 0, booking OFF, not open to joining, on the hidden room",
    row.teacherId === ownerA.id && row.centerShareType === "PERCENTAGE" && row.centerShareValue === 0 &&
      row.sessionBookingMode === "OFF" && !row.acceptsNewStudents && row.roomId !== null,
  );
  const generated = await prisma.session.findMany({ where: { classGroupId: classId }, orderBy: [{ date: "asc" }] });
  check("Its sessions are generated for the period (4 weekly sessions)", generated.length === 4, `${generated.length}`);
  check(
    "Every generated session is the owner's, on the hidden room, at the class price",
    generated.every((session) => session.teacherId === ownerA.id && session.roomId === row.roomId && session.priceSnapshot === 15_000),
  );
  const updated = await updateWorkspaceClass(prisma, ownerA.id, wsA, classId, { ...classInput, price: 20_000 }, options);
  const afterUpdate = await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } });
  check("Editing the price keeps the forced cut", updated.ok && afterUpdate.price === 20_000 && afterUpdate.centerShareValue === 0 && afterUpdate.centerShareType === "PERCENTAGE");
  const cutOnEdit = await updateWorkspaceClass(prisma, ownerA.id, wsA, classId, { ...classInput, centerShareType: "FIXED", centerShareValue: 0 }, options);
  check("A posted FIXED cut on edit is refused too", !cutOnEdit.ok && cutOnEdit.error === "workspaceCutFixed");

  // ── 3. Sessions: reschedule, cancel, one-time, extra, delete ──────────
  console.log("\n3. Sessions: the engine's reschedule, cancel, one-time and extra sessions");
  const [first, second] = generated;
  const moved = await rescheduleWorkspaceSession(prisma, ownerA.id, wsA, first.id, { date: addDays(first.date, 1), startTime: "10:00", endTime: "11:00" }, options);
  check("Reschedule creates the replacement and links the original", moved.ok && (await prisma.session.findUniqueOrThrow({ where: { id: first.id } })).rescheduledToId !== null);
  const cancelled = await cancelWorkspaceSession(prisma, ownerA.id, wsA, second.id);
  check("Cancel marks the session CANCELLED", cancelled.ok && (await prisma.session.findUniqueOrThrow({ where: { id: second.id } })).status === "CANCELLED");
  const oneOff = await createWorkspaceSession(prisma, ownerA.id, wsA, { kind: "oneOff", title: "Revision", price: 5_000, date: addDays(today, 3), startTime: "12:00", endTime: "13:00" }, options);
  const oneOffRow = oneOff.ok ? await prisma.session.findUniqueOrThrow({ where: { id: oneOff.sessionId } }) : null;
  check(
    "A one-time session carries the forced 0 cut (PERCENTAGE 0) and the owner",
    oneOffRow !== null && oneOffRow.centerShareType === "PERCENTAGE" && oneOffRow.centerShareValue === 0 && oneOffRow.teacherId === ownerA.id,
  );
  const extra = await createWorkspaceSession(prisma, ownerA.id, wsA, { kind: "extra", classGroupId: classId, date: addDays(today, 4), startTime: "12:00", endTime: "13:00" }, options);
  check("An extra session for the class is created", extra.ok);
  const deletedOneOff = oneOff.ok ? await deleteWorkspaceSession(prisma, ownerA.id, wsA, oneOff.sessionId) : { ok: false };
  check("A one-time session that never ran is deleted", deletedOneOff.ok);
  const addSlot = await writeWorkspaceClassSlot(prisma, ownerA.id, wsA, { kind: "add", classGroupId: classId, slot: { ...slot, startTime: "19:00", endTime: "20:00" } }, options);
  check("Adding a weekly slot resyncs the sessions", addSlot.ok && (addSlot.report?.created ?? 0) > 0);
  const listed = await workspaceSessions(prisma, wsA, { from: today });
  check("The workspace's session list reads its own sessions, a moved original left out", listed.length > 0 && listed.every((session) => session.rescheduledToId === null));

  // ── 4. Private: Discover, Explore, reservations, bookings ─────────────
  console.log("\n4. Private: never in Discover or Explore; reservations and bookings refused by direct call");
  check("Discover's centre list leaves the workspace out", !(await listAccessibleCenters(prisma)).some((center) => center.id === wsA));
  check("Discover's centre lookup does not find it", (await discoverCenter(prisma, wsA)) === null);
  check("Discover's class list for it is empty (never browsable)", (await discoverClassesForCenter(prisma, wsA)).length === 0);
  const publicPage = await listPublicBranches(prisma, 1);
  check("Explore's branch list leaves it out", !publicPage.branches.some((entry) => entry.id === wsA));
  check("Explore's branch page by slug does not find it", (await publicBranchBySlug(prisma, centerA.slug)) === null);
  check("Explore's class search has none of its classes", !(await searchPublicClasses(prisma, now, {})).some((entry) => entry.id === classId));
  const reservation = await prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId: wsA, classGroupId: classId, studentUserId: student.id }));
  check("A reservation for a workspace class is refused (notFound)", !reservation.ok && reservation.error === "notFound");
  const anySession = listed[0];
  const booking = await prisma.$transaction((tx) => requestBooking(tx, { centerId: wsA, sessionId: anySession.id, studentUserId: student.id }));
  check("A single-session booking is refused (notFound)", !booking.ok && booking.error === "notFound");

  // ── 5. Every centre-wide exclusion, by a read ─────────────────────────
  console.log("\n5. Every centre-wide surface leaves PERSONAL out (decision 9), read by read");
  const relationsA = await resolveCenterRelations(prisma, ownerA.id);
  check(
    "Tenant resolution (hub, switcher, All branches, approvals counts, teacher analytics): A resolves the branch only",
    relationsA.length === 1 && relationsA[0].center.id === branch.id,
  );
  check("A workspace-only teacher resolves no centre relation at all", (await resolveCenterRelations(prisma, ownerB.id)).length === 0);
  const expA = await loadExperiences(prisma, ownerA.id);
  check(
    "listExperiences: no staff or Whole Management entry for a workspace; A's Teacher entry lands on the dashboard",
    expA.every((entry) => entry.centerId !== wsA && entry.kind !== "staff" && entry.kind !== "rollup") &&
      expA.find((entry) => entry.kind === "teacher")?.href === ROUTES.teacherDashboard,
  );
  check("The teacher centre directory (listAccessibleCenters) leaves it out", !(await listAccessibleCenters(prisma)).some((center) => center.id === wsB));
  check("ACCESSIBLE_CENTER reads BRANCH only", (await prisma.center.count({ where: { id: { in: [wsA, wsB] }, ...ACCESSIBLE_CENTER } })) === 0);
  const orgList = await platformOrganizationList(prisma);
  check("Admin organization list leaves personal organizations out", !orgList.some((org) => org.id === centerA.organizationId));
  check("Admin organization page by id does not find a personal organization", (await platformOrganizationById(prisma, centerA.organizationId)) === null);
  check("Admin centre list leaves workspaces out", !(await platformCenterList(prisma)).some((center) => center.id === wsA || center.id === wsB));
  check("Admin centre list of the personal organization is empty", (await platformCenterList(prisma, centerA.organizationId)).length === 0);
  check("Admin centre page by id does not find a workspace", (await platformCenterById(prisma, wsA)) === null);
  const kpisAfter = {
    counts: await platformCenterCounts(prisma),
    teachers: await platformTeacherCount(prisma),
    students: await platformStudentCount(prisma),
    sessions: await platformSessionCount(prisma),
    adoption: JSON.stringify(await platformAdoptionTrend(prisma)),
  };
  check(
    "Platform KPIs and the adoption trend did not move (workspaces, their memberships and sessions counted nowhere)",
    JSON.stringify(kpisAfter.counts) === JSON.stringify(kpisBefore.counts) &&
      kpisAfter.teachers === kpisBefore.teachers && kpisAfter.students === kpisBefore.students &&
      kpisAfter.sessions === kpisBefore.sessions && kpisAfter.adoption === kpisBefore.adoption,
    JSON.stringify({ before: kpisBefore, after: kpisAfter }),
  );
  check("The branch limit lock does not find a personal organization", (await prisma.$transaction((tx) => lockOrganizationBranches(tx, centerA.organizationId))) === null);
  const addToPersonal = await addBranchToOrganization(prisma, {
    organizationId: centerA.organizationId,
    name: "Should not exist",
    slug: `${STEM}-into-personal-${RUN}`,
    themeColor: "#2563EB",
  });
  check("The admin cannot add a branch to a personal organization (organizationNotFound)", !addToPersonal.ok && addToPersonal.error === "organizationNotFound");
  check("COUNTED_BRANCHES counts no workspace", (await prisma.center.count({ where: { organizationId: centerA.organizationId, ...COUNTED_BRANCHES } })) === 0);
  check("The Whole Management roll-up's branch list leaves workspaces out", (await organizationBranches(prisma, centerA.organizationId)).length === 0);
  const seedVerify = read("scripts/seed-verify.ts");
  check(
    "seed:verify's seed world (baseline, orphans, counts) reads BRANCH centres only (static)",
    /center\.kind === "BRANCH"/.test(seedVerify) && /center\.kind === "PERSONAL"/.test(seedVerify) && /ownerUserId: null/.test(seedVerify),
  );

  // ── 6. Isolation ──────────────────────────────────────────────────────
  console.log("\n6. Isolation: two teachers' workspaces, and a workspace against a branch");
  check("B cannot resolve A's workspace (not-found, never forbidden)", (await resolveWorkspaceAccess(prisma, ownerB.id, wsA)) === null);
  check("A resolves A's workspace", (await resolveWorkspaceAccess(prisma, ownerA.id, wsA)) !== null);
  const crossCancel = await cancelWorkspaceSession(prisma, ownerB.id, wsB, listed[0].id);
  check("A's session id under B's own workspace is notFound", !crossCancel.ok && crossCancel.error === "notFound");
  const crossClass = await setWorkspaceClassActive(prisma, ownerB.id, wsB, classId, false, options);
  check("A's class id under B's own workspace is notFound", !crossClass.ok && crossClass.error === "notFound");
  check("B's workspace reads none of A's classes", (await workspaceClasses(prisma, wsB, today)).length === 0);
  const branchClass = await prisma.classGroup.create({
    data: {
      centerId: branch.id,
      teacherId: staff.TEACHER.id,
      startDate: today,
      endDate: addDays(today, 7),
    },
  });
  const branchIntoWs = await setWorkspaceClassActive(prisma, ownerA.id, wsA, branchClass.id, false, options);
  check("A branch's class id under A's workspace is notFound", !branchIntoWs.ok && branchIntoWs.error === "notFound");
  check(
    "A branch's scoped lookup does not find a workspace class, and the reverse",
    (await scopedFindById(prisma.classGroup, branch.id, classId)) === null &&
      (await scopedFindById(prisma.classGroup, wsA, branchClass.id)) === null,
  );

  // ── 7. Owner-only authority, by direct call ───────────────────────────
  console.log("\n7. Owner-only: every other role is refused by direct call (not-found)");
  const others: [string, string][] = [
    ["another premium teacher", ownerB.id],
    ["the branch OWNER", staff.OWNER.id],
    ["the branch MANAGER", staff.MANAGER.id],
    ["the branch RECEPTIONIST", staff.RECEPTIONIST.id],
    ["the branch ACCOUNTANT", staff.ACCOUNTANT.id],
    ["a branch TEACHER", staff.TEACHER.id],
    ["a student", student.id],
    ["A's own assistant (W8d brings assistants in)", assistant.id],
    ["a platform admin acting as a normal user", admin.id],
  ];
  const sessionForAttempts = listed[listed.length - 1];
  for (const [label, actor] of others) {
    const results = [
      await createWorkspaceClass(prisma, actor, wsA, { ...classInput, slots: [slot] }, options),
      await updateWorkspaceClass(prisma, actor, wsA, classId, classInput, options),
      await setWorkspaceClassActive(prisma, actor, wsA, classId, false, options),
      await deleteWorkspaceClass(prisma, actor, wsA, classId),
      await writeWorkspaceClassSlot(prisma, actor, wsA, { kind: "add", classGroupId: classId, slot }, options),
      await createWorkspaceSession(prisma, actor, wsA, { kind: "oneOff", title: "x", price: 0, date: addDays(today, 5), startTime: "08:00", endTime: "09:00" }, options),
      await rescheduleWorkspaceSession(prisma, actor, wsA, sessionForAttempts.id, { date: addDays(today, 6), startTime: "08:00", endTime: "09:00" }, options),
      await cancelWorkspaceSession(prisma, actor, wsA, sessionForAttempts.id),
      await deleteWorkspaceSession(prisma, actor, wsA, sessionForAttempts.id),
      await renameWorkspace(prisma, actor, wsA, "Taken over"),
      await archiveWorkspace(prisma, actor, wsA),
      await unarchiveWorkspace(prisma, actor, wsA),
    ];
    check(
      `${label}: resolves nothing, and all 12 writers answer notFound`,
      (await resolveWorkspaceAccess(prisma, actor, wsA)) === null &&
        results.every((result) => !result.ok && "error" in result && result.error === "notFound"),
      results.map((result) => (result.ok ? "ok" : (result as { error: string }).error)).join(","),
    );
  }
  check(
    "Nothing changed: same name, not archived, the class still active",
    (await prisma.center.findUniqueOrThrow({ where: { id: wsA } })).name === "A Physics" &&
      (await prisma.center.findUniqueOrThrow({ where: { id: wsA } })).archivedAt === null &&
      (await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } })).active,
  );
  await prisma.membership.updateMany({ where: { centerId: wsA, userId: ownerA.id }, data: { active: false } });
  const noMembership = await renameWorkspace(prisma, ownerA.id, wsA, "No membership");
  check("The owner without an ACTIVE TEACHER membership is forbidden", !noMembership.ok && noMembership.error === "forbidden");
  await prisma.membership.updateMany({ where: { centerId: wsA, userId: ownerA.id }, data: { active: true } });
  const accessA = await resolveWorkspaceAccess(prisma, ownerA.id, wsA);
  check(
    "workspaceCan grants the owner exactly the fixed capabilities and nothing else",
    accessA !== null &&
      WORKSPACE_OWNER_CAPABILITIES.every((action) => workspaceCan({ workspace: accessA }, action)) &&
      !workspaceCan({ workspace: accessA }, "payment.record" as never) &&
      !workspaceCan({ workspace: { ...accessA, actorUserId: ownerB.id } }, "workspace.classes.manage"),
  );

  // ── 8. Premium: lapse, archive, unarchive, renewal ────────────────────
  console.log("\n8. Premium: every write but archive needs it; lapse is read-only; renewal restores writes");
  await setPremium(ownerA.id, new Date(Date.now() - 60_000));
  const lapsed = [
    await createWorkspace(prisma, ownerA.id, { name: "Lapsed" }),
    await createWorkspaceClass(prisma, ownerA.id, wsA, { ...classInput, slots: [slot] }, options),
    await updateWorkspaceClass(prisma, ownerA.id, wsA, classId, classInput, options),
    await setWorkspaceClassActive(prisma, ownerA.id, wsA, classId, false, options),
    await deleteWorkspaceClass(prisma, ownerA.id, wsA, classId),
    await writeWorkspaceClassSlot(prisma, ownerA.id, wsA, { kind: "add", classGroupId: classId, slot }, options),
    await createWorkspaceSession(prisma, ownerA.id, wsA, { kind: "extra", classGroupId: classId, date: addDays(today, 5), startTime: "08:00", endTime: "09:00" }, options),
    await rescheduleWorkspaceSession(prisma, ownerA.id, wsA, sessionForAttempts.id, { date: addDays(today, 6), startTime: "08:00", endTime: "09:00" }, options),
    await cancelWorkspaceSession(prisma, ownerA.id, wsA, sessionForAttempts.id),
    await deleteWorkspaceSession(prisma, ownerA.id, wsA, sessionForAttempts.id),
    await renameWorkspace(prisma, ownerA.id, wsA, "Lapsed name"),
  ];
  check(
    "Lapsed: create and every class and session write answer premiumRequired",
    lapsed.every((result) => !result.ok && "error" in result && result.error === "premiumRequired"),
    lapsed.map((result) => (result.ok ? "ok" : (result as { error: string }).error)).join(","),
  );
  check(
    "Lapsed: every read still works (the workspace, its classes, its sessions, the list)",
    (await resolveWorkspaceAccess(prisma, ownerA.id, wsA)) !== null &&
      (await workspaceClasses(prisma, wsA, today)).length === 1 &&
      (await workspaceSessions(prisma, wsA, { from: today })).length > 0 &&
      (await listOwnedWorkspaces(prisma, ownerA.id)).some((entry) => entry.id === wsA),
  );
  const futureBefore = await prisma.session.count({ where: { centerId: wsA, date: { gte: today } } });
  const archived = await archiveWorkspace(prisma, ownerA.id, wsA);
  check("Archive needs no premium (reducing what is active is never gated)", archived.ok, JSON.stringify(archived));
  const classAfterArchive = await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } });
  check(
    "Archive deactivates every class through the R4 path: none left SCHEDULED ahead, the cancelled kept, history kept",
    !classAfterArchive.active &&
      (await prisma.session.count({ where: { centerId: wsA, date: { gte: today }, status: "SCHEDULED", rescheduledToId: null } })) === 0 &&
      (await prisma.session.findUniqueOrThrow({ where: { id: second.id } })).status === "CANCELLED" &&
      (await prisma.session.count({ where: { id: first.id } })) === 1 &&
      futureBefore > 0,
  );
  check(
    "Archive is audited with the classGroup.deactivate rows of the engine",
    (await prisma.auditLog.count({ where: { centerId: wsA, action: "workspace.archive" } })) === 1 &&
      (await prisma.auditLog.count({ where: { centerId: wsA, action: "classGroup.deactivate" } })) === 1,
  );
  const twice = await archiveWorkspace(prisma, ownerA.id, wsA);
  check("Archiving twice is refused (alreadyArchived)", !twice.ok && twice.error === "alreadyArchived");
  const lapsedUnarchive = await unarchiveWorkspace(prisma, ownerA.id, wsA);
  check("Unarchive needs premium", !lapsedUnarchive.ok && lapsedUnarchive.error === "premiumRequired");
  await setPremium(ownerA.id, inDays(30));
  const archivedWrite = await renameWorkspace(prisma, ownerA.id, wsA, "Archived name");
  check("Renewed but archived: writes are refused (workspaceArchived)", !archivedWrite.ok && archivedWrite.error === "workspaceArchived");
  check("An archived workspace frees its slot", (await countActiveWorkspaces(prisma, ownerA.id)) === 1);
  const unarchived = await unarchiveWorkspace(prisma, ownerA.id, wsA);
  check("Renewed and under the cap: unarchive succeeds", unarchived.ok);
  check("Unarchive leaves the class deactivated", !(await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } })).active);
  const renamed = await renameWorkspace(prisma, ownerA.id, wsA, "A Physics 2");
  check("Renewal restores writes", renamed.ok);
  const reactivated = await setWorkspaceClassActive(prisma, ownerA.id, wsA, classId, true, { ...options, confirmConflicts: true });
  check(
    "Reactivating the class recreates its upcoming sessions (the R4 reactivation)",
    reactivated.ok && (await prisma.session.count({ where: { classGroupId: classId, date: { gte: today }, status: "SCHEDULED", rescheduledToId: null } })) > 0,
  );

  // ── 9. The cap: 100 ACTIVE, under the lock, under concurrency ─────────
  console.log("\n9. The cap: at most 100 ACTIVE workspaces, counted under the teacher's lock");
  const orgC = await prisma.organization.create({ data: { name: `${ORG_NAME} C ${RUN}`, ownerUserId: ownerC.id } });
  await prisma.center.createMany({
    data: Array.from({ length: WORKSPACE_ACTIVE_CAP - 1 }, (_, index) => ({
      slug: `${STEM}-cap-${RUN}-${index}`,
      name: `Cap ${index}`,
      kind: "PERSONAL" as const,
      organizationId: orgC.id,
    })),
  });
  check("99 inserted directly", (await countActiveWorkspaces(prisma, ownerC.id)) === WORKSPACE_ACTIVE_CAP - 1);
  const hundredth = await createWorkspace(prisma, ownerC.id, { name: "Hundredth" });
  check("The 100th passes", hundredth.ok);
  const hundredFirst = await createWorkspace(prisma, ownerC.id, { name: "Hundred and first" });
  check(
    "The 101st is refused with the count",
    !hundredFirst.ok && hundredFirst.error === "workspaceCapReached" && "active" in hundredFirst && hundredFirst.active === WORKSPACE_ACTIVE_CAP,
  );
  if (hundredth.ok) {
    const freed = await archiveWorkspace(prisma, ownerC.id, hundredth.workspaceId);
    check("Archiving one frees a slot", freed.ok && (await countActiveWorkspaces(prisma, ownerC.id)) === WORKSPACE_ACTIVE_CAP - 1);
    const race = await Promise.all([
      createWorkspace(prisma, ownerC.id, { name: "Race 1" }),
      createWorkspace(prisma, ownerC.id, { name: "Race 2" }),
    ]);
    check(
      "Two concurrent creations at the limit create exactly one",
      race.filter((result) => result.ok).length === 1 &&
        race.some((result) => !result.ok && result.error === "workspaceCapReached") &&
        (await countActiveWorkspaces(prisma, ownerC.id)) === WORKSPACE_ACTIVE_CAP,
    );
    const atCap = await unarchiveWorkspace(prisma, ownerC.id, hundredth.workspaceId);
    check(
      "Unarchive at the cap is refused with the count",
      !atCap.ok && atCap.error === "workspaceCapReached" && "active" in atCap && atCap.active === WORKSPACE_ACTIVE_CAP,
    );
  }

  // ── 10. The workspace-only teacher's experience and landing ───────────
  console.log("\n10. A workspace-only teacher has a Teacher experience landing on /teacher/workspaces");
  const expB = await loadExperiences(prisma, ownerB.id);
  check(
    "B's experiences: exactly the Teacher entry, landing on /teacher/workspaces",
    expB.length === 1 && expB[0].kind === "teacher" && expB[0].href === ROUTES.teacherWorkspaces,
    expB.map((entry) => `${entry.key}→${entry.href}`).join(", "),
  );
  check("An account with neither a branch nor a workspace has no Teacher entry", !(await loadExperiences(prisma, never.id)).some((entry) => entry.kind === "teacher"));
  await prisma.center.update({ where: { id: wsB }, data: { archivedAt: now, archivedByUserId: ownerB.id } });
  check("An archived workspace still gives the Teacher entry (it is readable)", (await loadExperiences(prisma, ownerB.id)).some((entry) => entry.kind === "teacher"));
  await prisma.center.update({ where: { id: wsB }, data: { archivedAt: null, archivedByUserId: null } });

  // ── 11. Audit: ids only ───────────────────────────────────────────────
  console.log("\n11. Audit rows: ids and amounts only");
  const rows = await prisma.auditLog.findMany({ where: { centerId: { in: [wsA, wsB] } } });
  const actions = new Set(rows.map((entry) => entry.action));
  check(
    "workspace.create, .archive, .unarchive, .rename and the engine's class and session rows are written",
    ["workspace.create", "workspace.archive", "workspace.unarchive", "workspace.rename", "classGroup.create", "session.reschedule", "session.cancel"].every((action) => actions.has(action)),
    [...actions].join(", "),
  );
  check("No workspace audit row carries a name, contact or free text", rows.every((entry) => forbiddenAuditKey(entry.before) === null && forbiddenAuditKey(entry.after) === null));
  check("No workspace audit row is written on behalf of anyone", rows.every((entry) => entry.onBehalfOfUserId === null));

  // ── 12. Statics ───────────────────────────────────────────────────────
  console.log("\n12. Statics");
  const actionsSource = read("app/[locale]/(teacher)/teacher/workspaces/actions.ts");
  const exported = [...actionsSource.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g)];
  check(
    "Every workspace action takes the actor from the session, never a posted user (static)",
    exported.length >= 13 &&
      exported.every(([body]) => /await getCurrentUser\(\)/.test(body) && /user\.id/.test(body)) &&
      !/formData\.get\(["'](userId|actorUserId|teacherId)/.test(actionsSource),
    `${exported.length} actions`,
  );
  check(
    "No workspace action consults the centre matrix or the branch context (static)",
    !/ctxCan\(|getTenantContext\(|requireExperience\(/.test(actionsSource),
  );
  const migrationDir = readdirSync(join(ROOT, "prisma", "migrations")).find((dir) => dir.endsWith("_w8a_personal_workspaces"));
  const migration = migrationDir ? read(`prisma/migrations/${migrationDir}/migration.sql`) : "";
  check(
    "The W8a migration changes no RLS policy and drops nothing (static)",
    migration.length > 0 && !/POLICY|ROW LEVEL SECURITY|DROP\s+(INDEX|TABLE|COLUMN)/i.test(migration),
  );
  check(
    "The one BRANCH_ONLY filter is spread at Explore, ACCESSIBLE_CENTER, the branch limit and the platform console (static)",
    /\.\.\.BRANCH_ONLY/.test(read("lib/db/public-catalog.ts")) &&
      /ACCESSIBLE_CENTER = \{\s*\.\.\.BRANCH_ONLY/.test(read("lib/db/platform.ts")) &&
      /COUNTED_BRANCHES = \{[\s\S]{0,200}\.\.\.BRANCH_ONLY/.test(read("lib/db/platform.ts")) &&
      /PLATFORM_CENTER = \{ deletedAt: null, \.\.\.BRANCH_ONLY \}/.test(read("lib/db/platform.ts")),
  );
  check(
    "The workspace pages resolve their context through getWorkspaceContext, never the branch scope (static)",
    ["page.tsx", "classes/[classId]/page.tsx", "sessions/page.tsx", "settings/page.tsx", "layout.tsx"].every((file) => {
      const source = read(`app/[locale]/(teacher)/teacher/workspaces/[id]/${file}`);
      return /getWorkspaceContext\(id\)/.test(source) && /notFound\(\)/.test(source) && !/getTeacherScope|getTenantContext\(/.test(source);
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => {
      console.error(error);
      failures += 1;
    });
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} workspaces check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll workspaces checks passed.");
  });
