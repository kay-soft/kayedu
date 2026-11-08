/**
 * `npm run check:workspaces` (W8a, D-W20, D-W21, D-W28, D-W38) — PERSONAL
 * workspaces: creation and its baseline, owner-only authority, premium on
 * every write but archive, the 100-ACTIVE cap under the lock (and under
 * concurrency), archive and unarchive, the forced 0 cut and the offered pairs,
 * Discover / Explore / reservations / bookings, every centre-wide exclusion
 * by a read, isolation, ids-only audit, the workspace-only teacher's
 * experience, and the statics.
 *
 * W8b (D-W27, D-W39), section 13: adding students by phone with one answer
 * and one audit shape whether or not an account matched, the `User.phone`-only
 * match, invitations (one PENDING per profile, "Invite again", cancel,
 * decline, accept with the placeholder's removal), enrolment, what a linked
 * student reads, the session producers and the re-check, leave, premium and
 * archive refusals, the rate limits, isolation, and the statics.
 *
 * Writes and cleans up its own fixtures (users `workspaces-check-…`, the
 * branch and catalogue rows `workspaces-check-…`, every centre under the
 * fixture users' personal organizations, and — W8b — the placeholder users
 * behind unlinked workspace students, which carry no email: their surname
 * starts `workspaces-check`). Fenced by S1 (`gatePrisma`): staging
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
import { visibleWhere } from "../lib/db/notifications.ts";
import { leaveClass } from "../lib/db/reservations.ts";
import { studentCalendarMonth, studentPastAttendance, studentUpcomingSessions } from "../lib/db/student-portal.ts";
import {
  INVITE_AGAIN_WINDOW_MS,
  acceptWorkspaceInvitation,
  addWorkspaceStudent,
  cancelWorkspaceInvitation,
  copyWorkspaceStudent,
  copyableWorkspaceStudents,
  declineWorkspaceInvitation,
  enrolWorkspaceStudent,
  hasWorkspaceStudentProfile,
  inviteWorkspaceStudentAgain,
  listWorkspaceStudents,
  pendingInvitationCenterIds,
  pendingWorkspaceInvitations,
  removeWorkspaceEnrollment,
  studentWorkspaceProfiles,
  workspaceClassRoster,
} from "../lib/db/workspace-students.ts";
import { RATE_LIMITS } from "../lib/rate-limit.ts";

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
  // W8b: placeholders (no email, no login), once their workspace profiles went with the centres.
  await prisma.user.deleteMany({
    where: { email: null, authId: null, lastName: { startsWith: STEM }, studentProfiles: { none: {} }, memberships: { none: {} } },
  });
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

  await workspaceStudents({
    now,
    today,
    branchId: branch.id,
    wsA,
    wsB,
    secondA: secondA.ok ? secondA.workspaceId : "",
    classId,
    classInput,
    slot,
    options,
    ownerA,
    ownerB,
    student,
    others,
  });
}

// ── 13. W8b: workspace students and invitations (D-W27, D-W39) ─────────────

type FixtureUser = Awaited<ReturnType<typeof makeUser>>;

/** A fresh, run-unique Egyptian mobile in the stored E.164 form (`+2010` + 8 digits). */
function freshPhone(): string {
  return `+2010${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
}

/** The typed-name stem the cleanup finds placeholders by. */
const PLACEHOLDER = (tag: string) => ({ firstName: "Typed", lastName: `${STEM}-${tag}-${RUN}` });

async function addAuditShape(centerId: string, profileId: string) {
  const row = await prisma.auditLog.findFirst({ where: { centerId, entityType: "StudentProfile", entityId: profileId, action: "workspace.student.add" } });
  return row ? JSON.stringify({ action: row.action, entityType: row.entityType, before: row.before, afterKeys: Object.keys((row.after ?? {}) as object).sort(), actor: row.actorUserId, onBehalf: row.onBehalfOfUserId }) : "missing";
}

async function workspaceStudents(fx: {
  now: Date;
  today: Date;
  branchId: string;
  wsA: string;
  wsB: string;
  secondA: string;
  classId: string;
  classInput: { educationSystemId: null; gradeId: string; subjectId: string; price: number; lateThresholdMinutes: number; startDate: Date; endDate: Date };
  slot: { dayOfWeek: number; startTime: string; endTime: string };
  options: { confirmConflicts: boolean; locale: string };
  ownerA: FixtureUser;
  ownerB: FixtureUser;
  student: FixtureUser;
  others: [string, string][];
}) {
  const { today, wsA, wsB, secondA, classId, ownerA, ownerB, student } = fx;
  console.log("\n13. W8b: workspace students, invitations, enrolment and the student's reads");

  // Accounts: a student with a login and a staff-typed User.phone (a branch
  // student, too); one whose number is only a self-declared contactPhone; a
  // login-less person holding a User.phone; another tenant's local profile phone.
  const P1 = freshPhone();
  const P2 = freshPhone();
  const P3 = freshPhone();
  const P4 = freshPhone();
  const P5 = freshPhone();
  const P6 = freshPhone();
  await prisma.user.update({
    where: { id: student.id },
    data: { phone: P1, authId: `${STEM}-auth-student-${RUN}`, firstName: "RealFirst", lastName: `RealLast${RUN}` },
  });
  const contactOnly = await makeUser("contact-only");
  await prisma.user.update({ where: { id: contactOnly.id }, data: { contactPhone: P2, authId: `${STEM}-auth-contact-${RUN}` } });
  const noLogin = await makeUser("no-login");
  await prisma.user.update({ where: { id: noLogin.id }, data: { phone: P3 } });
  const tenantLocal = await makeUser("tenant-local");
  await prisma.user.update({ where: { id: tenantLocal.id }, data: { authId: `${STEM}-auth-tenant-${RUN}` } });
  await prisma.studentProfile.create({ data: { userId: tenantLocal.id, centerId: fx.branchId, studentCode: `${STEM}-tl-${RUN}`, phone: P4 } });
  const second = await makeUser("student-two");
  await prisma.user.update({ where: { id: second.id }, data: { phone: P6, authId: `${STEM}-auth-two-${RUN}` } });

  // ── 13a. One answer, one audit shape ───────────────────────────────────
  // A warm-up add first, so the informational timing below compares like with
  // like (the first add pays for this teacher's rate-limit row and the
  // workspace's code counter).
  await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("warm"), phone: freshPhone(), gradeId: null });
  const t0 = Date.now();
  const matched = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p1"), phone: P1, gradeId: fx.classInput.gradeId });
  const t1 = Date.now();
  const unmatched = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p5"), phone: P5, gradeId: fx.classInput.gradeId });
  const t2 = Date.now();
  check("Adding by phone succeeds with or without a matching account", matched.ok && unmatched.ok, JSON.stringify({ matched, unmatched }));
  if (!matched.ok || !unmatched.ok) return;
  check(
    "The answer has the same shape either way ({ ok, studentProfileId } — nothing about a match)",
    JSON.stringify(Object.keys(matched).sort()) === JSON.stringify(Object.keys(unmatched).sort()),
  );
  check(
    "The audit row has the same shape either way (workspace.student.add, ids only)",
    (await addAuditShape(wsA, matched.studentProfileId)) === (await addAuditShape(wsA, unmatched.studentProfileId)),
  );
  console.log(`        (timing, informational: matched ${t1 - t0} ms, unmatched ${t2 - t1} ms)`);
  const p1Profile = matched.studentProfileId;
  const p5Profile = unmatched.studentProfileId;
  const pendingFor = (profileId: string) => prisma.workspaceInvitation.findMany({ where: { studentProfileId: profileId, status: "PENDING" } });
  const p1Pending = await pendingFor(p1Profile);
  check("A match writes one PENDING invitation, addressed to the account", p1Pending.length === 1 && p1Pending[0].targetUserId === student.id && p1Pending[0].centerId === wsA);
  check("No match writes no invitation", (await prisma.workspaceInvitation.count({ where: { studentProfileId: p5Profile } })) === 0);
  const notice = await prisma.notification.findMany({ where: { userId: student.id, kind: "WORKSPACE_INVITATION" } });
  check(
    "The match also writes one WORKSPACE_INVITATION notice, ids only ({ invitationId }), on the workspace",
    notice.length === 1 && notice[0].centerId === wsA && JSON.stringify(notice[0].payload) === JSON.stringify({ invitationId: p1Pending[0].id }),
  );
  const placeholders = await prisma.studentProfile.findMany({ where: { id: { in: [p1Profile, p5Profile] } }, include: { user: true } });
  check(
    "Both profiles sit on a placeholder with no login and no global contact (User.phone never set, D-W39 item 2)",
    placeholders.length === 2 && placeholders.every((row) => row.user.authId === null && row.user.email === null && row.user.phone === null && row.user.id !== student.id),
  );
  check("The profile keeps the typed phone and grade as its local record", placeholders.every((row) => row.phone !== null && row.gradeId === fx.classInput.gradeId && row.profileCompletedAt !== null));

  // ── 13b. Only User.phone of an account with a login matches ────────────
  const viaContact = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p2"), phone: P2, gradeId: null });
  const viaNoLogin = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p3"), phone: P3, gradeId: null });
  const viaTenant = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p4"), phone: P4, gradeId: null });
  check("contactPhone, a login-less User.phone and another tenant's profile phone are added too", viaContact.ok && viaNoLogin.ok && viaTenant.ok);
  check(
    "…and none of them invites anyone (User.phone of an account with a login only)",
    (await prisma.workspaceInvitation.count({ where: { targetUserId: { in: [contactOnly.id, noLogin.id, tenantLocal.id] } } })) === 0 &&
      (await prisma.workspaceInvitation.count({ where: { centerId: wsA } })) === 1,
  );

  // ── 13c. The teacher's reads never carry the account ───────────────────
  const listed = await listWorkspaceStudents(prisma, wsA);
  const listedJson = JSON.stringify(listed);
  check(
    "The teacher's list carries neither the account's id, email nor real name — only Linked / Not linked",
    !listedJson.includes(student.id) && !listedJson.includes(student.email ?? "@@") && !listedJson.includes(`RealLast${RUN}`) &&
      listed.every((row) => row.linked === false) && !("userId" in (listed[0] ?? {})),
  );
  check("The add's result carries none of them either", !JSON.stringify(matched).includes(student.id));

  // ── 13d. Duplicates and the partial index ──────────────────────────────
  const duplicate = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("dup"), phone: P5, gradeId: null });
  check("A duplicate phone in the same workspace is refused (duplicatePhone)", !duplicate.ok && duplicate.error === "duplicatePhone");
  let indexRefused = false;
  try {
    await prisma.workspaceInvitation.create({ data: { centerId: wsA, studentProfileId: p1Profile, targetUserId: student.id } });
  } catch {
    indexRefused = true;
  }
  check("A second PENDING invitation for one profile is refused by the partial unique index", indexRefused);
  const [index] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'WorkspaceInvitation_one_pending_per_profile' AND indexdef ILIKE '%WHERE%PENDING%'`;
  check("The hand-written partial index exists (CLAUDE.md rule 7)", Number(index?.count ?? 0) === 1);
  const [rls] = await prisma.$queryRaw<{ on: boolean }[]>`
    SELECT c.relrowsecurity AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'WorkspaceInvitation'`;
  check("RLS is on for WorkspaceInvitation", rls?.on === true);

  // ── 13e. Invite again: the window, the answer, one pending ─────────────
  const soonMatched = await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p1Profile);
  const soonUnmatched = await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p5Profile);
  check(
    "Invite again within 24 hours of the add is refused the same way either way (inviteTooSoon)",
    !soonMatched.ok && soonMatched.error === "inviteTooSoon" && !soonUnmatched.ok && soonUnmatched.error === "inviteTooSoon",
  );
  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const againMatched = await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p1Profile, later(25));
  const againUnmatched = await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p5Profile, later(25));
  check("After the window it answers { ok: true } either way", againMatched.ok && againUnmatched.ok && JSON.stringify(againMatched) === JSON.stringify(againUnmatched));
  const afterAgain = await prisma.workspaceInvitation.findMany({ where: { studentProfileId: p1Profile }, orderBy: { createdAt: "asc" } });
  check(
    "It cancelled the older pending one and wrote a new one: one PENDING per profile",
    afterAgain.length === 2 && afterAgain[0].status === "CANCELLED" && afterAgain[1].status === "PENDING",
  );
  check("…and still nothing for the unmatched profile", (await prisma.workspaceInvitation.count({ where: { studentProfileId: p5Profile } })) === 0);
  const inviteRows = await prisma.auditLog.findMany({ where: { centerId: wsA, action: "workspace.student.invite", entityId: { in: [p1Profile, p5Profile] } } });
  check(
    "Invite again's audit rows have one shape either way",
    inviteRows.length === 2 && new Set(inviteRows.map((row) => JSON.stringify([row.before, row.after]))).size === 1,
  );
  check(`The window is ${INVITE_AGAIN_WINDOW_MS / 3_600_000} hours`, INVITE_AGAIN_WINDOW_MS === 24 * 3_600_000);

  // ── 13f. The notice's re-check; cancel; decline ────────────────────────
  const reachFor = async (userId: string, workspaceCenterIds: string[] = []) => ({
    relationCenterIds: (await resolveCenterRelations(prisma, userId)).map((relation) => relation.center.id),
    workspaceCenterIds,
    invitationCenterIds: await pendingInvitationCenterIds(prisma, userId),
  });
  const visibleInvitationNotices = async (userId: string) =>
    prisma.notification.count({ where: { AND: [visibleWhere(userId, await reachFor(userId)), { kind: "WORKSPACE_INVITATION" }] } });
  check("A pending invitation's notice is visible to its account", (await visibleInvitationNotices(student.id)) >= 1);
  const hubCards = await pendingWorkspaceInvitations(prisma, student.id);
  check(
    "The hub card: the workspace's name and the teacher's, and no other field",
    hubCards.length === 1 && hubCards[0].workspaceName.length > 0 && hubCards[0].teacherName === `${ownerA.firstName} ${ownerA.lastName}` &&
      JSON.stringify(Object.keys(hubCards[0]).sort()) === JSON.stringify(["createdAt", "id", "teacherName", "workspaceName"]),
  );
  const cancelMatched = await cancelWorkspaceInvitation(prisma, ownerA.id, wsA, p1Profile);
  const cancelUnmatched = await cancelWorkspaceInvitation(prisma, ownerA.id, wsA, p5Profile);
  check("Cancel invitation answers { ok: true } either way", cancelMatched.ok && cancelUnmatched.ok);
  check("The teacher's cancel sets CANCELLED", (await pendingFor(p1Profile)).length === 0);
  check("A cancelled invitation's notice is hidden, not deleted", (await visibleInvitationNotices(student.id)) === 0 && (await prisma.notification.count({ where: { userId: student.id, kind: "WORKSPACE_INVITATION" } })) === 2);
  await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p1Profile, later(50));
  const toDecline = (await pendingFor(p1Profile))[0];
  const wrongDecline = await declineWorkspaceInvitation(prisma, ownerB.id, toDecline.id);
  check("Another account cannot decline it (notFound)", !wrongDecline.ok && wrongDecline.error === "notFound");
  const declined = await declineWorkspaceInvitation(prisma, student.id, toDecline.id);
  check(
    "Decline sets DECLINED; the profile stays on its placeholder and reads Not linked",
    declined.ok &&
      (await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id: toDecline.id } })).status === "DECLINED" &&
      (await listWorkspaceStudents(prisma, wsA)).find((row) => row.id === p1Profile)?.linked === false,
  );

  // ── 13g. Enrolment ─────────────────────────────────────────────────────
  const class2 = await createWorkspaceClass(prisma, ownerA.id, wsA, { ...fx.classInput, slots: [{ ...fx.slot, startTime: "08:00", endTime: "09:00" }] }, { ...fx.options, confirmConflicts: true });
  check("A second workspace class (for the unenrolled check)", class2.ok);
  const enrolled = await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, p1Profile);
  const enrolledUnmatched = await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, p5Profile);
  check("The owner enrols the workspace's own profiles (no approval, no seat cap)", enrolled.ok && enrolledUnmatched.ok);
  const twiceEnrolled = await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, p1Profile);
  check("Enrolling twice is refused (alreadyEnrolled)", !twiceEnrolled.ok && twiceEnrolled.error === "alreadyEnrolled");
  const bStudent = await addWorkspaceStudent(prisma, ownerB.id, wsB, { ...PLACEHOLDER("b"), phone: freshPhone(), gradeId: null });
  const crossProfile = bStudent.ok ? await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, bStudent.studentProfileId) : { ok: false as const, error: "setup" };
  check("A profile of another workspace cannot be enrolled (notFound)", !crossProfile.ok && crossProfile.error === "notFound");
  const crossClass = await enrolWorkspaceStudent(prisma, ownerB.id, wsB, classId, bStudent.ok ? bStudent.studentProfileId : "");
  check("A class of another workspace cannot be used (notFound)", !crossClass.ok && crossClass.error === "notFound");
  const roster = await workspaceClassRoster(prisma, wsA, classId);
  check("The roster lists both, Not linked", roster.roster.length === 2 && roster.roster.every((row) => !row.student.linked));

  // ── 13h. Before accepting, the account sees nothing of the workspace ───
  check("Before accepting, the account holds no workspace profile", (await studentWorkspaceProfiles(prisma, student.id)).length === 0);

  // ── 13i. Accept: atomic, the placeholder removed only when empty ───────
  await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p1Profile, later(75));
  const toAccept = (await pendingFor(p1Profile))[0];
  const placeholderId = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: p1Profile } })).userId;
  check("Another account cannot accept it (notFound)", !(await acceptWorkspaceInvitation(prisma, ownerB.id, toAccept.id)).ok);
  const accepted = await acceptWorkspaceInvitation(prisma, student.id, toAccept.id);
  check("Accept succeeds", accepted.ok, JSON.stringify(accepted));
  const linkedProfile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: p1Profile } });
  check(
    "The profile moved to the account; the invitation is ACCEPTED; the placeholder (holding nothing else) is gone",
    linkedProfile.userId === student.id &&
      (await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id: toAccept.id } })).status === "ACCEPTED" &&
      (await prisma.user.count({ where: { id: placeholderId } })) === 0 &&
      accepted.ok && accepted.placeholderRemoved,
  );
  check(
    "The local record is untouched (the teacher-typed name and phone stay)",
    linkedProfile.lastName === PLACEHOLDER("p1").lastName && linkedProfile.phone === P1,
  );
  check(
    "The enrolment moved with the profile",
    (await prisma.enrollment.count({ where: { studentProfileId: p1Profile, classGroupId: classId, status: "ACTIVE" } })) === 1,
  );
  const acceptRow = await prisma.auditLog.findFirst({ where: { centerId: wsA, action: "workspace.invitation.accept", entityId: toAccept.id } });
  check("Accept is audited, ids only, with the student as actor", acceptRow !== null && acceptRow.actorUserId === student.id && forbiddenAuditKey(acceptRow.after) === null);
  check("Accepting twice is notFound", !(await acceptWorkspaceInvitation(prisma, student.id, toAccept.id)).ok);
  check("The teacher now reads Linked, still without the account", (await listWorkspaceStudents(prisma, wsA)).find((row) => row.id === p1Profile)?.linked === true && !JSON.stringify(await listWorkspaceStudents(prisma, wsA)).includes(student.id));

  // A placeholder holding another relation stays; an account already here is refused.
  const p6 = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("p6"), phone: P6, gradeId: null });
  if (p6.ok) {
    const p6Placeholder = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: p6.studentProfileId } })).userId;
    await prisma.studentProfile.create({ data: { userId: p6Placeholder, centerId: secondA, studentCode: `${STEM}-p6-${RUN}` } });
    const p6Invitation = (await pendingFor(p6.studentProfileId))[0];
    const p6Accepted = p6Invitation ? await acceptWorkspaceInvitation(prisma, second.id, p6Invitation.id) : null;
    check(
      "A placeholder that holds another relation is kept (placeholderRemoved false)",
      p6Accepted?.ok === true && !p6Accepted.placeholderRemoved && (await prisma.user.count({ where: { id: p6Placeholder } })) === 1,
    );
  } else check("Setup: a second matched profile", false, JSON.stringify(p6));
  const strayInvitation = await prisma.workspaceInvitation.create({ data: { centerId: wsA, studentProfileId: p5Profile, targetUserId: student.id } });
  const refusedHere = await acceptWorkspaceInvitation(prisma, student.id, strayInvitation.id);
  check(
    "An account already holding a profile in the workspace is refused (alreadyInWorkspace), and nothing moves",
    !refusedHere.ok && refusedHere.error === "alreadyInWorkspace" &&
      (await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id: strayInvitation.id } })).status === "PENDING" &&
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: p5Profile } })).userId !== student.id,
  );
  await prisma.workspaceInvitation.update({ where: { id: strayInvitation.id }, data: { status: "CANCELLED" } });

  // ── 13j. What the linked student reads ─────────────────────────────────
  const profiles = await studentWorkspaceProfiles(prisma, student.id);
  check("The opt-in resolver's input: exactly the linked workspace profile", profiles.length === 1 && profiles[0].centerId === wsA);
  const upcoming = await studentUpcomingSessions(prisma, wsA, p1Profile, today);
  check(
    "Schedule: the enrolled workspace class's sessions, and none of the unenrolled class",
    upcoming.length > 0 && upcoming.every((session) => session.classGroupId === classId),
  );
  const month = await studentCalendarMonth(prisma, wsA, p1Profile, { start: today, end: addDays(today, 30) }, today);
  check("Calendar: the same class only", month.length > 0 && month.every((entry) => entry.classGroupId === classId));
  check("History: readable (no check-in before W8c, so empty)", Array.isArray(await studentPastAttendance(prisma, wsA, p1Profile, addDays(today, 31))));
  check("Another teacher's workspace holds nothing for this student", (await prisma.studentProfile.count({ where: { userId: student.id, centerId: wsB } })) === 0);
  check("Discover still leaves the workspace out", !(await listAccessibleCenters(prisma)).some((center) => center.id === wsA));
  const relations = await resolveCenterRelations(prisma, student.id);
  check("A branch student is unaffected: their relations are the branch only", relations.length === 1 && relations[0].center.id === fx.branchId);
  const studentEntries = (await loadExperiences(prisma, student.id)).filter((entry) => entry.kind === "student");
  check("One Student experience (branch + workspace)", studentEntries.length === 1 && studentEntries[0].href === ROUTES.studentSchedule);
  const workspaceOnly = await loadExperiences(prisma, second.id);
  check(
    "A student with only workspace profiles has the Student experience, landing on the schedule",
    (await hasWorkspaceStudentProfile(prisma, second.id)) && workspaceOnly.length === 1 && workspaceOnly[0].kind === "student" && workspaceOnly[0].href === ROUTES.studentSchedule,
    workspaceOnly.map((entry) => entry.key).join(","),
  );
  check("An unlinked profile reaches no one: its placeholder has no login", (await prisma.studentProfile.findUniqueOrThrow({ where: { id: p5Profile }, include: { user: true } })).user.authId === null);

  // ── 13k. Producers and the re-check ────────────────────────────────────
  // Only sessions after today: none of them can have started.
  const [toCancel, toMove] = upcoming.filter((session) => session.date.getTime() > today.getTime());
  if (toCancel && toMove) {
    await cancelWorkspaceSession(prisma, ownerA.id, wsA, toCancel.id);
    await rescheduleWorkspaceSession(prisma, ownerA.id, wsA, toMove.id, { date: addDays(toMove.date, 1), startTime: "20:00", endTime: "21:00" }, { ...fx.options, confirmConflicts: true });
    const sessionNotices = await prisma.notification.findMany({ where: { userId: student.id, centerId: wsA, kind: { in: ["SESSION_CANCELLED", "SESSION_RESCHEDULED"] } } });
    check("Cancel and reschedule notify the linked enrolled student", new Set(sessionNotices.map((row) => row.kind)).size === 2);
    const visible = async (workspaceCenterIds: string[]) =>
      prisma.notification.count({ where: { AND: [visibleWhere(student.id, await reachFor(student.id, workspaceCenterIds)), { centerId: wsA, kind: { in: ["SESSION_CANCELLED", "SESSION_RESCHEDULED"] } }] } });
    check("They are visible through the linked workspace profile, and hidden without it", (await visible([wsA])) === 2 && (await visible([])) === 0);
    await prisma.studentProfile.update({ where: { id: p1Profile }, data: { active: false } });
    const deactivatedReach = (await studentWorkspaceProfiles(prisma, student.id)).map((row) => row.centerId);
    check("A deactivated profile drops out of the reach, so its notices hide", !deactivatedReach.includes(wsA) && (await visible(deactivatedReach)) === 0);
    await prisma.studentProfile.update({ where: { id: p1Profile }, data: { active: true } });
  } else check("Setup: two upcoming sessions to cancel and move", false, `${upcoming.length}`);

  // ── 13l. Leave (U8) ────────────────────────────────────────────────────
  const left = await prisma.$transaction((tx) => leaveClass(tx, { centerId: wsA, classGroupId: classId, studentUserId: student.id }));
  check(
    "The student leaves the workspace class (U8); its sessions leave their schedule",
    left.ok && (await studentUpcomingSessions(prisma, wsA, p1Profile, today)).length === 0,
  );

  // ── 13m. Copy from another workspace ───────────────────────────────────
  const copyable = await copyableWorkspaceStudents(prisma, ownerA.id, secondA);
  check("The copy picker lists A's own profiles from A's other workspaces only", copyable.length >= 1 && copyable.every((group) => group.workspaceId !== wsB && group.workspaceId !== secondA));
  const copied = await copyWorkspaceStudent(prisma, ownerA.id, secondA, { workspaceId: wsA, studentProfileId: p5Profile });
  const copiedRow = copied.ok ? await prisma.studentProfile.findUniqueOrThrow({ where: { id: copied.studentProfileId } }) : null;
  check(
    "Copy creates a fresh profile there with the name, phone and grade copied, on a new placeholder",
    copiedRow !== null && copiedRow.centerId === secondA && copiedRow.phone === P5 && copiedRow.gradeId === fx.classInput.gradeId &&
      copiedRow.lastName === PLACEHOLDER("p5").lastName && copiedRow.id !== p5Profile,
  );
  const copiedByB = await copyWorkspaceStudent(prisma, ownerB.id, wsB, { workspaceId: wsA, studentProfileId: p5Profile });
  check("Another teacher cannot copy from A's workspace (notFound)", !copiedByB.ok && copiedByB.error === "notFound");
  check("B's picker never lists A's students", (await copyableWorkspaceStudents(prisma, ownerB.id, wsB)).every((group) => group.workspaceId !== wsA));

  // ── 13n. Isolation and every other role, by direct call ────────────────
  const intoA = await addWorkspaceStudent(prisma, ownerB.id, wsA, { ...PLACEHOLDER("x"), phone: freshPhone(), gradeId: null });
  check("B cannot add to A's workspace (notFound)", !intoA.ok && intoA.error === "notFound");
  for (const [label, actor] of fx.others) {
    const results = [
      await addWorkspaceStudent(prisma, actor, wsA, { ...PLACEHOLDER("o"), phone: freshPhone(), gradeId: null }),
      await copyWorkspaceStudent(prisma, actor, wsA, { workspaceId: secondA, studentProfileId: p5Profile }),
      await inviteWorkspaceStudentAgain(prisma, actor, wsA, p5Profile, later(100)),
      await cancelWorkspaceInvitation(prisma, actor, wsA, p5Profile),
      await enrolWorkspaceStudent(prisma, actor, wsA, classId, p5Profile),
      await removeWorkspaceEnrollment(prisma, actor, wsA, "00000000-0000-0000-0000-000000000000"),
    ];
    check(
      `${label}: all 6 W8b writers answer notFound`,
      results.every((result) => !result.ok && result.error === "notFound"),
      results.map((result) => (result.ok ? "ok" : result.error)).join(","),
    );
  }

  // ── 13o. Premium lapse and archive: reads stay, writes refused ─────────
  const enrolmentForRemove = await prisma.enrollment.findFirstOrThrow({ where: { studentProfileId: p5Profile, classGroupId: classId } });
  await setPremium(ownerA.id, new Date(Date.now() - 60_000));
  const lapsedWrites = [
    await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("l"), phone: freshPhone(), gradeId: null }),
    await inviteWorkspaceStudentAgain(prisma, ownerA.id, wsA, p5Profile, later(125)),
    await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, p1Profile),
    await removeWorkspaceEnrollment(prisma, ownerA.id, wsA, enrolmentForRemove.id),
  ];
  check(
    "Lapsed: add, invite again, enrol and remove answer premiumRequired",
    lapsedWrites.every((result) => !result.ok && result.error === "premiumRequired"),
    lapsedWrites.map((result) => (result.ok ? "ok" : result.error)).join(","),
  );
  check("Lapsed: cancel invitation still works (it only withdraws)", (await cancelWorkspaceInvitation(prisma, ownerA.id, wsA, p5Profile)).ok);
  check("Lapsed: the teacher's list and the linked student's reads continue", (await listWorkspaceStudents(prisma, wsA)).length > 0 && (await studentWorkspaceProfiles(prisma, student.id)).length === 1);
  await setPremium(ownerA.id, inDays(30));
  const removed = await removeWorkspaceEnrollment(prisma, ownerA.id, wsA, enrolmentForRemove.id);
  check("Renewed: remove from a class works (REMOVED)", removed.ok && (await prisma.enrollment.findUniqueOrThrow({ where: { id: enrolmentForRemove.id } })).status === "REMOVED");
  await prisma.center.update({ where: { id: wsA }, data: { archivedAt: new Date(), archivedByUserId: ownerA.id } });
  const archivedAdd = await addWorkspaceStudent(prisma, ownerA.id, wsA, { ...PLACEHOLDER("ar"), phone: freshPhone(), gradeId: null });
  const archivedEnrol = await enrolWorkspaceStudent(prisma, ownerA.id, wsA, classId, p5Profile);
  check("Archived: add and enrol answer workspaceArchived", !archivedAdd.ok && archivedAdd.error === "workspaceArchived" && !archivedEnrol.ok && archivedEnrol.error === "workspaceArchived");
  check("Archived: the linked student still reads the workspace (history is not hidden)", (await studentWorkspaceProfiles(prisma, student.id)).length === 1);
  await prisma.center.update({ where: { id: wsA }, data: { archivedAt: null, archivedByUserId: null } });

  // ── 13p. Rate limits (the existing limiter) ────────────────────────────
  const limiter = await makeUser("limits", { premium: true });
  const limitWs = await createWorkspace(prisma, limiter.id, { name: "Limits" });
  if (limitWs.ok) {
    const hourBefore = Math.floor(Date.now() / RATE_LIMITS.workspaceStudentAddPerUser.windowMs);
    let added = 0;
    let firstRefusal: string | null = null;
    let firstProfile = "";
    for (let index = 0; index < RATE_LIMITS.workspaceStudentAddPerUser.limit + 1; index += 1) {
      const result = await addWorkspaceStudent(prisma, limiter.id, limitWs.workspaceId, { ...PLACEHOLDER(`lim${index}`), phone: freshPhone(), gradeId: null });
      if (result.ok) {
        added += 1;
        firstProfile ||= result.studentProfileId;
      } else {
        firstRefusal ??= result.error;
      }
    }
    const crossed = Math.floor(Date.now() / RATE_LIMITS.workspaceStudentAddPerUser.windowMs) !== hourBefore;
    check(
      "60 adds an hour per teacher, the 61st rateLimited",
      crossed || (added === 60 && firstRefusal === "rateLimited"),
      crossed ? "the hour turned mid-run; not judged" : `${added} added, then ${firstRefusal}`,
    );
    const dayBefore = Math.floor(Date.now() / RATE_LIMITS.workspaceInvitePerUser.windowMs);
    let invited = 0;
    let inviteRefusal: string | null = null;
    for (let index = 0; index < RATE_LIMITS.workspaceInvitePerUser.limit + 1; index += 1) {
      const result = await inviteWorkspaceStudentAgain(prisma, limiter.id, limitWs.workspaceId, firstProfile, later(25 + index));
      if (result.ok) invited += 1;
      else inviteRefusal ??= result.error;
    }
    const dayCrossed = Math.floor(Date.now() / RATE_LIMITS.workspaceInvitePerUser.windowMs) !== dayBefore;
    check(
      "20 invitations a day per teacher, the 21st rateLimited (counted whether or not anyone matched)",
      dayCrossed || (invited === 20 && inviteRefusal === "rateLimited"),
      dayCrossed ? "the day turned mid-run; not judged" : `${invited} invited, then ${inviteRefusal}`,
    );
  } else check("Setup: the limits workspace", false, JSON.stringify(limitWs));

  // ── 13q. Audit and statics ─────────────────────────────────────────────
  const w8bRows = await prisma.auditLog.findMany({ where: { action: { startsWith: "workspace.student." } } });
  const invitationRows = await prisma.auditLog.findMany({ where: { centerId: wsA, action: { startsWith: "workspace.invitation." } } });
  check(
    "Every W8b audit row is ids only and on behalf of no one",
    [...w8bRows, ...invitationRows].every((row) => forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null && row.onBehalfOfUserId === null),
  );
  const studentActions = read("app/[locale]/(teacher)/teacher/workspaces/student-actions.ts");
  const invitationActions = read("app/[locale]/(auth)/workspace-invitation-actions.ts");
  const exported = [...studentActions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g), ...invitationActions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g)];
  check(
    "Every W8b action takes the actor from the session, never a posted user, and consults no centre matrix (static)",
    exported.length === 8 &&
      exported.every(([body]) => /await getCurrentUser\(\)/.test(body) && /user\.id/.test(body)) &&
      !/formData\.get\(["'](userId|actorUserId|teacherId|targetUserId)/.test(studentActions + invitationActions) &&
      !/ctxCan\(|getTenantContext\(|requireExperience\(/.test(studentActions + invitationActions),
    `${exported.length} actions`,
  );
  const studentsModule = read("lib/db/workspace-students.ts");
  check(
    "The match reads User.phone of an account with a login, never contactPhone, in the one statement every add runs (static)",
    /u\."phone" = \$\{phone\} AND u\."authId" IS NOT NULL/.test(studentsModule) && !/contactPhone/i.test(studentsModule.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")) &&
      (studentsModule.match(/await inviteIfMatched\(/g) ?? []).length === 2,
  );
  check("The placeholder writes no global contact (static)", /email: null, phone: null, altPhone: null/.test(read("lib/db/identity.ts")));
  check(
    "The students page resolves its own context (static)",
    /getWorkspaceContext\(id\)/.test(read("app/[locale]/(teacher)/teacher/workspaces/[id]/students/page.tsx")),
  );
  const scheduleUsers = ["app/[locale]/(student)/student/schedule/page.tsx", "app/[locale]/(student)/student/calendar/page.tsx"];
  check(
    "The opt-in student resolver is used by the schedule and the calendar; assessments keep the branch-only one (static)",
    scheduleUsers.every((file) => /getStudentScheduleContexts\(/.test(read(file))) &&
      /getStudentContexts\(/.test(read("app/[locale]/(student)/student/assessments/scope.ts")) &&
      !/getStudentScheduleContexts/.test(read("app/[locale]/(student)/student/assessments/scope.ts")),
  );
  check(
    "The hub stays open while an invitation is pending (static)",
    /experiences\.length === 1 && switchMode !== "1" && invitations\.length === 0/.test(read("app/[locale]/(auth)/select-center/page.tsx")),
  );
  const w8bDir = readdirSync(join(ROOT, "prisma", "migrations")).find((dir) => dir.endsWith("_w8b_workspace_invitations"));
  const w8bMigration = w8bDir ? read(`prisma/migrations/${w8bDir}/migration.sql`) : "";
  check(
    "The W8b migration is additive: RLS on, the partial index, no DROP (static)",
    /ENABLE ROW LEVEL SECURITY/.test(w8bMigration) && /WorkspaceInvitation_one_pending_per_profile/.test(w8bMigration) &&
      !/^\s*DROP\s/im.test(w8bMigration) && !/POLICY/i.test(w8bMigration),
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
