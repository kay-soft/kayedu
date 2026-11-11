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
 * W8c (D-W24, D-W40), section 14: the hidden Cash method and its backfill;
 * check-in of enrolled students only (the late rule, no drop-ins); the frozen
 * snapshot in integer piastres with centre share 0 and teacher share = amount
 * through lib/money.ts; the price frozen across a class price edit; SEC-05
 * (also under concurrency) and SEC-12; void with and without a reason, the
 * refund, the Absent switch; close and the lazy close; every settlement path
 * refused by direct call and by the database; analytics and roll-ups; the
 * receipt; premium lapse and archive; every other actor; isolation; the
 * student's history without money and the parent's nothing; ids-only audit;
 * the statics.
 *
 * W8d (D-W25, D-W29, D-W41), sections 15 and 16: the Earnings page's figures
 * against the raw snapshot sums per source and per class, refunds apart,
 * voids excluded, the branch paid-out / not-yet-paid-out split unchanged by
 * workspace money, the teacherHistoryDays window and its note, the calendar's
 * workspace source, the dashboard's combined line, every centre-side read
 * excluding workspaces; then assistants in workspaces: the resolver's second
 * source, the permission × action matrix and its intersection with the
 * teacher's capability, premium, archive, a removed link, a swapped teacher
 * and another teacher's workspace, the window, phones, both ids on every
 * audit row, and every workspace function an assistant must never reach.
 *
 * W9 (D-W26, D-W42), section 17: exams and homework in workspaces — the
 * owner's fixed capability, the engine's defaults, validation, publish, locks,
 * extend, attempts, lazy finalisation, reveal and frozen scores; eligibility
 * (unlinked, unenrolled, left, linked enrolled, another workspace, another
 * teacher); premium lapse refusing every teacher write and none of a
 * student's; archive; notices and the re-check; the assistant matrix; audit
 * with both ids; centre-side, hub and switcher reads; the statics.
 *
 * W10 (D-W43), section 18: workspace share codes — sha256-only storage, one
 * active code per profile (the partial index) and regeneration revoking, one
 * answer for unknown, malformed, expired, used and revoked codes, the expiry
 * boundary, single use under two concurrent redemptions, the refusals
 * (already in the workspace, already linked, own workspace, no login), the
 * atomic W8b move with the placeholder kept when it holds anything else and a
 * pending invitation cancelled, owner-only authority by direct call
 * (assistants, other teachers, centre staff), isolation, premium and archive
 * (generation refused; revoke and redeem allowed), the rate limits, the
 * teacher's reads never carrying the redeemer, the linked student's W8b set,
 * ids-only audit with no code, and the statics.
 *
 * Writes and cleans up its own fixtures (users `workspaces-check-…`, the
 * branch and catalogue rows `workspaces-check-…`, every centre under the
 * fixture users' personal organizations, and — W8b — the placeholder users
 * behind unlinked workspace students, which carry no email: their surname
 * starts `workspaces-check`). Fenced by S1 (`gatePrisma`): staging
 * or a local database only.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
  workspaceRoomId,
  writeWorkspaceClassSlot,
} from "../lib/db/workspaces.ts";
import { ROUTES } from "../lib/routes.ts";
import { addDays, dateKey, todayInTimezone, zonedDateTimeToUtc } from "../lib/scheduling.ts";
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
import { splitShare } from "../lib/money.ts";
import { revenueTotals } from "../lib/db/analytics.ts";
import { activeChildLinks } from "../lib/db/parents.ts";
import { attendedSessionsToRate, skipSessionRating, submitSessionRating } from "../lib/db/ratings.ts";
import { DEFAULT_PAYMENT_METHOD_NAMES } from "../lib/db/payment-methods.ts";
import { sessionReceiptTotals } from "../lib/db/payments.ts";
import { WORKSPACE_PAYMENT_METHOD_NAME } from "../lib/db/platform.ts";
import { createPeriodSettlement, createSessionSettlement } from "../lib/db/settlements.ts";
import {
  workspaceCheckIn,
  workspaceCloseSession,
  workspaceRecordPayment,
  workspaceRefundPayment,
  workspaceSessionRoster,
  workspaceSetAttendance,
  workspaceVoidPayment,
} from "../lib/db/workspace-attendance.ts";
import { workspaceRecordPaymentSchema } from "../lib/validation/workspace-sessions.ts";
// W8d (D-W41): Earnings and assistants in workspaces.
import { ASSISTANT_CODE_ALPHABET, ASSISTANT_PERMISSIONS, PRESET_PERMISSIONS } from "../lib/assistant-catalog.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { paidOutTeacherShare, revenueByTeacher } from "../lib/db/analytics.ts";
import { assistantCan, assistantFloorAt, assistantWorkspaceFloor, resolveAssistantActing } from "../lib/db/assistant-acting.ts";
import { assistantWorkspaceClassRoster } from "../lib/db/assistant-workspaces.ts";
import { revenueTotalsRollup } from "../lib/db/organizations.ts";
import { listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { recordPayment, voidPayment } from "../lib/db/payments.ts";
import { refundPayment } from "../lib/db/refunds.ts";
import {
  ownedWorkspaceSources,
  sourceEarnings,
  teacherEarnings,
  workspacesCollectedThisMonth,
  type EarningsSource,
} from "../lib/db/teacher-earnings.ts";
import { teacherCenterSummary, teacherSessionListWhere } from "../lib/db/teacher-portal.ts";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import { clampRangeToVisibility, teacherHistoryFloor } from "../lib/db/visibility.ts";
import { monthRangeUtc, weekRangeUtc } from "../lib/scheduling.ts";
import { parseEarningsPeriod } from "../lib/validation/earnings.ts";
// W9 (D-W42): assessments in workspaces.
import { assessmentDefaults, type AssessmentDraft, type DraftQuestion } from "../lib/assessments.ts";
import {
  createAssessment,
  deleteAssessment,
  extendAssessment,
  findTeacherAssessment,
  homeworkDeadlineFor,
  listTeacherAssessments,
  publishAssessment,
  resolveAssessmentTeacher,
  saveAssessmentDraft,
  unpublishAssessment,
} from "../lib/db/assessments.ts";
import {
  listStudentAssessments,
  readAttemptReveal,
  readStudentAssessment,
  resolveAssessmentStudent,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from "../lib/db/assessment-attempts.ts";
import { assessmentResultProgress, readAssessmentResults, readAttemptResult } from "../lib/db/assessment-results.ts";
import { loadAuditFeed } from "../lib/db/audit-feed.ts";
import { hiddenAssessmentNoticeIds, syncAssessmentSoonNotices } from "../lib/db/notifications.ts";
import { TEACHER_WORKSPACE_ONLY_NAV } from "../components/shell/nav.ts";
import { EXPECTED_WORKSPACE_ONLY_TEACHER_NAV } from "./lib/expected-nav.ts";
// W10 (D-W43): workspace share codes.
import { generateAssistantCode } from "../lib/db/assistants.ts";
import {
  activeShareCodeExpiries,
  createWorkspaceShareCode,
  previewWorkspaceShareCode,
  redeemWorkspaceShareCode,
  revokeWorkspaceShareCode,
} from "../lib/db/workspace-share-codes.ts";
import { WORKSPACE_SHARE_CODE_ALPHABET, formatWorkspaceShareCodeForDisplay } from "../lib/workspace-share-code.ts";

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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (/node_modules|\.next/.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

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
  // W8c old → new (approved in the W8c prompt): "no payment method" →
  // "exactly one active method named Cash" (D-W40 item 2); still no grants and
  // no baseline rows.
  const methodsA = await prisma.centerPaymentMethod.findMany({ where: { centerId: wsA } });
  check(
    "No baseline: no PermissionGrant row, exactly one active method named Cash (hidden), no baseline rows (by design — not a gap to fill)",
    (await prisma.permissionGrant.count({ where: { centerId: wsA } })) === 0 &&
      methodsA.length === 1 && methodsA[0].name === "Cash" && methodsA[0].active &&
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

  await workspaceMoney({
    today,
    branchId: branch.id,
    branchOrganizationId: branchOrg.id,
    wsA,
    classInput,
    ownerA,
    others,
  });

  // W8d (D-W41): Earnings, then assistants in workspaces.
  const earnings = await workspaceEarnings({ today, gradeId: grade.id, subjectId: subject.id });
  if (earnings) await workspaceAssistants({ today, gradeId: grade.id, subjectId: subject.id, earnings, ownerB });

  // W9 (D-W42): exams and homework in workspaces.
  await workspaceAssessments({ today, gradeId: grade.id, subjectId: subject.id, branchId: branch.id });

  // W10 (D-W43): workspace share codes.
  await workspaceShareCodes({ today, classInput, slot, others });
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
  // W9 old → new (B, approved in the W9 follow-up, D-W42): the student assessments scope now reads
  // through the opt-in resolver; the hub, switcher, staff and teacher resolvers stay branch-only.
  check(
    "The opt-in student resolver is used by the schedule, the calendar and (W9) the assessments scope (static)",
    scheduleUsers.every((file) => /getStudentScheduleContexts\(/.test(read(file))) &&
      /getStudentScheduleContexts\(/.test(read("app/[locale]/(student)/student/assessments/scope.ts")) &&
      !/getStudentContexts\(/.test(read("app/[locale]/(student)/student/assessments/scope.ts")),
  );
  check(
    "The hub, switcher, staff and teacher resolvers never read the opt-in resolver or its input (static)",
    ["lib/auth/relations.ts", "lib/auth/experiences.ts", "lib/auth/teacher-scope.ts", "app/[locale]/(auth)/select-center/page.tsx", "components/shell/experience-switcher-data.ts"].every(
      (file) => !/getStudentScheduleContexts|studentWorkspaceProfiles/.test(read(file)),
    ),
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

// ── 14. W8c: check-in, payments, close and the settlement refusal (D-W24, D-W40) ──

/** A Cairo wall-clock instant on `day` (the gate drives the engine's clock explicitly). */
const cairoAt = (day: Date, hour: number, minute = 0) => zonedDateTimeToUtc(dateKey(day), hour * 60 + minute, TZ);

type Refusal = { ok: false; error: string };
const refusedWith = (result: { ok: boolean } | null, error: string) => result !== null && !result.ok && (result as Refusal).error === error;
const errorOf = (result: { ok: boolean } | null) => (result === null ? "null" : result.ok ? "ok" : (result as Refusal).error);

async function workspaceMoney(fx: {
  today: Date;
  branchId: string;
  branchOrganizationId: string;
  wsA: string;
  classInput: { educationSystemId: null; gradeId: string; subjectId: string; price: number; lateThresholdMinutes: number; startDate: Date; endDate: Date };
  ownerA: FixtureUser;
  others: [string, string][];
}) {
  const { today, branchId } = fx;
  console.log("\n14. W8c: workspace check-in, payments, void, refund, close; never settled");
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const owner = await makeUser("money-teacher", { premium: true });
  const created = await createWorkspace(prisma, owner.id, { name: "Money" });
  check("A fresh workspace for the money matrix", created.ok);
  if (!created.ok) return;
  const ws = created.workspaceId;
  const actor = { actorUserId: owner.id, teacherUserId: owner.id };

  // ── 14a. The hidden Cash method and its backfill ───────────────────────
  const methods = await prisma.centerPaymentMethod.findMany({ where: { centerId: ws } });
  check(
    "createPersonalWorkspace writes exactly one active method named Cash",
    methods.length === 1 && methods[0].name === WORKSPACE_PAYMENT_METHOD_NAME && methods[0].active,
  );
  const cash = methods[0];
  const w8cDir = readdirSync(join(ROOT, "prisma", "migrations")).find((dir) => dir.endsWith("_w8c_workspace_payments"));
  const w8cMigration = w8cDir ? read(`prisma/migrations/${w8cDir}/migration.sql`) : "";
  const backfill = w8cMigration.match(/INSERT INTO "CenterPaymentMethod"[\s\S]*?;/)?.[0] ?? "";
  const bare = await createWorkspace(prisma, owner.id, { name: "Pre-W8c" });
  if (bare.ok && backfill) {
    await prisma.centerPaymentMethod.deleteMany({ where: { centerId: bare.workspaceId } });
    await prisma.$executeRawUnsafe(backfill);
    const once = await prisma.centerPaymentMethod.findMany({ where: { centerId: bare.workspaceId } });
    await prisma.$executeRawUnsafe(backfill);
    const twice = await prisma.centerPaymentMethod.count({ where: { centerId: bare.workspaceId } });
    check(
      "The migration's backfill gives a method-less workspace one active Cash, and a re-run adds nothing (idempotent)",
      once.length === 1 && once[0].name === "Cash" && once[0].active && twice === 1 &&
        (await prisma.centerPaymentMethod.count({ where: { centerId: ws } })) === 1 &&
        (await prisma.centerPaymentMethod.count({ where: { centerId: branchId } })) === DEFAULT_PAYMENT_METHOD_NAMES.length,
    );
  } else {
    check("The migration's backfill gives a method-less workspace one active Cash, and a re-run adds nothing (idempotent)", false, "no backfill statement found");
  }

  // ── 14b. Fixtures: a class, four students, today's 08:00 session ──────
  const options = { confirmConflicts: true, locale: "en", now: cairoAt(today, 7) };
  const cls = await createWorkspaceClass(
    prisma,
    owner.id,
    ws,
    { ...fx.classInput, startDate: today, endDate: addDays(today, 27), slots: [{ dayOfWeek: tomorrow.getUTCDay(), startTime: "16:00", endTime: "18:00" }] },
    options,
  );
  const classId = cls.ok ? cls.classGroupId : "";
  const loginStudent = await makeUser("money-student");
  const linkedPhone = freshPhone();
  await prisma.user.update({ where: { id: loginStudent.id }, data: { phone: linkedPhone, authId: `${STEM}-auth-money-${RUN}` } });
  const addOne = async (tag: string, phone: string) => {
    const result = await addWorkspaceStudent(prisma, owner.id, ws, { ...PLACEHOLDER(tag), phone, gradeId: null });
    return result.ok ? result.studentProfileId : "";
  };
  const s1 = await addOne("m1", linkedPhone);
  const s2 = await addOne("m2", freshPhone());
  const s4 = await addOne("m4", freshPhone());
  const s3 = await addOne("m3", freshPhone()); // a workspace student never enrolled
  const invitation = await prisma.workspaceInvitation.findFirst({ where: { centerId: ws, targetUserId: loginStudent.id, status: "PENDING" } });
  const accepted = invitation ? await acceptWorkspaceInvitation(prisma, loginStudent.id, invitation.id) : null;
  for (const profile of [s1, s2, s4]) await enrolWorkspaceStudent(prisma, owner.id, ws, classId, profile);
  const extra = await createWorkspaceSession(prisma, owner.id, ws, { kind: "extra", classGroupId: classId, date: today, startTime: "08:00", endTime: "09:00" }, options);
  const sessionId = extra.ok ? extra.sessionId : "";
  const oneOff = await createWorkspaceSession(prisma, owner.id, ws, { kind: "oneOff", title: "Revision", price: 5_000, date: today, startTime: "10:00", endTime: "11:00" }, options);
  const oneOffId = oneOff.ok ? oneOff.sessionId : "";
  check(
    "Fixtures: a class at 150 EGP with a 10-minute threshold, three enrolled students (one linked), one not enrolled, today's 08:00 session",
    cls.ok && accepted !== null && accepted.ok && Boolean(s1 && s2 && s3 && s4 && sessionId && oneOffId),
    JSON.stringify({ cls: cls.ok, accepted, extra: extra.ok, oneOff: oneOff.ok }),
  );
  const branchRevenueBefore = JSON.stringify(await revenueTotals(prisma, branchId, { from: null, to: null }));

  // ── 14c. Check-in: the late rule, enrolled only, no drop-ins ───────────
  const in1 = await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s1 }, cairoAt(today, 8, 5));
  const in2 = await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s2 }, cairoAt(today, 8, 20));
  check(
    "Check-in sets Present within the class's 10-minute threshold and Late beyond it (the branch rule), enrolled, not a drop-in",
    in1.ok && in1.attendee.attendanceStatus === "PRESENT" && !in1.attendee.isDropIn && in1.attendee.enrollmentId !== null &&
      in2.ok && in2.attendee.attendanceStatus === "LATE",
  );
  check(
    "The threshold is the workspace class row's own (lateThresholdMinutes 10; the settings default is only the engine's fallback)",
    (await prisma.classGroup.findUniqueOrThrow({ where: { id: classId } })).lateThresholdMinutes === 10,
  );
  const again = await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s1 }, cairoAt(today, 8, 6));
  check("A second check-in of the same student is alreadyCheckedIn (no second row)", refusedWith(again, "alreadyCheckedIn"));
  const notEnrolled = await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s3 }, cairoAt(today, 8, 6));
  const dropInOneOff = await workspaceCheckIn(prisma, actor, ws, { sessionId: oneOffId, studentProfileId: s1 }, cairoAt(today, 10, 5));
  check(
    "A non-enrolled workspace student is refused (notEnrolled) and no drop-in row is written — a one-time session takes nobody",
    refusedWith(notEnrolled, "notEnrolled") && refusedWith(dropInOneOff, "notEnrolled") &&
      (await prisma.sessionAttendee.count({ where: { centerId: ws, OR: [{ studentProfileId: s3 }, { isDropIn: true }] } })) === 0,
  );
  const otherWsStudent = await prisma.studentProfile.findFirst({ where: { centerId: fx.wsA }, select: { id: true } });
  const crossStudent = otherWsStudent ? await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: otherWsStudent.id }, cairoAt(today, 8, 6)) : null;
  check("Another workspace's student is refused (notEnrolled)", refusedWith(crossStudent, "notEnrolled"));

  // ── 14d. Record a payment: the frozen snapshot, 100% the teacher's ──────
  const attendee1 = await prisma.sessionAttendee.findFirstOrThrow({ where: { centerId: ws, sessionId, studentProfileId: s1 } });
  const attendee2 = await prisma.sessionAttendee.findFirstOrThrow({ where: { centerId: ws, sessionId, studentProfileId: s2 } });
  const pay1 = await workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee1.id }, cairoAt(today, 8, 10));
  const expected = splitShare(15_000, "PERCENTAGE", 0);
  const p1 = pay1.ok ? pay1.payment : null;
  check(
    "The payment freezes the session price in integer piastres: amount = price = 15000, centre share 0, teacher share = amount (lib/money.ts on PERCENTAGE 0)",
    p1 !== null && p1.amount === 15_000 && p1.priceSnapshot === 15_000 &&
      p1.centerShareSnapshot === expected.centerShare && p1.teacherShareSnapshot === expected.teacherShare &&
      expected.centerShare === 0 && expected.teacherShare === 15_000 &&
      [p1.amount, p1.priceSnapshot, p1.centerShareSnapshot, p1.teacherShareSnapshot].every(Number.isSafeInteger),
    JSON.stringify(p1),
  );
  check(
    "It carries the hidden Cash method and its frozen label, the owner as teacher, the student's profile",
    p1 !== null && p1.paymentMethodId === cash.id && p1.methodLabelSnapshot === "Cash" && p1.teacherId === owner.id &&
      p1.studentProfileId === s1 && p1.centerId === ws && !p1.voided && !p1.refunded,
  );
  const secondPay = await workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee1.id }, cairoAt(today, 8, 11));
  check("SEC-05: a second payment for the same student is alreadyPaid", refusedWith(secondPay, "alreadyPaid"));
  const race = await Promise.all([
    workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee2.id }, cairoAt(today, 8, 21)),
    workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee2.id }, cairoAt(today, 8, 21)),
  ]);
  check(
    "SEC-05 under concurrency: two simultaneous payments for one student record exactly one",
    race.filter((result) => result.ok).length === 1 &&
      (await prisma.payment.count({ where: { centerId: ws, sessionAttendeeId: attendee2.id, voided: false, refunded: false } })) === 1,
  );
  const paid2 = race.find((result) => result.ok);
  const p2Id = paid2 && paid2.ok ? paid2.payment.id : "";

  // ── 14e. Price frozen: a later class price edit changes no payment ──────
  const edited = await updateWorkspaceClass(prisma, owner.id, ws, classId, { ...fx.classInput, price: 20_000, startDate: today, endDate: addDays(today, 27) }, options);
  const afterEdit = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  const p1After = p1 ? await prisma.payment.findUniqueOrThrow({ where: { id: p1.id } }) : null;
  const unpaidOpen = await prisma.session.findMany({ where: { centerId: ws, classGroupId: classId, date: { gt: today }, closedAt: null } });
  check(
    "A class price edit leaves the paid session at 150 EGP and every recorded payment exactly as frozen (unpaid open sessions take 200 EGP)",
    edited.ok && afterEdit.priceSnapshot === 15_000 && p1After !== null && p1 !== null &&
      (["amount", "priceSnapshot", "centerShareSnapshot", "teacherShareSnapshot", "paymentMethodId", "methodLabelSnapshot", "voided", "refunded"] as const).every(
        (field) => p1After[field] === p1[field],
      ) &&
      unpaidOpen.length > 0 && unpaidOpen.every((row) => row.priceSnapshot === 20_000),
    JSON.stringify({ edited: edited.ok, price: afterEdit.priceSnapshot, unpaidOpen: unpaidOpen.map((row) => row.priceSnapshot) }),
  );

  // ── 14f. Void: a reason, the T5 reset, SEC-12 ───────────────────────────
  const p1Id = p1?.id ?? "";
  const noReason = await workspaceVoidPayment(prisma, actor, ws, { paymentId: p1Id, reason: "   " }, cairoAt(today, 8, 25));
  check("A void without a reason is refused (reasonRequired) and changes nothing", refusedWith(noReason, "reasonRequired") && !(await prisma.payment.findUniqueOrThrow({ where: { id: p1Id } })).voided);
  const voided1 = await workspaceVoidPayment(prisma, actor, ws, { paymentId: p1Id, reason: "Wrong student" }, cairoAt(today, 8, 25));
  const v1 = await prisma.payment.findUniqueOrThrow({ where: { id: p1Id } });
  const reset1 = await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: attendee1.id } });
  const voidChange = await prisma.sessionAttendanceChange.findFirst({ where: { centerId: ws, voidedPaymentId: p1Id } });
  check(
    "A void with a reason keeps the money fields, flags it voided with the reason, and resets the student to Not arrived (one change row)",
    voided1.ok && v1.voided && v1.voidReason === "Wrong student" && v1.amount === 15_000 && v1.teacherShareSnapshot === 15_000 &&
      v1.centerShareSnapshot === 0 && reset1.attendanceStatus === "ABSENT" && voidChange !== null && voidChange.toStatus === "ABSENT",
  );
  const voidTwice = await workspaceVoidPayment(prisma, actor, ws, { paymentId: p1Id, reason: "Again" }, cairoAt(today, 8, 26));
  const refundVoided = await workspaceRefundPayment(prisma, actor, ws, { paymentId: p1Id, reason: "Back" }, cairoAt(today, 8, 26));
  check("SEC-12: a voided payment is neither voided again nor refunded", refusedWith(voidTwice, "alreadyVoided") && refusedWith(refundVoided, "alreadyVoided"));

  // ── 14g. Re-check-in and pay again: a NEW row at the session's price ────
  const recheck = await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s1 }, cairoAt(today, 8, 30));
  const pay3 = await workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee1.id }, cairoAt(today, 8, 31));
  check(
    "The Not-arrived student is checked in again on the same row (Late, from this arrival) and pays a new row at the frozen 150 EGP",
    recheck.ok && recheck.attendee.id === attendee1.id && recheck.attendee.attendanceStatus === "LATE" &&
      pay3.ok && pay3.payment.id !== p1Id && pay3.payment.amount === 15_000 && pay3.payment.teacherShareSnapshot === 15_000 && pay3.payment.centerShareSnapshot === 0,
  );

  // ── 14h. Refund: cash back, both shares reversed, SEC-12 ────────────────
  const p3Id = pay3.ok ? pay3.payment.id : "";
  const refunded = await workspaceRefundPayment(prisma, actor, ws, { paymentId: p3Id, reason: "Left early" }, cairoAt(today, 8, 40));
  const p3After = await prisma.payment.findUniqueOrThrow({ where: { id: p3Id } });
  check(
    "A refund keeps the payment's money fields, writes a Refund reversing amount 15000, centre 0 and teacher 15000, and resets to Not arrived",
    refunded.ok && refunded.refund !== null && p3After.refunded && !p3After.voided && p3After.amount === 15_000 && p3After.teacherShareSnapshot === 15_000 &&
      refunded.refund.amount === 15_000 && refunded.refund.centerShareReversed === 0 && refunded.refund.teacherShareReversed === 15_000 &&
      (await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: attendee1.id } })).attendanceStatus === "ABSENT",
  );
  const voidRefunded = await workspaceVoidPayment(prisma, actor, ws, { paymentId: p3Id, reason: "x" }, cairoAt(today, 8, 41));
  const refundTwice = await workspaceRefundPayment(prisma, actor, ws, { paymentId: p3Id, reason: "x" }, cairoAt(today, 8, 41));
  check(
    "SEC-12: a refunded payment is neither voided nor refunded again (never both on one row)",
    refusedWith(voidRefunded, "alreadyRefunded") && refusedWith(refundTwice, "alreadyRefunded") &&
      (await prisma.payment.count({ where: { centerId: ws, voided: true, refunded: true } })) === 0,
  );

  // ── 14i. The Absent switch voids, with its confirmation and reason ──────
  const unconfirmed = await workspaceSetAttendance(prisma, actor, ws, { sessionId, studentProfileId: s2, status: "ABSENT", confirmVoid: false }, cairoAt(today, 8, 42));
  const noAbsentReason = await workspaceSetAttendance(prisma, actor, ws, { sessionId, studentProfileId: s2, status: "ABSENT", confirmVoid: true }, cairoAt(today, 8, 42));
  check(
    "Switching a paid student to Absent needs the confirmation (voidConfirmationRequired) and a reason (reasonRequired), writing nothing",
    refusedWith(unconfirmed, "voidConfirmationRequired") && refusedWith(noAbsentReason, "reasonRequired") &&
      (await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: attendee2.id } })).attendanceStatus === "LATE",
  );
  const absent2 = await workspaceSetAttendance(prisma, actor, ws, { sessionId, studentProfileId: s2, status: "ABSENT", reason: "Never came", confirmVoid: true }, cairoAt(today, 8, 43));
  const p2Row = await prisma.payment.findUniqueOrThrow({ where: { id: p2Id } });
  const absentChange = await prisma.sessionAttendanceChange.findFirst({ where: { centerId: ws, voidedPaymentId: p2Id } });
  check(
    "The Absent switch voids the payment in the same change, keeps its change row (reason on both) and the student reads Absent",
    absent2.ok && absent2.voidedPayment?.id === p2Id && p2Row.voided && p2Row.voidReason === "Never came" &&
      absentChange !== null && absentChange.fromStatus === "LATE" && absentChange.toStatus === "ABSENT" && absentChange.reason === "Never came",
  );

  // A last check-in and payment, so the receipt has money that stood.
  await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s1 }, cairoAt(today, 8, 45));
  const pay4 = await workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee1.id }, cairoAt(today, 8, 46));
  const p4 = pay4.ok ? pay4.payment : null;
  check("The re-checked-in student pays once more (the money the receipt keeps)", p4 !== null && p4.amount === 15_000);

  // ── 14j. Settlements can never see or claim a workspace payment ────────
  const sessionSettle = await prisma.$transaction((tx) => createSessionSettlement(tx, ws, sessionId, owner.id, { now: cairoAt(today, 9, 30) }));
  const periodSettle = await prisma.$transaction((tx) => createPeriodSettlement(tx, ws, owner.id, addDays(today, -7), today, owner.id, { now: cairoAt(today, 9, 30) }));
  check(
    "createSessionSettlement and createPeriodSettlement refuse a PERSONAL centre (workspaceNotSettled) by direct call",
    refusedWith(sessionSettle, "workspaceNotSettled") && refusedWith(periodSettle, "workspaceNotSettled") &&
      (await prisma.settlement.count({ where: { centerId: ws } })) === 0,
  );
  let settlementRefused = false;
  try {
    await prisma.settlement.create({ data: { centerId: ws, teacherId: owner.id, totalAmount: 0, createdBy: owner.id, periodFrom: today, periodTo: today } });
  } catch {
    settlementRefused = true;
  }
  check("The database refuses a Settlement row in a PERSONAL centre (trigger)", settlementRefused);
  const branchSettlement = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, branchId, owner.id, addDays(today, -7), yesterday, owner.id, { now: cairoAt(today, 9, 30) }),
  );
  let claimRefused = false;
  let claimInWorkspaceRefused = false;
  if (branchSettlement.ok && p4) {
    try {
      await prisma.settlementClaim.create({
        data: { centerId: branchId, settlementId: branchSettlement.settlement.id, paymentId: p4.id, teacherShare: p4.teacherShareSnapshot },
      });
    } catch {
      claimRefused = true;
    }
    try {
      await prisma.settlementClaim.create({
        data: { centerId: ws, settlementId: branchSettlement.settlement.id, paymentId: p4.id, teacherShare: p4.teacherShareSnapshot },
      });
    } catch {
      claimInWorkspaceRefused = true;
    }
  }
  check(
    "A branch settlement for the same teacher claims none of the workspace's payments, and the database refuses a claim naming one or the workspace (trigger)",
    branchSettlement.ok && branchSettlement.claimedPayments === 0 && claimRefused && claimInWorkspaceRefused &&
      (await prisma.settlementClaim.count({ where: { payment: { centerId: ws } } })) === 0,
  );
  const triggers = await prisma.$queryRaw<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE tgname IN ('Settlement_branch_only', 'SettlementClaim_branch_only')`;
  check("Both W8c triggers exist in the database", triggers.length === 2);
  check(
    "No settlement row of any kind sits in the workspace, and no settlement.* audit row was written there",
    (await prisma.settlement.count({ where: { centerId: ws } })) === 0 &&
      (await prisma.auditLog.count({ where: { centerId: ws, action: { startsWith: "settlement." } } })) === 0,
  );

  // ── 14k. Analytics and branch roll-ups exclude them ─────────────────────
  check(
    "The branch's revenue (for this teacher too) is unchanged by workspace payments",
    JSON.stringify(await revenueTotals(prisma, branchId, { from: null, to: null })) === branchRevenueBefore &&
      (await revenueTotals(prisma, branchId, { from: null, to: null }, owner.id)).paymentCount === 0,
  );
  const ownerOrg = await prisma.center.findUniqueOrThrow({ where: { id: ws }, select: { organizationId: true } });
  check(
    "No roll-up reaches the workspace: the branch organization's branches, the personal organization's (none), the teacher's centre relations, the accessible centres",
    !(await organizationBranches(prisma, fx.branchOrganizationId)).some((row) => row.id === ws) &&
      (await organizationBranches(prisma, ownerOrg.organizationId)).length === 0 &&
      !(await resolveCenterRelations(prisma, owner.id)).some((row) => row.center.id === ws) &&
      !(await listAccessibleCenters(prisma)).some((row) => row.id === ws),
  );

  // ── 14l. Receipt totals, live then closed ───────────────────────────────
  const live = await sessionReceiptTotals(prisma, ws, sessionId);
  check(
    "The live receipt: collected 150 EGP net of the refund, centre 0, teacher 150 EGP, two voided, one refunded, one late, one not arrived",
    live.collected === 15_000 && live.centerShare === 0 && live.teacherShare === 15_000 &&
      live.voidedCount === 2 && live.voidedAmount === 30_000 && live.refundedCount === 1 && live.refundedAmount === 15_000 &&
      live.lateCount === 1 && live.presentCount === 0 && live.notArrivedCount === 1 && !live.sessionClosed,
    JSON.stringify(live),
  );
  const early = await workspaceCloseSession(prisma, actor, ws, { sessionId: oneOffId }, cairoAt(today, 9, 50));
  check("Closing a session before it starts is refused (notStarted)", refusedWith(early, "notStarted"));
  const closed = await workspaceCloseSession(prisma, actor, ws, { sessionId }, cairoAt(today, 9, 0));
  const s4Row = await prisma.sessionAttendee.findFirst({ where: { centerId: ws, sessionId, studentProfileId: s4 } });
  check(
    "Close marks the enrolled no-show Absent (one row, enrolled, not a drop-in)",
    closed.ok && closed.absentCreated === 1 && s4Row !== null && s4Row.attendanceStatus === "ABSENT" && !s4Row.isDropIn && s4Row.enrollmentId !== null,
  );
  const finalTotals = await sessionReceiptTotals(prisma, ws, sessionId);
  check(
    "The closed receipt matches: collected 150 EGP, centre 0, teacher 150 EGP, Present 0, Late 1, Absent 2",
    finalTotals.sessionClosed && finalTotals.collected === 15_000 && finalTotals.centerShare === 0 && finalTotals.teacherShare === 15_000 &&
      finalTotals.presentCount === 0 && finalTotals.lateCount === 1 && finalTotals.absentCount === 2 && finalTotals.paidCount === 2,
    JSON.stringify(finalTotals),
  );
  const p4Id = p4?.id ?? "";
  const closedWrites = [
    await workspaceCheckIn(prisma, actor, ws, { sessionId, studentProfileId: s2 }, cairoAt(today, 9, 5)),
    await workspaceSetAttendance(prisma, actor, ws, { sessionId, studentProfileId: s1, status: "PRESENT" }, cairoAt(today, 9, 5)),
    await workspaceRecordPayment(prisma, actor, ws, { attendeeId: attendee2.id }, cairoAt(today, 9, 5)),
    await workspaceVoidPayment(prisma, actor, ws, { paymentId: p4Id, reason: "late" }, cairoAt(today, 9, 5)),
    await workspaceRefundPayment(prisma, actor, ws, { paymentId: p4Id, reason: "late" }, cairoAt(today, 9, 5)),
  ];
  const closeAgain = await workspaceCloseSession(prisma, actor, ws, { sessionId }, cairoAt(today, 9, 6));
  check(
    "A closed session is immutable: check-in, correction, payment, void and refund answer sessionClosed; closing again alreadyClosed",
    closedWrites.every((result) => refusedWith(result, "sessionClosed")) && refusedWith(closeAgain, "alreadyClosed"),
    JSON.stringify(closedWrites.map(errorOf)),
  );

  // ── 14m. The end-of-day lazy close ──────────────────────────────────────
  const roomId = await workspaceRoomId(prisma, ws);
  const past = await prisma.session.create({
    data: { centerId: ws, classGroupId: classId, teacherId: owner.id, roomId, date: yesterday, startTime: "08:00", endTime: "09:00", priceSnapshot: 15_000, timezone: TZ, isManual: true },
  });
  await prisma.enrollment.updateMany({ where: { centerId: ws, classGroupId: classId }, data: { enrolledAt: addDays(today, -3) } });
  const lazy = await workspaceCheckIn(prisma, actor, ws, { sessionId: past.id, studentProfileId: s1 });
  const pastAfter = await prisma.session.findUniqueOrThrow({ where: { id: past.id } });
  check(
    "A session whose day ended is closed by the next touch (AUTO), its enrolled no-shows Absent, and the check-in refused",
    refusedWith(lazy, "sessionClosed") && pastAfter.closedAt !== null && pastAfter.closeMode === "AUTO" &&
      (await prisma.sessionAttendee.count({ where: { centerId: ws, sessionId: past.id, attendanceStatus: "ABSENT", isDropIn: false } })) === 3,
  );

  // ── 14n. Premium lapse and archive refuse every write; reads continue ───
  const fresh = await createWorkspaceSession(prisma, owner.id, ws, { kind: "extra", classGroupId: classId, date: today, startTime: "12:00", endTime: "13:00" }, options);
  const freshId = fresh.ok ? fresh.sessionId : "";
  await workspaceCheckIn(prisma, actor, ws, { sessionId: freshId, studentProfileId: s2 }, cairoAt(today, 12, 1));
  const freshAttendee = await prisma.sessionAttendee.findFirst({ where: { centerId: ws, sessionId: freshId, studentProfileId: s2 } });
  const freshPay = freshAttendee ? await workspaceRecordPayment(prisma, actor, ws, { attendeeId: freshAttendee.id }, cairoAt(today, 12, 2)) : null;
  const freshPaymentId = freshPay && freshPay.ok ? freshPay.payment.id : "missing";
  check(
    "A session created after the price edit freezes the new price: 200 EGP, still centre 0 (one paid student, for the refusals)",
    Boolean(freshId) && freshPay !== null && freshPay.ok && freshPay.payment.amount === 20_000 && freshPay.payment.centerShareSnapshot === 0,
  );
  const everyWrite = async (as: { actorUserId: string; teacherUserId: string }, workspaceId: string) => [
    await workspaceCheckIn(prisma, as, workspaceId, { sessionId: freshId, studentProfileId: s1 }, cairoAt(today, 12, 3)),
    await workspaceSetAttendance(prisma, as, workspaceId, { sessionId: freshId, studentProfileId: s2, status: "PRESENT" }, cairoAt(today, 12, 3)),
    await workspaceRecordPayment(prisma, as, workspaceId, { attendeeId: freshAttendee?.id ?? "missing" }, cairoAt(today, 12, 3)),
    await workspaceVoidPayment(prisma, as, workspaceId, { paymentId: freshPaymentId, reason: "x" }, cairoAt(today, 12, 3)),
    await workspaceRefundPayment(prisma, as, workspaceId, { paymentId: freshPaymentId, reason: "x" }, cairoAt(today, 12, 3)),
    await workspaceCloseSession(prisma, as, workspaceId, { sessionId: freshId }, cairoAt(today, 12, 30)),
  ];
  // Lapsed before every instant this section drives the engine with (the
  // writers judge premium at the `now` they are given, as the app does at the
  // request's time).
  await setPremium(owner.id, addDays(today, -2));
  const lapsed = await everyWrite(actor, ws);
  const lapsedRoster = await workspaceSessionRoster(prisma, ws, { id: freshId, classGroupId: classId, closedAt: null }, false);
  check(
    "Lapsed premium: check-in, correction, record, void, refund and close all answer premiumRequired",
    lapsed.every((result) => refusedWith(result, "premiumRequired")),
    JSON.stringify(lapsed.map(errorOf)),
  );
  check(
    "Lapsed: reads continue — the roster and the receipt",
    lapsedRoster.length === 3 && (await sessionReceiptTotals(prisma, ws, freshId)).collected === 20_000,
  );
  await setPremium(owner.id, inDays(30));
  await prisma.center.update({ where: { id: ws }, data: { archivedAt: new Date(), archivedByUserId: owner.id } });
  const archived = await everyWrite(actor, ws);
  check("Archived: every write answers workspaceArchived", archived.every((result) => refusedWith(result, "workspaceArchived")), JSON.stringify(archived.map(errorOf)));
  await prisma.center.update({ where: { id: ws }, data: { archivedAt: null, archivedByUserId: null } });
  check(
    "Nothing moved while refused: the payment is still the one active row, the session still open",
    (await prisma.payment.count({ where: { centerId: ws, sessionId: freshId, voided: false, refunded: false } })) === 1 &&
      (await prisma.session.findUniqueOrThrow({ where: { id: freshId } })).closedAt === null,
  );

  // ── 14o. Everyone else, by direct call ──────────────────────────────────
  for (const [label, other] of [...fx.others, ["another workspace owner (A)", fx.ownerA.id] as [string, string]]) {
    const results = await everyWrite({ actorUserId: other, teacherUserId: other }, ws);
    check(`${label}: every W8c writer answers notFound`, results.every((result) => refusedWith(result, "notFound")), JSON.stringify(results.map(errorOf)));
  }
  const swappedTeacher = await everyWrite({ actorUserId: owner.id, teacherUserId: fx.ownerA.id }, ws);
  check("The owner acting for a teacher who does not own the workspace is notFound", swappedTeacher.every((result) => refusedWith(result, "notFound")));

  // ── 14p. Cross-workspace and cross-centre isolation ─────────────────────
  const otherWs = await createWorkspace(prisma, owner.id, { name: "Money two" });
  const otherId = otherWs.ok ? otherWs.workspaceId : "";
  const cross = [...(await everyWrite(actor, otherId)), ...(await everyWrite(actor, branchId))];
  check(
    "The same owner's other workspace, and a branch id, reach none of this workspace's sessions, rows or payments (notFound)",
    Boolean(otherId) && cross.every((result) => refusedWith(result, "notFound")),
    JSON.stringify(cross.map(errorOf)),
  );
  check(
    "The other workspace has its own one Cash method and no payment",
    (await prisma.centerPaymentMethod.count({ where: { centerId: otherId } })) === 1 && (await prisma.payment.count({ where: { centerId: otherId } })) === 0,
  );

  // ── 14q. The student sees attendance, never money; parents see nothing ──
  const history = await studentPastAttendance(prisma, ws, s1, tomorrow);
  check(
    "The linked student's own history reads this workspace's sessions with their status (through their linked profile)",
    (await studentWorkspaceProfiles(prisma, loginStudent.id)).some((row) => row.centerId === ws) &&
      history.some((row) => row.sessionId === sessionId && row.attendanceStatus === "LATE"),
  );
  check(
    "The schedule hides the paid amount on a Private class row and keeps it on a branch row (static)",
    /paidAmount: privateClass \? null : \(row\.payments\[0\]\?\.amount \?\? null\)/.test(read("app/[locale]/(student)/student/schedule/page.tsx")),
  );
  const toRate = await attendedSessionsToRate(prisma, loginStudent.id, cairoAt(today, 20));
  const rated = await submitSessionRating(prisma, { studentUserId: loginStudent.id, sessionId, score: 5, now: cairoAt(today, 20) });
  await skipSessionRating(prisma, { studentUserId: loginStudent.id, sessionId });
  check(
    "Ratings stay branch-only (D-W39): the attended workspace session is never offered, rated (notAttended) or skipped",
    !toRate.some((row) => row.centerId === ws) && !rated.ok && rated.error === "notAttended" &&
      (await prisma.sessionRating.count({ where: { sessionId } })) === 0 &&
      (await prisma.sessionRatingSkip.count({ where: { sessionId } })) === 0,
  );
  const parent = await makeUser("money-parent");
  await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: loginStudent.id, source: "LEGACY_VERIFIED" } });
  const links = await activeChildLinks(prisma, parent.id);
  check(
    "A parent linked to the student sees no workspace profile (activeChildLinks reads accessible branches only)",
    links.length === 1 && !links[0].studentUser.studentProfiles.some((profile) => profile.centerId === ws || profile.center.kind === "PERSONAL"),
  );

  // ── 14r. Audit: the branches' actions, ids only ─────────────────────────
  const W8C_ACTIONS = ["payment.record", "payment.void", "payment.refund", "attendance.correct", "session.close"];
  const auditRows = await prisma.auditLog.findMany({ where: { centerId: ws, action: { in: W8C_ACTIONS } } });
  const auditActions = new Set(auditRows.map((row) => row.action));
  check(
    "payment.record, payment.void, payment.refund, attendance.correct and session.close (manual and AUTO) are written",
    W8C_ACTIONS.every((action) => auditActions.has(action)) &&
      auditRows.some((row) => row.action === "session.close" && row.actorUserId === null) &&
      auditRows.some((row) => row.action === "session.close" && row.actorUserId === owner.id),
    [...auditActions].join(", "),
  );
  check(
    "Every W8c audit row is ids and amounts only, by the owner (or the system), on behalf of no one",
    auditRows.every((row) => forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null && row.onBehalfOfUserId === null &&
      (row.actorUserId === owner.id || row.actorUserId === null)),
  );
  const recordRow = auditRows.find((row) => row.action === "payment.record" && row.entityId === p4Id);
  const recordAfter = (recordRow?.after ?? {}) as Record<string, unknown>;
  check(
    "The payment.record row carries the frozen split: centre 0, teacher = amount, the hidden method's id",
    recordRow !== undefined && Object.keys(recordAfter).sort().join() === "amount,centerShareSnapshot,paymentMethodId,sessionId,teacherShareSnapshot" &&
      recordAfter.amount === 15_000 && recordAfter.centerShareSnapshot === 0 && recordAfter.teacherShareSnapshot === 15_000 &&
      recordAfter.sessionId === sessionId && recordAfter.paymentMethodId === cash.id,
    JSON.stringify(recordRow?.after),
  );

  // ── 14s. Statics ────────────────────────────────────────────────────────
  const sessionActions = read("app/[locale]/(teacher)/teacher/workspaces/session-actions.ts");
  const w8cExported = [...sessionActions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g)];
  check(
    "Every W8c action takes the actor from the session and posts no user, amount or method; no centre matrix (static)",
    w8cExported.length === 6 &&
      w8cExported.every(([body]) => /await getCurrentUser\(\)/.test(body) && /actorUserId: user\.id, teacherUserId: user\.id/.test(body)) &&
      !/formData\.get\(|paymentMethodId|amount/.test(sessionActions.replace(/\/\*\*[\s\S]*?\*\//g, "")) &&
      !/ctxCan\(|getTenantContext\(|requireExperience\(/.test(sessionActions),
    `${w8cExported.length} actions`,
  );
  const parsedPay = workspaceRecordPaymentSchema.safeParse({ locale: "en", workspaceId: ws, sessionId, attendeeId: "a", amount: "1", paymentMethodId: "m", userId: "u" });
  check(
    "The payment schema strips a posted amount, method or user (the real schema)",
    parsedPay.success && !("amount" in parsedPay.data) && !("paymentMethodId" in parsedPay.data) && !("userId" in parsedPay.data),
  );
  const page = read("app/[locale]/(teacher)/teacher/workspaces/[id]/sessions/[sessionId]/page.tsx");
  check(
    "The session page resolves its own context and offers no settlement verb (static)",
    /getWorkspaceContext\(id\)/.test(page) && /notFound\(\)/.test(page) && !/getTenantContext\(|getTeacherScope|SessionSettlementAction|settlements\./.test(page),
  );
  const workspaceUi = [page, read("components/teacher/workspaces/workspace-session-roster.tsx"), sessionActions].join("\n");
  check(
    "The hidden method is listed nowhere: no workspace screen or action reads or offers payment methods (static)",
    !/listActivePaymentMethods|PaymentMethodSelector|paymentMethods/.test(workspaceUi),
  );
  const settlementsSource = read("lib/db/settlements.ts");
  check(
    "Both settlement creators refuse a PERSONAL centre first, and claimablePayments reads BRANCH payments only (static)",
    (settlementsSource.match(/if \(!\(await isSettleableCenter\(tx, centerId\)\)\) return \{ ok: false, error: "workspaceNotSettled" \};/g) ?? []).length === 2 &&
      /settlementClaims: \{ none: \{ releasedAt: null \} \},[\s\S]{0,160}center: BRANCH_ONLY/.test(settlementsSource),
  );
  check(
    "The W8c migration is additive: the backfill and two triggers, no DROP, no policy, no table change (static)",
    /CREATE TRIGGER "Settlement_branch_only"/.test(w8cMigration) && /CREATE TRIGGER "SettlementClaim_branch_only"/.test(w8cMigration) &&
      /NOT EXISTS \(SELECT 1 FROM "CenterPaymentMethod"/.test(w8cMigration) &&
      !/^\s*DROP\s/im.test(w8cMigration) && !/POLICY|ALTER TABLE|CREATE TABLE/i.test(w8cMigration),
  );
}

// ── 15. W8d: the Earnings page (D-W25, D-W29, D-W41) ───────────────────────

type W8dFixture = {
  today: Date;
  gradeId: string;
  subjectId: string;
};

/** Raw sums straight off the rows — the oracle the Earnings figures must equal. */
async function rawMoney(centerId: string, teacherId: string, from: Date | null, to: Date | null) {
  const date = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  const payments = await prisma.payment.findMany({
    where: { centerId, teacherId, voided: false, session: { date } },
    select: { id: true, teacherShareSnapshot: true, refunded: true, sessionId: true, session: { select: { classGroupId: true } } },
  });
  const refunds = await prisma.refund.findMany({
    where: { centerId, teacherId, payment: { session: { date } } },
    select: { teacherShareReversed: true, payment: { select: { session: { select: { classGroupId: true } } } } },
  });
  const byClass = new Map<string, { gross: number; refunds: number; sessions: Set<string> }>();
  for (const payment of payments) {
    const key = payment.session.classGroupId ?? "";
    const row = byClass.get(key) ?? { gross: 0, refunds: 0, sessions: new Set<string>() };
    row.gross += payment.teacherShareSnapshot;
    if (!payment.refunded) row.sessions.add(payment.sessionId);
    byClass.set(key, row);
  }
  for (const refund of refunds) {
    const key = refund.payment.session.classGroupId ?? "";
    const row = byClass.get(key) ?? { gross: 0, refunds: 0, sessions: new Set<string>() };
    row.refunds += refund.teacherShareReversed;
    byClass.set(key, row);
  }
  const gross = payments.reduce((sum, row) => sum + row.teacherShareSnapshot, 0);
  const refunded = refunds.reduce((sum, row) => sum + row.teacherShareReversed, 0);
  return {
    gross,
    refunds: refunded,
    net: gross - refunded,
    count: payments.length,
    paidSessions: new Set(payments.filter((row) => !row.refunded).map((row) => row.sessionId)).size,
    byClass,
  };
}

/** Present / late / absent, the roster's rule, straight off the rows. */
async function rawAttendance(centerId: string, teacherId: string, from: Date, to: Date) {
  const rows = await prisma.sessionAttendee.findMany({
    where: { centerId, studentProfileId: { not: null }, session: { teacherId, date: { gte: from, lte: to } } },
    select: { attendanceStatus: true, isDropIn: true, session: { select: { closedAt: true } } },
  });
  return {
    present: rows.filter((row) => row.attendanceStatus === "PRESENT").length,
    late: rows.filter((row) => row.attendanceStatus === "LATE").length,
    absent: rows.filter((row) => row.attendanceStatus === "ABSENT" && !row.isDropIn && row.session.closedAt !== null).length,
  };
}

async function workspaceEarnings(fx: W8dFixture) {
  const { today } = fx;
  const now = new Date();
  console.log("\n15. W8d: Earnings — per source and per class from the frozen snapshots, refunds apart, windows, centre-side exclusions");
  const teacher = await makeUser("earn-teacher", { premium: true });
  const desk = await makeUser("earn-desk");
  const days = (n: number) => addDays(today, -n);

  const makeBranch = async (tag: string) => {
    const org = await prisma.organization.create({ data: { name: `${ORG_NAME} Earn ${tag} ${RUN}`, maxBranches: 1 } });
    const center = await prisma.center.create({ data: { slug: `${STEM}-earn-${tag}-${RUN}`, name: `${ORG_NAME} Earn ${tag}`, organizationId: org.id } });
    await provisionCenterBaseline(prisma, center.id);
    await prisma.membership.create({ data: { userId: teacher.id, centerId: center.id, role: "TEACHER", firstName: "E", lastName: "Teacher", joinedAt: now } });
    return { id: center.id, name: center.name, organizationId: org.id };
  };
  const b1 = await makeBranch("one");
  const b2 = await makeBranch("two");
  const klass = (centerId: string, price: number, type: "FIXED" | "PERCENTAGE", value: number) =>
    prisma.classGroup.create({
      data: scopedData(centerId, {
        startDate: days(150),
        endDate: addDays(today, 30),
        teacherId: teacher.id,
        subjectId: fx.subjectId,
        gradeId: fx.gradeId,
        price,
        centerShareType: type,
        centerShareValue: value,
      }),
    });
  const session = (centerId: string, classGroupId: string, ago: number, price: number, startTime = "10:00") =>
    prisma.session.create({
      data: scopedData(centerId, { classGroupId, teacherId: teacher.id, date: days(ago), startTime, endTime: "11:00", priceSnapshot: price }),
    });
  const learner = async (centerId: string, tag: string) => {
    const user = await prisma.user.create({ data: { firstName: "Earn", lastName: `${STEM}-earn-${tag}-${RUN}`, locale: "en" } });
    const profile = await prisma.studentProfile.create({
      data: scopedData(centerId, { userId: user.id, studentCode: `${STEM}-E${tag}-${RUN}`, firstName: "Earn", lastName: `${STEM}-earn-${tag}` }),
    });
    return profile.id;
  };
  const methods = new Map<string, string>();
  const methodAt = async (centerId: string) => {
    if (!methods.has(centerId)) methods.set(centerId, (await listActivePaymentMethods(prisma, centerId))[0].id);
    return methods.get(centerId)!;
  };
  const attend = (centerId: string, sessionId: string, profileId: string, status: "PRESENT" | "LATE" | "ABSENT") =>
    createAttendance(
      prisma,
      { centerId, sessionId, studentProfileId: profileId, enrollmentId: null, isDropIn: false, recordedBy: teacher.id },
      { historicalBackfill: true, status },
    );
  const pay = async (centerId: string, sessionId: string, profileId: string, status: "PRESENT" | "LATE" = "PRESENT") => {
    const attendee = await attend(centerId, sessionId, profileId, status);
    const methodId = await methodAt(centerId);
    const result = await prisma.$transaction((tx) => recordPayment(tx, centerId, attendee.id, methodId, teacher.id, { historicalBackfill: true }));
    if (!result.ok) throw new Error(`recordPayment: ${result.error}`);
    return result.payment;
  };
  const voidIt = (centerId: string, paymentId: string) =>
    prisma.$transaction((tx) => voidPayment(tx, centerId, paymentId, "fixture", teacher.id, { historicalBackfill: true }));
  const refundIt = (centerId: string, paymentId: string) =>
    prisma.$transaction((tx) => refundPayment(tx, centerId, paymentId, "fixture", teacher.id, { historicalBackfill: true }));

  // Branch one: a FIXED 10 EGP cut on 100 EGP (teacher 90) and 25% on 200 EGP (teacher 150).
  const c11 = await klass(b1.id, 10_000, "FIXED", 1_000);
  const c12 = await klass(b1.id, 20_000, "PERCENTAGE", 25);
  const [st1, st2, st3] = [await learner(b1.id, "b1a"), await learner(b1.id, "b1b"), await learner(b1.id, "b1c")];
  const s11a = await session(b1.id, c11.id, 3, 10_000);
  const p1 = await pay(b1.id, s11a.id, st1);
  const p2 = await pay(b1.id, s11a.id, st2, "LATE");
  await attend(b1.id, s11a.id, st3, "ABSENT");
  await prisma.session.update({ where: { id: s11a.id }, data: { closedAt: now, closeMode: "MANUAL", closedBy: teacher.id } });
  const s11b = await session(b1.id, c11.id, 12, 10_000);
  const p3 = await pay(b1.id, s11b.id, st1);
  const refunded3 = await refundIt(b1.id, p3.id);
  const s12a = await session(b1.id, c12.id, 5, 20_000);
  const p4 = await pay(b1.id, s12a.id, st1);
  const p5 = await pay(b1.id, s12a.id, st2);
  const voided5 = await voidIt(b1.id, p5.id);
  const s11old = await session(b1.id, c11.id, 60, 10_000);
  await pay(b1.id, s11old.id, st1);
  // A PAID settlement claiming s11a's two payments; a DRAFT claiming s12a's.
  const paidSettlement = await prisma.settlement.create({
    data: { centerId: b1.id, teacherId: teacher.id, sessionId: s11a.id, totalAmount: 18_000, status: "PAID", createdBy: desk.id, approvedBy: desk.id, approvedAt: now, paidBy: desk.id, paidAt: now },
  });
  await prisma.settlementClaim.createMany({
    data: [p1, p2].map((payment) => ({ centerId: b1.id, settlementId: paidSettlement.id, paymentId: payment.id, teacherShare: payment.teacherShareSnapshot })),
  });
  const draftSettlement = await prisma.settlement.create({
    data: { centerId: b1.id, teacherId: teacher.id, sessionId: s12a.id, totalAmount: 15_000, status: "DRAFT", createdBy: desk.id },
  });
  await prisma.settlementClaim.create({ data: { centerId: b1.id, settlementId: draftSettlement.id, paymentId: p4.id, teacherShare: p4.teacherShareSnapshot } });

  // Branch two: 10% on 150 EGP (teacher 135).
  const c21 = await klass(b2.id, 15_000, "PERCENTAGE", 10);
  const [u1, u2] = [await learner(b2.id, "b2a"), await learner(b2.id, "b2b")];
  const s21a = await session(b2.id, c21.id, 8, 15_000);
  await pay(b2.id, s21a.id, u1);
  await pay(b2.id, s21a.id, u2, "LATE");
  check(
    "Fixtures: two branches with FIXED and PERCENTAGE cuts, a refund, a void, a closed session with an absence, a PAID and a DRAFT settlement",
    refunded3.ok && voided5.ok && p1.teacherShareSnapshot === 9_000 && p4.teacherShareSnapshot === 15_000,
    JSON.stringify({ refund: refunded3.ok, void: voided5.ok, p1: p1.teacherShareSnapshot, p4: p4.teacherShareSnapshot }),
  );

  const branchSource = (branch: { id: string; name: string }, floor: Date | null): EarningsSource => ({
    kind: "BRANCH",
    centerId: branch.id,
    name: branch.name,
    timeZone: TZ,
    floor,
    withSettlements: true,
  });
  const thirty = parseEarningsPeriod({ range: "30d" });
  const branchesOnly = await teacherEarnings(prisma, teacher.id, [branchSource(b1, null), branchSource(b2, null)], thirty, now);
  const branchRevenueBefore = JSON.stringify(await revenueTotals(prisma, b1.id, { from: null, to: null }));
  const branchByTeacherBefore = JSON.stringify(await revenueByTeacher(prisma, b1.id, { from: null, to: null }));
  const rollupBefore = JSON.stringify(await revenueTotalsRollup(prisma, (await organizationBranches(prisma, b1.organizationId)).map((row) => row.id), { from: null, to: null }));
  const platformSessionsBefore = await platformSessionCount(prisma);
  const settlementsBefore = JSON.stringify(
    await prisma.settlement.findMany({ where: { centerId: b1.id }, orderBy: { id: "asc" }, select: { id: true, status: true, totalAmount: true, claims: { select: { paymentId: true, teacherShare: true, releasedAt: true } } } }),
  );

  // The workspace: 120 EGP sessions, the cut forced to 0 (teacher = amount).
  const created = await createWorkspace(prisma, teacher.id, { name: "Earnings workspace" });
  check("A workspace for the teacher who also teaches at both branches", created.ok);
  if (!created.ok) return null;
  const ws = created.workspaceId;
  const wsClass = await createWorkspaceClass(
    prisma,
    teacher.id,
    ws,
    {
      educationSystemId: null,
      gradeId: fx.gradeId,
      subjectId: fx.subjectId,
      price: 12_000,
      lateThresholdMinutes: 10,
      startDate: today,
      endDate: addDays(today, 27),
      slots: [{ dayOfWeek: addDays(today, 1).getUTCDay(), startTime: "16:00", endTime: "18:00" }],
    },
    { confirmConflicts: true, locale: "en" },
  );
  const wcId = wsClass.ok ? wsClass.classGroupId : "";
  const [w1, w2, w3] = [await learner(ws, "wa"), await learner(ws, "wb"), await learner(ws, "wc")];
  const sw1 = await session(ws, wcId, 2, 12_000);
  const q1 = await pay(ws, sw1.id, w1);
  const q2 = await pay(ws, sw1.id, w2);
  const refundedQ2 = await refundIt(ws, q2.id);
  const sw2 = await session(ws, wcId, 20, 12_000);
  await pay(ws, sw2.id, w1);
  const q4 = await pay(ws, sw2.id, w3);
  const voidedQ4 = await voidIt(ws, q4.id);
  const sw3 = await session(ws, wcId, 45, 12_000);
  await pay(ws, sw3.id, w1);
  check(
    "Workspace payments are frozen at 120 EGP with centre 0 and teacher = amount (lib/money.ts on the forced cut)",
    wsClass.ok && refundedQ2.ok && voidedQ4.ok && q1.amount === 12_000 && q1.centerShareSnapshot === 0 && q1.teacherShareSnapshot === 12_000,
  );

  const sources = [branchSource(b1, null), branchSource(b2, null), ...(await ownedWorkspaceSources(prisma, teacher.id, 0, now))];
  const result = await teacherEarnings(prisma, teacher.id, sources, thirty, now);
  const [e1, e2, ew] = result.sources;
  const from30 = days(29);

  // ── 15a. Totals equal the raw sum of snapshots, per source and per class ──
  for (const [label, entry, centerId] of [["Branch one", e1, b1.id], ["Branch two", e2, b2.id], ["The workspace", ew, ws]] as const) {
    const raw = await rawMoney(centerId, teacher.id, from30, today);
    const classesMatch = [...raw.byClass.entries()].every(([key, row]) => {
      const line = entry.classes.find((candidate) => (candidate.classGroupId ?? "") === key);
      return line !== undefined && line.teacherShare === row.gross && line.refunds === row.refunds && line.net === row.gross - row.refunds && line.paidSessions === row.sessions.size;
    });
    check(
      `${label}: gross, refunds, net, payment count and paid sessions equal the raw snapshot sums; every class line too`,
      entry.teacherShare === raw.gross && entry.refunds === raw.refunds && entry.net === raw.net && entry.paymentCount === raw.count &&
        entry.paidSessions === raw.paidSessions && classesMatch && entry.classes.filter((line) => line.paymentCount > 0).length === raw.byClass.size,
      JSON.stringify({ got: { g: entry.teacherShare, r: entry.refunds, n: entry.net, c: entry.paymentCount, s: entry.paidSessions }, raw: { g: raw.gross, r: raw.refunds, n: raw.net, c: raw.count, s: raw.paidSessions } }),
    );
    const attendance = await rawAttendance(centerId, teacher.id, from30, today);
    check(`${label}: present, late and absent equal the roster rule over the raw rows`, JSON.stringify(entry.attendance) === JSON.stringify(attendance), `${JSON.stringify(entry.attendance)} vs ${JSON.stringify(attendance)}`);
  }
  check(
    "The figures match the fixture exactly: branch one 420 gross − 90 refunded = 330; branch two 270; the workspace 360 − 120 = 240; collected 840",
    e1.teacherShare === 42_000 && e1.refunds === 9_000 && e1.net === 33_000 && e2.net === 27_000 && ew.teacherShare === 36_000 && ew.refunds === 12_000 &&
      ew.net === 24_000 && result.summary.collected === 84_000,
    JSON.stringify({ b1: [e1.teacherShare, e1.refunds, e1.net], b2: e2.net, ws: [ew.teacherShare, ew.refunds, ew.net], collected: result.summary.collected }),
  );
  check(
    "Voided payments are excluded (branch one's 150 EGP void and the workspace's 120 EGP void never count)",
    e1.paymentCount === 4 && ew.paymentCount === 3 && !e1.classes.some((line) => line.teacherShare === 30_000),
  );
  check(
    "Refunds are their own line and the net is gross − refunds, never netted silently (per source and in the summary)",
    e1.refunds === 9_000 && e1.net === e1.teacherShare - e1.refunds && result.summary.branches.refunds === 9_000 && result.summary.workspaces.refunds === 12_000 &&
      result.summary.collected === result.summary.branches.net + result.summary.workspaces.net,
  );
  check(
    "Present 4, late 1, absent 1 at branch one (the absence counts on the closed session; a voided student stays present)",
    e1.attendance.present === 4 && e1.attendance.late === 1 && e1.attendance.absent === 1 && e1.paidSessions === 2,
    JSON.stringify(e1.attendance),
  );
  check(
    "The 90-day period reaches the 60- and 45-day-old payments: collected 1050",
    (await teacherEarnings(prisma, teacher.id, sources, parseEarningsPeriod({ range: "90d" }), now)).summary.collected === 105_000,
  );
  const trendTotal = result.summary.trend.reduce((sum, row) => sum + row.teacherShare - row.refunds, 0);
  check("The weekly trend adds up to the collected figure (one row per Sunday-start week)", trendTotal === result.summary.collected && result.summary.trend.every((row) => new Date(`${row.weekStart}T00:00:00Z`).getUTCDay() === 0));

  // ── 15b. Branch paid out / not yet paid out; workspace collected only ────
  check(
    "Branch one: paid out = the PAID settlement's live claims (180), not yet paid out = net − paid out (150, the DRAFT's claim included)",
    e1.settlement?.paidOut === 18_000 && e1.settlement?.notPaidOut === 15_000 && e2.settlement?.paidOut === 0 && e2.settlement?.notPaidOut === 27_000,
    JSON.stringify([e1.settlement, e2.settlement]),
  );
  check(
    "The workspace has no settlement figure, and the summary's not-yet-paid-out sums branches only",
    ew.settlement === null && result.summary.branches.notPaidOut === 42_000 && result.summary.branches.paidOut === 18_000,
  );
  check(
    "The branch figures are identical with and without the workspace's payments (same fixtures, before and after)",
    JSON.stringify(result.sources.slice(0, 2)) === JSON.stringify(branchesOnly.sources) &&
      JSON.stringify(result.summary.branches) === JSON.stringify(branchesOnly.summary.branches),
  );
  const month = monthRangeUtc(today);
  const summary1 = await teacherCenterSummary(prisma, b1.id, teacher.id, today, weekRangeUtc(today), { from: month.start, to: month.end });
  const monthEarnings = await sourceEarnings(prisma, branchSource(b1, null), teacher.id, parseEarningsPeriod({ range: "month" }), now);
  check(
    "The dashboard's own per-branch figure (teacherCenterSummary, unchanged) equals Earnings' net for the same month",
    summary1.earnings.teacherShare === monthEarnings.net,
    `${summary1.earnings.teacherShare} vs ${monthEarnings.net}`,
  );
  check(
    "Reading Earnings changes no settlement or claim",
    JSON.stringify(
      await prisma.settlement.findMany({ where: { centerId: b1.id }, orderBy: { id: "asc" }, select: { id: true, status: true, totalAmount: true, claims: { select: { paymentId: true, teacherShare: true, releasedAt: true } } } }),
    ) === settlementsBefore,
  );
  check(
    "paidOutTeacherShare reads 0 in the workspace (it holds no settlement) and Earnings never asks it there (static)",
    (await paidOutTeacherShare(prisma, ws, teacher.id, { from: null, to: null })) === 0 &&
      /source\.kind === "BRANCH" && source\.withSettlements \? paidOutTeacherShare\(/.test(read("lib/db/teacher-earnings.ts")),
  );

  // ── 15c. Windows: teacherHistoryDays (U6) for the teacher, clamped with a note ──
  await prisma.user.update({ where: { id: teacher.id }, data: { teacherHistoryDays: 7 } });
  await prisma.centerSettings.update({ where: { centerId: b1.id }, data: { teacherDataVisibilityDays: 3 } });
  const floor = teacherHistoryFloor(7, TZ, now);
  const windowed = [branchSource(b1, floor), branchSource(b2, floor), ...(await ownedWorkspaceSources(prisma, teacher.id, 7, now))];
  const clamped = await teacherEarnings(prisma, teacher.id, windowed, thirty, now);
  check(
    "teacherHistoryDays = 7 clamps the 30-day period at every source and the page's note gets the floor",
    clamped.summary.clampedFrom !== null && floor !== null && clamped.summary.clampedFrom.getTime() === floor.getTime() &&
      clamped.sources.every((entry) => entry.clampedFrom?.getTime() === floor.getTime() && entry.range?.start.getTime() === floor.getTime()),
  );
  check(
    "Clamped figures equal the raw sums from the floor: branch one 330 (no refund inside), branch two 0, the workspace 240 − 120",
    clamped.sources[0].net === (await rawMoney(b1.id, teacher.id, floor, today)).net && clamped.sources[0].net === 33_000 &&
      clamped.sources[1].net === 0 && clamped.sources[2].teacherShare === 24_000 && clamped.sources[2].net === 12_000,
    JSON.stringify(clamped.sources.map((entry) => entry.net)),
  );
  check(
    "The teacher's own branch read is bound by teacherHistoryDays only, never the branch's teacher window (3 days here — the 5-day-old payment still counts)",
    clamped.sources[0].classes.some((line) => line.classGroupId === c12.id && line.net === 15_000),
  );
  check(
    "The workspace source's floor is teacherHistoryDays in the workspace's own calendar",
    windowed[2].floor?.getTime() === floor?.getTime() && windowed[2].kind === "WORKSPACE" && !windowed[2].withSettlements,
  );
  check("A period inside the window is not clamped (last 7 days with a 7-day floor): no note", (await teacherEarnings(prisma, teacher.id, windowed, parseEarningsPeriod({ range: "7d" }), now)).summary.clampedFrom === null);
  const before = await teacherEarnings(prisma, teacher.id, windowed, parseEarningsPeriod({ range: "range", from: dateKey(days(70)), to: dateKey(days(50)) }), now);
  check(
    "A custom range wholly before the floor reads nothing at all and still says where the window starts",
    before.sources.every((entry) => entry.range === null && entry.net === 0) && before.summary.collected === 0 && before.summary.clampedFrom !== null,
  );
  check(
    "The period parser: the presets, a one-day custom range, a reversed range, more than a year refused (default + invalid), junk refused",
    parseEarningsPeriod({}).period === "30d" && !parseEarningsPeriod({}).invalid &&
      JSON.stringify(parseEarningsPeriod({ range: "date", date: "2026-11-02" })) === JSON.stringify({ period: "custom", from: "2026-11-02", to: "2026-11-02", invalid: false }) &&
      JSON.stringify(parseEarningsPeriod({ range: "range", from: "2026-11-09", to: "2026-11-01" })) === JSON.stringify({ period: "custom", from: "2026-11-01", to: "2026-11-09", invalid: false }) &&
      parseEarningsPeriod({ range: "range", from: "2025-01-01", to: "2026-11-01" }).invalid &&
      parseEarningsPeriod({ range: "forever" }).invalid && parseEarningsPeriod({ range: "range", from: "2026-02-30", to: "2026-03-01" }).invalid,
  );

  // ── 15d. The calendar's workspace source respects the same window ─────────
  const calendarRange = clampRangeToVisibility({ start: days(30), end: today }, floor);
  const calendarRows = await prisma.session.findMany({
    where: scopedWhere(ws, teacherSessionListWhere({ teacherId: teacher.id, from: calendarRange.start, to: calendarRange.end })),
    select: { id: true },
  });
  check(
    "The workspace's sessions for the calendar: inside the teacher's window only (the 2-day-old session, not the 20- or 45-day-old ones)",
    calendarRows.some((row) => row.id === sw1.id) && !calendarRows.some((row) => row.id === sw2.id || row.id === sw3.id),
  );
  const calendarPage = read("app/[locale]/(teacher)/teacher/calendar/page.tsx");
  check(
    "The teacher calendar adds the teacher's own workspaces under their own context, the same search, lazy close and history floor, tagged Private, no room (static)",
    /listOwnedWorkspaces\(prisma, scope\.user\.id\)/.test(calendarPage) && /getWorkspaceContext\(workspace\.id\)/.test(calendarPage) &&
      /clampRangeToVisibility\(range, teacherPortalHistoryFloor\(ctx, now\)\)/.test(calendarPage) && /closeEndedSessions\(prisma, ctx\.center\.id/.test(calendarPage) &&
      /privateClass: \{ label: t\("privateTag"\) \}/.test(calendarPage) && /room: null/.test(calendarPage) && /const perWorkspace = branchFilter/.test(calendarPage),
  );
  await prisma.user.update({ where: { id: teacher.id }, data: { teacherHistoryDays: 0 } });

  // ── 15e. The dashboard's "including workspaces" line ──────────────────────
  const monthRaw = await rawMoney(ws, teacher.id, month.start, month.end);
  check(
    "The dashboard's workspace half equals the raw net of this month's workspace payments",
    (await workspacesCollectedThisMonth(prisma, teacher.id, await ownedWorkspaceSources(prisma, teacher.id, 0, now), now)) === monthRaw.net,
  );
  const dashboard = read("app/[locale]/(teacher)/teacher/dashboard/page.tsx");
  check(
    "The dashboard keeps its branch figures and adds one combined collected line only when the teacher owns a workspace (static)",
    /formatMoney\(visibleEarnings \+ workspaceMonth, locale\)/.test(dashboard) && /workspaceSources\.length > 0 \?/.test(dashboard) &&
      /teacherCenterSummary\(\s*prisma,\s*centerCtx\.center\.id,/.test(dashboard),
  );

  // ── 15f. Centre-side reads never include a workspace ──────────────────────
  check(
    "The branch's own revenue, its by-teacher breakdown and its organization roll-up are unchanged by the workspace's payments",
    JSON.stringify(await revenueTotals(prisma, b1.id, { from: null, to: null })) === branchRevenueBefore &&
      JSON.stringify(await revenueByTeacher(prisma, b1.id, { from: null, to: null })) === branchByTeacherBefore &&
      JSON.stringify(await revenueTotalsRollup(prisma, (await organizationBranches(prisma, b1.organizationId)).map((row) => row.id), { from: null, to: null })) === rollupBefore,
  );
  const personalOrg = await prisma.center.findUniqueOrThrow({ where: { id: ws }, select: { organizationId: true } });
  check(
    "No centre-side list reaches the workspace: the personal organization has no branch, the accessible centres and the platform session count leave it out",
    (await organizationBranches(prisma, personalOrg.organizationId)).length === 0 &&
      !(await listAccessibleCenters(prisma)).some((row) => row.id === ws) &&
      (await platformSessionCount(prisma)) === platformSessionsBefore,
  );
  check(
    "The centre dashboard and Analytics read their branch context's own id; Analytics' roll-up takes branch ids only (static)",
    /revenueTotals\(prisma, ctx\.center\.id, todayRange\)/.test(read("app/[locale]/(center)/dashboard/page.tsx")) &&
      /revenueTotalsRollup\(prisma, rollupBranchIds/.test(read("app/[locale]/(center)/analytics/page.tsx")),
  );

  // ── 15g. No student data, and no recomputation ───────────────────────────
  const payload = JSON.stringify(result);
  check(
    "The Earnings result names sources and classes only: no student id, code or name",
    ![st1, st2, st3, u1, u2, w1, w2, w3].some((id) => payload.includes(id)) && !payload.includes(`${STEM}-earn-`) && !payload.includes(`${STEM}-E`),
  );
  const earningsSource = read("lib/db/teacher-earnings.ts");
  check(
    "Earnings sums only frozen snapshots through the sum helpers: no cut, no price, no split recomputed (static)",
    /revenueTotals\(db, source\.centerId/.test(earningsSource) && /refundTotals\(db, source\.centerId/.test(earningsSource) &&
      !/splitShare|centerShareValue|centerShareType|priceSnapshot|\.price\b|Math\.round/.test(earningsSource.replace(/\/\*[\s\S]*?\*\//g, "")),
  );
  const teacherPage = read("app/[locale]/(teacher)/teacher/earnings/page.tsx");
  check(
    "The teacher's page: branches only where analytics.own.view holds, workspaces the teacher owns, paid-out at branches only (static)",
    /\.filter\(\(ctx\) => ctxCan\(ctx, "analytics\.own\.view"\)\)/.test(teacherPage) && /ownedWorkspaceSources\(prisma, user\.id, user\.teacherHistoryDays, now\)/.test(teacherPage) &&
      (teacherPage.match(/withSettlements: true/g) ?? []).length === 1 && /teacherPortalHistoryFloor\(\{ user, settings: ctx\.settings \}, now\)/.test(teacherPage),
  );
  return { teacher, ws, wcId, b1, b2, c12Id: c12.id, sw1Id: sw1.id };
}

// ── 16. W8d: assistants in the teacher's workspaces (D-W41 items 9–12) ──────

async function workspaceAssistants(fx: W8dFixture & { earnings: NonNullable<Awaited<ReturnType<typeof workspaceEarnings>>>; ownerB: FixtureUser }) {
  const { today } = fx;
  const { teacher, ws, wcId, b1 } = fx.earnings;
  console.log("\n16. W8d: assistants in workspaces — the matrix, the intersection, windows, phones, audit both ids, never more");
  const at = (minute: number) => cairoAt(today, 8, minute);
  const options = { confirmConflicts: true, locale: "en", now: cairoAt(today, 7) };

  // Students enrolled in the workspace class, and today's 08:00 session.
  const enrolled: string[] = [];
  for (const tag of ["x1", "x2", "x3", "x4"]) {
    const added = await addWorkspaceStudent(prisma, teacher.id, ws, { ...PLACEHOLDER(tag), phone: freshPhone(), gradeId: null }, { now: options.now });
    if (added.ok) {
      await enrolWorkspaceStudent(prisma, teacher.id, ws, wcId, added.studentProfileId, options.now);
      enrolled.push(added.studentProfileId);
    }
  }
  const live = await createWorkspaceSession(prisma, teacher.id, ws, { kind: "extra", classGroupId: wcId, date: today, startTime: "08:00", endTime: "09:00" }, options);
  const sessionId = live.ok ? live.sessionId : "";
  check("Fixtures: four enrolled workspace students and today's 08:00 session", enrolled.length === 4 && Boolean(sessionId));
  const [x1, x2, x3, x4] = enrolled;

  const linkWith = async (tag: string, permissions: string[], preset: "GRADER" | "CO_TEACHER" | "FULL" = "CO_TEACHER") => {
    const assistant = await makeUser(`ws-assistant-${tag}`);
    const link = await prisma.teacherAssistant.create({ data: { teacherUserId: teacher.id, assistantUserId: assistant.id, preset } });
    if (permissions.length > 0) await prisma.assistantPermissionGrant.createMany({ data: permissions.map((permission) => ({ assistantId: link.id, permission })) });
    return { assistant, linkId: link.id };
  };
  const co = await linkWith("co", [...PRESET_PERMISSIONS.CO_TEACHER]);
  const full = await linkWith("full", [...PRESET_PERMISSIONS.FULL], "FULL");
  const grader = await linkWith("grader", [...PRESET_PERMISSIONS.GRADER], "GRADER");
  const checkinOnly = await linkWith("checkin", ["checkin.workspace"]);
  const payOnly = await linkWith("pay", ["payments.workspace"]);
  const phones = await linkWith("phones", ["classes.view", "students.phones"]);
  const as = (assistant: FixtureUser) => ({ actorUserId: assistant.id, teacherUserId: teacher.id });
  const actingOf = (assistant: FixtureUser, now: Date = at(1)) => resolveAssistantActing(prisma, { assistantUserId: assistant.id, teacherUserId: teacher.id, now });

  // ── 16a. The resolver's second source, and the decision per key ─────────
  const coActing = await actingOf(co.assistant);
  check(
    "The resolver returns the teacher's own workspace (from the teacher's id), beside the branches",
    coActing !== null && coActing.workspaces.length === 1 && coActing.workspaces[0].centerId === ws && coActing.workspaces[0].teacherMembershipId !== null &&
      coActing.branches.some((branch) => branch.centerId === b1.id),
  );
  // W9 old → new (C, approved in the W9 follow-up, D-W42): Co-teacher and Full gain both assessment
  // keys in a workspace, Grader gains assessments.review; the other three rows are unchanged.
  const matrix: [string, FixtureUser, string[]][] = [
    ["Co-teacher", co.assistant, ["assessments.review", "assessments.manage", "classes.view", "checkin.workspace", "payments.workspace"]],
    ["Full", full.assistant, ["assessments.review", "assessments.manage", "classes.view", "checkin.workspace", "payments.workspace", "analytics.view"]],
    ["Grader", grader.assistant, ["assessments.review"]],
    ["check-in only", checkinOnly.assistant, ["checkin.workspace"]],
    ["payments only", payOnly.assistant, ["payments.workspace"]],
    ["classes + phones", phones.assistant, ["classes.view", "students.phones"]],
  ];
  for (const [label, assistant, allowed] of matrix) {
    const acting = await actingOf(assistant);
    const got = ASSISTANT_PERMISSIONS.filter((permission) => assistantCan(acting, permission, ws));
    check(`${label}: assistantCan in the workspace grants exactly ${allowed.join(", ") || "nothing"}`, got.join() === allowed.join(), got.join());
  }
  // W9 old → new (D, approved in the W9 follow-up, D-W42): the assessment keys now act in a workspace.
  check(
    "The workspace keys still grant nothing at a branch, and requests.manage nothing in a workspace",
    !assistantCan(coActing, "checkin.workspace", b1.id) && !assistantCan(coActing, "payments.workspace", b1.id) &&
      !assistantCan(coActing, "requests.manage", ws),
  );

  // ── 16b. Writes, allowed: Co-teacher checks in and records a payment as the teacher ──
  const auditBefore = await prisma.auditLog.count({ where: { centerId: ws, actorUserId: co.assistant.id } });
  const in1 = await workspaceCheckIn(prisma, as(co.assistant), ws, { sessionId, studentProfileId: x1 }, at(2));
  const attendee1 = in1.ok ? in1.attendee.id : "missing";
  const paid1 = await workspaceRecordPayment(prisma, as(co.assistant), ws, { attendeeId: attendee1 }, at(3));
  check(
    "Co-teacher checks a student in (Present) and records the payment at the session's price, frozen, centre 0, teacher = amount, the teacher's payment",
    in1.ok && in1.attendee.attendanceStatus === "PRESENT" && paid1.ok && paid1.payment.amount === 12_000 && paid1.payment.centerShareSnapshot === 0 &&
      paid1.payment.teacherShareSnapshot === 12_000 && paid1.payment.teacherId === teacher.id && paid1.payment.recordedBy === co.assistant.id,
    JSON.stringify({ in1: errorOf(in1), paid1: errorOf(paid1) }),
  );
  const voided1 = paid1.ok ? await workspaceVoidPayment(prisma, as(co.assistant), ws, { paymentId: paid1.payment.id, reason: "Wrong student" }, at(4)) : null;
  const again1 = await workspaceCheckIn(prisma, as(co.assistant), ws, { sessionId, studentProfileId: x1 }, at(5));
  const paid1b = await workspaceRecordPayment(prisma, as(co.assistant), ws, { attendeeId: attendee1 }, at(6));
  const refunded1 = paid1b.ok ? await workspaceRefundPayment(prisma, as(co.assistant), ws, { paymentId: paid1b.payment.id, reason: "Left early" }, at(7)) : null;
  const corrected = await workspaceCheckIn(prisma, as(co.assistant), ws, { sessionId, studentProfileId: x2 }, at(8));
  const late2 = await workspaceSetAttendance(prisma, as(co.assistant), ws, { sessionId, studentProfileId: x2, status: "LATE" }, at(9));
  check(
    "Co-teacher voids (with the T5 reset), re-checks in, pays again, refunds, and corrects a mark — each through the unchanged engine",
    voided1 !== null && voided1.ok && again1.ok && paid1b.ok && refunded1 !== null && refunded1.ok && corrected.ok && late2.ok,
    JSON.stringify([voided1, again1, paid1b, refunded1, corrected, late2].map(errorOf)),
  );
  // check-in only: may check in and correct, never pay; payments only: may pay, never check in.
  const inX3 = await workspaceCheckIn(prisma, as(checkinOnly.assistant), ws, { sessionId, studentProfileId: x3 }, at(10));
  const x3Attendee = inX3.ok ? inX3.attendee.id : "missing";
  const checkinPays = await workspaceRecordPayment(prisma, as(checkinOnly.assistant), ws, { attendeeId: x3Attendee }, at(11));
  const payOnlyIn = await workspaceCheckIn(prisma, as(payOnly.assistant), ws, { sessionId, studentProfileId: x4 }, at(11));
  const payOnlyPays = await workspaceRecordPayment(prisma, as(payOnly.assistant), ws, { attendeeId: x3Attendee }, at(12));
  const absentByCheckinOnly = await workspaceSetAttendance(
    prisma,
    as(checkinOnly.assistant),
    ws,
    { sessionId, studentProfileId: x3, status: "ABSENT", reason: "Went home", confirmVoid: true },
    at(13),
  );
  check(
    "The intersection per key: check-in only checks in but cannot pay (forbidden); payments only pays but cannot check in (forbidden); the Absent switch on a paid student needs payments too (forbidden)",
    inX3.ok && refusedWith(checkinPays, "forbidden") && refusedWith(payOnlyIn, "forbidden") && payOnlyPays.ok && refusedWith(absentByCheckinOnly, "forbidden"),
    JSON.stringify([inX3, checkinPays, payOnlyIn, payOnlyPays, absentByCheckinOnly].map(errorOf)),
  );
  const paidX3 = payOnlyPays.ok ? payOnlyPays.payment.id : "missing";

  // ── 16c. Every key × every action refused where not granted ──────────────
  // `only` runs just the refused half for an assistant holding the other key:
  // the half its key allows would really write (and close the session).
  const everyAction = async (
    actor: { actorUserId: string; teacherUserId: string },
    workspaceId = ws,
    minute = 14,
    only: "money" | "attendance" | null = null,
  ) => {
    const attendance = only === "money" ? [] : [
      () => workspaceCheckIn(prisma, actor, workspaceId, { sessionId, studentProfileId: x4 }, at(minute)),
      () => workspaceSetAttendance(prisma, actor, workspaceId, { sessionId, studentProfileId: x2, status: "PRESENT" }, at(minute)),
    ];
    const money = only === "attendance" ? [] : [
      () => workspaceRecordPayment(prisma, actor, workspaceId, { attendeeId: x3Attendee }, at(minute)),
      () => workspaceVoidPayment(prisma, actor, workspaceId, { paymentId: paidX3, reason: "x" }, at(minute)),
      () => workspaceRefundPayment(prisma, actor, workspaceId, { paymentId: paidX3, reason: "x" }, at(minute)),
    ];
    const close = only === "money" ? [] : [() => workspaceCloseSession(prisma, actor, workspaceId, { sessionId }, at(minute))];
    const results: { ok: boolean }[] = [];
    for (const run of [...attendance, ...money, ...close]) results.push(await run());
    return results;
  };
  const paymentsBefore = await prisma.payment.count({ where: { centerId: ws } });
  const attendanceBefore = JSON.stringify(await prisma.sessionAttendee.findMany({ where: { centerId: ws, sessionId }, orderBy: { id: "asc" }, select: { id: true, attendanceStatus: true } }));
  const refusalCases: [string, { actorUserId: string; teacherUserId: string }, string, string | null][] = [
    ["Grader (no workspace key)", as(grader.assistant), "forbidden", null],
    ["classes.view + phones (read only)", as(phones.assistant), "forbidden", null],
    ["check-in only, on the money", as(checkinOnly.assistant), "forbidden", "money"],
    ["payments only, on attendance", as(payOnly.assistant), "forbidden", "attendance"],
    ["a swapped teacher (Co-teacher for B)", { actorUserId: co.assistant.id, teacherUserId: fx.ownerB.id }, "notFound", null],
    ["the assistant as themselves", { actorUserId: co.assistant.id, teacherUserId: co.assistant.id }, "notFound", null],
  ];
  for (const [label, actor, error, only] of refusalCases) {
    const results = await everyAction(actor, ws, 14, only as "money" | "attendance" | null);
    check(
      `${label}: refused (${error})`,
      results.length === (only === "money" ? 3 : only === "attendance" ? 3 : 6) && results.every((result) => refusedWith(result, error)),
      JSON.stringify(results.map(errorOf)),
    );
  }
  const otherWs = await createWorkspace(prisma, fx.ownerB.id, { name: "B's own" });
  const otherTeachers = otherWs.ok ? await everyAction(as(co.assistant), otherWs.workspaceId) : [];
  check("Another teacher's workspace by id: every write notFound", otherTeachers.length === 6 && otherTeachers.every((result) => refusedWith(result, "notFound")), JSON.stringify(otherTeachers.map(errorOf)));
  check(
    "Nothing moved on any refusal: payments and the roster unchanged",
    (await prisma.payment.count({ where: { centerId: ws } })) === paymentsBefore &&
      JSON.stringify(await prisma.sessionAttendee.findMany({ where: { centerId: ws, sessionId }, orderBy: { id: "asc" }, select: { id: true, attendanceStatus: true } })) === attendanceBefore,
  );

  // ── 16d. Premium lapsed, archived, the teacher's own membership, the link removed ──
  await setPremium(teacher.id, addDays(today, -2));
  const lapsed = await everyAction(as(co.assistant));
  check("The teacher's premium lapsed: the link is not effective and every write is notFound", lapsed.every((result) => refusedWith(result, "notFound")), JSON.stringify(lapsed.map(errorOf)));
  await setPremium(teacher.id, inDays(30));
  await prisma.center.update({ where: { id: ws }, data: { archivedAt: new Date(), archivedByUserId: teacher.id } });
  const archived = await everyAction(as(co.assistant));
  check("The workspace archived: every write answers workspaceArchived (assertWorkspaceWritable)", archived.every((result) => refusedWith(result, "workspaceArchived")), JSON.stringify(archived.map(errorOf)));
  await prisma.center.update({ where: { id: ws }, data: { archivedAt: null, archivedByUserId: null } });
  await prisma.membership.updateMany({ where: { centerId: ws, userId: teacher.id }, data: { active: false } });
  const noCapability = await everyAction(as(co.assistant));
  const capabilityActing = await actingOf(co.assistant);
  check(
    "The teacher's own capability gone (their workspace membership inactive): the grant alone allows nothing (forbidden) — the intersection",
    noCapability.every((result) => refusedWith(result, "forbidden")) && !assistantCan(capabilityActing, "checkin.workspace", ws) && !assistantCan(capabilityActing, "classes.view", ws),
    JSON.stringify(noCapability.map(errorOf)),
  );
  await prisma.membership.updateMany({ where: { centerId: ws, userId: teacher.id }, data: { active: true } });
  await prisma.teacherAssistant.update({ where: { id: checkinOnly.linkId }, data: { revokedAt: new Date() } });
  const removed = await everyAction(as(checkinOnly.assistant));
  check("The link removed: every write notFound, and the resolver finds nothing", removed.every((result) => refusedWith(result, "notFound")) && (await actingOf(checkinOnly.assistant)) === null);

  // ── 16e. The window: teacherHistoryDays only in a workspace ──────────────
  await prisma.user.update({ where: { id: teacher.id }, data: { teacherHistoryDays: 7 } });
  const windowedActing = await actingOf(full.assistant);
  const wsFloor = windowedActing ? assistantWorkspaceFloor(windowedActing, windowedActing.workspaces[0]) : null;
  const b1Branch = windowedActing?.branches.find((branch) => branch.centerId === b1.id);
  const b1Floor = windowedActing && b1Branch ? assistantFloorAt(windowedActing, b1Branch) : null;
  check(
    "The assistant's floors: in the workspace the teacher's teacherHistoryDays only (7 days); at branch one the stricter of its 3-day teacher window and 7 days (3 days)",
    wsFloor !== null && dateKey(wsFloor) === dateKey(addDays(today, -7)) && b1Floor !== null && dateKey(b1Floor) === dateKey(addDays(today, -3)),
    JSON.stringify({ ws: wsFloor && dateKey(wsFloor), b1: b1Floor && dateKey(b1Floor) }),
  );
  const old = await prisma.session.create({ data: scopedData(ws, { classGroupId: wcId, teacherId: teacher.id, date: addDays(today, -10), startTime: "10:00", endTime: "11:00", priceSnapshot: 12_000 }) });
  const oldWrite = await workspaceCloseSession(prisma, as(co.assistant), ws, { sessionId: old.id }, at(20));
  const oldTeacher = await workspaceCloseSession(prisma, { actorUserId: teacher.id, teacherUserId: teacher.id }, ws, { sessionId: old.id }, at(20));
  check(
    "A session before the assistant's floor is not theirs to act on (notFound); the teacher's own write has no floor — it reaches the engine, which answers for the ended day (alreadyClosed)",
    refusedWith(oldWrite, "notFound") && refusedWith(oldTeacher, "alreadyClosed"),
    JSON.stringify([errorOf(oldWrite), errorOf(oldTeacher)]),
  );
  // Full's Earnings: the same reads, the assistant's floors, no paid-out figure.
  if (windowedActing && b1Branch) {
    const assistantSources: EarningsSource[] = [
      { kind: "BRANCH", centerId: b1.id, name: b1.name, timeZone: TZ, floor: b1Floor, withSettlements: false },
      { kind: "WORKSPACE", centerId: ws, name: "Earnings workspace", timeZone: TZ, floor: wsFloor, withSettlements: false },
    ];
    const seen = await teacherEarnings(prisma, teacher.id, assistantSources, parseEarningsPeriod({ range: "30d" }), new Date());
    const rawB1 = await rawMoney(b1.id, teacher.id, b1Floor, today);
    check(
      "Full's Earnings: branch one from its 3-day floor equals the raw sum there (the 5-day-old payment hidden), no settlement figure at all",
      seen.sources[0].net === rawB1.net && seen.sources[0].net === 18_000 && seen.sources.every((entry) => entry.settlement === null) &&
        seen.summary.branches.paidOut === null && seen.summary.branches.notPaidOut === null,
      JSON.stringify({ net: seen.sources[0].net, raw: rawB1.net }),
    );
  }
  await prisma.user.update({ where: { id: teacher.id }, data: { teacherHistoryDays: 0 } });
  const coNow = await actingOf(co.assistant);
  const fullNow = await actingOf(full.assistant);
  check(
    "Earnings is Full only: Co-teacher holds analytics.view nowhere (its page answers 404), Full holds it in the workspace and at the branches",
    coNow !== null && !assistantCan(coNow, "analytics.view", ws) && !coNow.branches.some((branch) => assistantCan(coNow, "analytics.view", branch.centerId)) &&
      fullNow !== null && assistantCan(fullNow, "analytics.view", ws) && assistantCan(fullNow, "analytics.view", b1.id),
  );
  const assistantEarningsPage = read("app/[locale]/(assistant)/assistant/[teacherId]/earnings/page.tsx");
  check(
    "The assistant's Earnings page: analytics.view sources only, a 404 without any, never a paid-out figure (static)",
    /scopeBranches\(scope, "analytics\.view"\)/.test(assistantEarningsPage) && /scopeWorkspaces\(scope, "analytics\.view"\)/.test(assistantEarningsPage) &&
      /if \(branches\.length === 0 && workspaces\.length === 0\) notFound\(\);/.test(assistantEarningsPage) &&
      (assistantEarningsPage.match(/withSettlements: false/g) ?? []).length === 2 && !/withSettlements: true/.test(assistantEarningsPage),
  );

  // ── 16f. Phones hidden unless students.phones ────────────────────────────
  const session = { id: sessionId, classGroupId: wcId, closedAt: null };
  const hidden = await workspaceSessionRoster(prisma, ws, session, false);
  const shown = await workspaceSessionRoster(prisma, ws, session, false, { withPhones: true });
  const classHidden = await assistantWorkspaceClassRoster(prisma, ws, wcId, { withPhones: false });
  const classShown = await assistantWorkspaceClassRoster(prisma, ws, wcId, { withPhones: true });
  check(
    "Rosters carry no phone by default (not even selected) and the stored phone only when asked (students.phones)",
    hidden.length === 4 && hidden.every((row) => !("phone" in row)) && shown.every((row) => typeof row.phone === "string" && row.phone.startsWith("+20")) &&
      classHidden.every((row) => !("phone" in row)) && classShown.length === 4 && classShown.every((row) => typeof row.phone === "string"),
  );
  check(
    "Only the classes + phones assistant may see them; Co-teacher and Full may not",
    assistantCan(await actingOf(phones.assistant), "students.phones", ws) && !assistantCan(coNow, "students.phones", ws) && !assistantCan(fullNow, "students.phones", ws),
  );
  const sessionPage = read("app/[locale]/(assistant)/assistant/[teacherId]/workspaces/[id]/sessions/[sessionId]/page.tsx");
  const classPage = read("app/[locale]/(assistant)/assistant/[teacherId]/workspaces/[id]/classes/[classId]/page.tsx");
  check(
    "The assistant's session and class pages read phones only behind scopeCan(…, \"students.phones\") (static)",
    /const withPhones = scopeCan\(scope, "students\.phones", centerId\);[\s\S]*workspaceSessionRoster\(prisma, centerId, session, readOnly, \{ withPhones \}\)/.test(sessionPage) &&
      /const withPhones = scopeCan\(scope, "students\.phones", workspace\.centerId\);[\s\S]*assistantWorkspaceClassRoster\(prisma, workspace\.centerId, row\.id, \{ withPhones \}\)/.test(classPage),
  );

  // ── 16g. Audit: actor = the assistant, onBehalfOf = the teacher, ids only ──
  const assistantRows = await prisma.auditLog.findMany({ where: { centerId: ws, actorUserId: { in: [co.assistant.id, payOnly.assistant.id, checkinOnly.assistant.id] } } });
  const actions = new Set(assistantRows.map((row) => row.action));
  check(
    "The assistant's writes audit with the teacher's own action names: payment.record, payment.void, payment.refund, attendance.correct",
    ["payment.record", "payment.void", "payment.refund", "attendance.correct"].every((action) => actions.has(action)) && assistantRows.length > auditBefore,
    [...actions].join(", "),
  );
  check(
    "Every one of them: actor = the assistant, onBehalfOf = the teacher, ids and amounts only",
    assistantRows.length > 0 && assistantRows.every((row) => row.onBehalfOfUserId === teacher.id && forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null),
  );
  const closeByCo = await workspaceCloseSession(prisma, as(co.assistant), ws, { sessionId }, at(40));
  const closeRow = await prisma.auditLog.findFirst({ where: { centerId: ws, action: "session.close", entityId: sessionId } });
  check(
    "Co-teacher ends the session: session.close audited with both people",
    closeByCo.ok && closeRow !== null && closeRow.actorUserId === co.assistant.id && closeRow.onBehalfOfUserId === teacher.id,
    errorOf(closeByCo),
  );
  // The teacher's own rows here: workspace.create, classGroup.create, workspace.student.add, the session writes.
  const ownRows = await prisma.auditLog.findMany({ where: { centerId: ws, actorUserId: teacher.id } });
  check(
    "The teacher's own workspace rows stay on behalf of no one",
    ownRows.length >= 3 && ownRows.every((row) => row.onBehalfOfUserId === null),
    `${ownRows.length} rows`,
  );

  // ── 16h. Never: workspace creation, students, classes, sessions, settings, settlements ──
  const classInput = { educationSystemId: null, gradeId: fx.gradeId, subjectId: fx.subjectId, price: 12_000, lateThresholdMinutes: 10, startDate: today, endDate: addDays(today, 27) };
  const never = [
    await createWorkspaceClass(prisma, co.assistant.id, ws, { ...classInput, slots: [] }, options),
    await updateWorkspaceClass(prisma, co.assistant.id, ws, wcId, classInput, options),
    await setWorkspaceClassActive(prisma, co.assistant.id, ws, wcId, false, options),
    await deleteWorkspaceClass(prisma, co.assistant.id, ws, wcId),
    await createWorkspaceSession(prisma, co.assistant.id, ws, { kind: "oneOff", title: "x", price: 0, date: addDays(today, 3), startTime: "08:00", endTime: "09:00" }, options),
    await cancelWorkspaceSession(prisma, co.assistant.id, ws, sessionId),
    await renameWorkspace(prisma, co.assistant.id, ws, "Taken"),
    await archiveWorkspace(prisma, co.assistant.id, ws),
    await addWorkspaceStudent(prisma, co.assistant.id, ws, { ...PLACEHOLDER("never"), phone: freshPhone(), gradeId: null }),
    await enrolWorkspaceStudent(prisma, co.assistant.id, ws, wcId, x4),
    await removeWorkspaceEnrollment(prisma, co.assistant.id, ws, (await prisma.enrollment.findFirstOrThrow({ where: { centerId: ws, studentProfileId: x4 } })).id),
    await cancelWorkspaceInvitation(prisma, co.assistant.id, ws, x4),
  ];
  check(
    "An assistant never creates or edits a class or session, renames or archives, adds, enrols, removes or invites a student: all 12 notFound by direct call",
    never.every((result) => refusedWith(result as { ok: boolean }, "notFound")),
    JSON.stringify(never.map((result) => errorOf(result as { ok: boolean }))),
  );
  const ownWorkspace = await createWorkspace(prisma, co.assistant.id, { name: "Assistant's own" });
  check("createWorkspace makes nothing for the teacher: the assistant (not premium) is refused, and the teacher's count is unchanged", !ownWorkspace.ok && (await countActiveWorkspaces(prisma, teacher.id)) === 1);
  const settled = await prisma.$transaction((tx) => createSessionSettlement(tx, ws, sessionId, co.assistant.id));
  check("No settlement can be made of the workspace by anyone (workspaceNotSettled)", !settled.ok && settled.error === "workspaceNotSettled");
}

// ── 17. W9: exams and homework in workspaces (D-W26, D-W42) ────────────────

type W9Fixture = { today: Date; gradeId: string; subjectId: string; branchId: string };

/** A workspace context as `resolveAssessmentTeacher` reads it (what `getWorkspaceContext` builds, minus the Next runtime). */
async function workspaceAuthority(userId: string, centerId: string, experienceDenied = false) {
  const access = await resolveWorkspaceAccess(prisma, userId, centerId);
  return {
    center: { id: centerId },
    user: { id: userId },
    role: "TEACHER" as const,
    grants: {},
    experienceDenied,
    ...(access ? { workspace: access } : {}),
  };
}

function w9Question(points: number, correct = 0): DraftQuestion {
  return { text: `Q${points}`, points, options: Array.from({ length: 4 }, (_, i) => ({ text: `O${i}`, isCorrect: i === correct })) };
}

function w9Draft(type: "EXAM" | "HOMEWORK", extra: Partial<AssessmentDraft> = {}): AssessmentDraft {
  const now = Date.now();
  return {
    ...assessmentDefaults(type),
    title: type === "EXAM" ? "W9 exam" : "W9 homework",
    instructions: null,
    windowStart: type === "EXAM" ? new Date(now - 3_600_000) : null,
    windowEnd: type === "EXAM" ? new Date(now + 3 * 3_600_000) : null,
    deadline: type === "HOMEWORK" ? new Date(now + 2 * 3_600_000) : null,
    questions: [w9Question(2), w9Question(3), w9Question(5)],
    ...extra,
  };
}

async function workspaceAssessments(fx: W9Fixture) {
  const { today } = fx;
  console.log("\n17. W9: assessments in workspaces — authority, the engine, eligibility, lapse, archive, notices, assistants, audit, isolation");
  const now = new Date();
  const HOUR = 3_600_000;
  const later = (ms: number) => new Date(now.getTime() + ms);
  const options = { confirmConflicts: true, locale: "en", now };

  // ── 17a. Fixtures ──────────────────────────────────────────────────────
  const teacher = await makeUser("w9-teacher", { premium: true });
  const rival = await makeUser("w9-rival", { premium: true });
  const created = await createWorkspace(prisma, teacher.id, { name: "W9 Physics" });
  const second = await createWorkspace(prisma, teacher.id, { name: "W9 Second" });
  const rivalWs = await createWorkspace(prisma, rival.id, { name: "W9 Rival" });
  if (!created.ok || !second.ok || !rivalWs.ok) {
    check("W9 fixtures: three workspaces", false);
    return;
  }
  const ws = created.workspaceId;
  const ws2 = second.workspaceId;
  const wsRival = rivalWs.workspaceId;
  // The teacher also teaches at the branch: its assessment list must never hold a workspace row.
  await prisma.membership.create({ data: { userId: teacher.id, centerId: fx.branchId, role: "TEACHER", firstName: "W9", lastName: "Teacher", joinedAt: now } });
  const classInput = {
    educationSystemId: null,
    gradeId: fx.gradeId,
    subjectId: fx.subjectId,
    price: 10_000,
    lateThresholdMinutes: 10,
    startDate: today,
    endDate: addDays(today, 27),
    slots: [{ dayOfWeek: addDays(today, 1).getUTCDay(), startTime: "16:00", endTime: "18:00" }],
  };
  const cls = await createWorkspaceClass(prisma, teacher.id, ws, classInput, options);
  const rivalCls = await createWorkspaceClass(prisma, rival.id, wsRival, classInput, options);
  const classId = cls.ok ? cls.classGroupId : "";
  const rivalClassId = rivalCls.ok ? rivalCls.classGroupId : "";
  const today8 = await createWorkspaceSession(prisma, teacher.id, ws, { kind: "extra", classGroupId: classId, date: today, startTime: "08:00", endTime: "09:00" }, options);
  const sessionId = today8.ok ? today8.sessionId : "";

  // Students: three linked accounts (enrolled, never enrolled, leaves) and one unlinked profile.
  const linkedStudent = async (tag: string) => {
    const user = await makeUser(`w9-${tag}`);
    const phone = freshPhone();
    await prisma.user.update({ where: { id: user.id }, data: { phone, authId: `${STEM}-auth-w9-${tag}-${RUN}` } });
    const added = await addWorkspaceStudent(prisma, teacher.id, ws, { ...PLACEHOLDER(`w9${tag}`), phone, gradeId: null }, { now });
    const invitation = await prisma.workspaceInvitation.findFirst({ where: { centerId: ws, targetUserId: user.id, status: "PENDING" } });
    const accepted = invitation ? await acceptWorkspaceInvitation(prisma, user.id, invitation.id) : null;
    return { user, profileId: added.ok ? added.studentProfileId : "", linked: accepted !== null && accepted.ok };
  };
  const enrolled = await linkedStudent("enrolled");
  const unenrolled = await linkedStudent("unenrolled");
  const leaver = await linkedStudent("leaver");
  const unlinkedAdd = await addWorkspaceStudent(prisma, teacher.id, ws, { ...PLACEHOLDER("w9unlinked"), phone: freshPhone(), gradeId: null }, { now });
  const unlinkedProfileId = unlinkedAdd.ok ? unlinkedAdd.studentProfileId : "";
  const unlinkedProfile = await prisma.studentProfile.findUniqueOrThrow({ where: { id: unlinkedProfileId }, include: { user: true } });
  for (const profileId of [enrolled.profileId, leaver.profileId, unlinkedProfileId]) {
    await enrolWorkspaceStudent(prisma, teacher.id, ws, classId, profileId, now);
  }
  check(
    "W9 fixtures: a class, today's session, three linked students (one never enrolled) and one unlinked enrolled profile on a login-less placeholder",
    cls.ok && rivalCls.ok && today8.ok && enrolled.linked && unenrolled.linked && leaver.linked && unlinkedAdd.ok && unlinkedProfile.user.authId === null,
  );

  // ── 17b. Authority: workspace.assessments.manage, decided by workspaceCan ─
  const access = await resolveWorkspaceAccess(prisma, teacher.id, ws);
  check(
    "The owner holds the fixed capability workspace.assessments.manage (workspaceCan)",
    access !== null && (WORKSPACE_OWNER_CAPABILITIES as readonly string[]).includes("workspace.assessments.manage") &&
      workspaceCan({ workspace: access }, "workspace.assessments.manage"),
  );
  const owner = await resolveAssessmentTeacher(prisma, await workspaceAuthority(teacher.id, ws));
  check("The owner resolves as the assessment teacher, with the workspace membership", owner !== null && owner.centerId === ws && owner.membershipId === access?.membershipId);
  if (!owner || !access) return;
  check(
    "Nobody else resolves: another teacher, a student, a denied experience, a branch-shaped context with no grants",
    (await resolveAssessmentTeacher(prisma, await workspaceAuthority(rival.id, ws))) === null &&
      (await resolveAssessmentTeacher(prisma, await workspaceAuthority(enrolled.user.id, ws))) === null &&
      (await resolveAssessmentTeacher(prisma, await workspaceAuthority(teacher.id, ws, true))) === null &&
      (await resolveAssessmentTeacher(prisma, { center: { id: ws }, user: { id: teacher.id }, role: "TEACHER", grants: {}, experienceDenied: false })) === null,
  );
  const me = { userId: teacher.id };
  const rivalOwner = await resolveAssessmentTeacher(prisma, await workspaceAuthority(rival.id, wsRival));

  // ── 17c. The engine: defaults, validation, create, publish, locks ───────
  const invalid = await createAssessment(prisma, me, owner, {
    type: "EXAM",
    classGroupId: classId,
    draft: w9Draft("EXAM", { questions: [{ text: "Q", points: 1, options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }] }] }),
  });
  check("Validation at a workspace: two correct options are refused (invalid, multipleCorrect)", !invalid.ok && invalid.error === "invalid" && (invalid.errors ?? []).some((error) => error.code === "multipleCorrect"));
  const exam = await createAssessment(prisma, me, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") });
  const deadline = await homeworkDeadlineFor(prisma, ws, { ...(await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })), classGroupId: classId }, TZ);
  const homework = await createAssessment(prisma, me, owner, { type: "HOMEWORK", sessionId, draft: w9Draft("HOMEWORK") });
  const examRow = exam.ok ? await prisma.assessment.findUniqueOrThrow({ where: { id: exam.id } }) : null;
  const homeworkRow = homework.ok ? await prisma.assessment.findUniqueOrThrow({ where: { id: homework.id } }) : null;
  const examDefaults = assessmentDefaults("EXAM");
  const homeworkDefaults = assessmentDefaults("HOMEWORK");
  check(
    "The owner creates an exam on the class and a homework on the session, with the per-type defaults (exam: shuffle on, reveal off; homework: untimed, reveal on)",
    examRow !== null && homeworkRow !== null && examRow.status === "DRAFT" && homeworkRow.classGroupId === classId &&
      examRow.shuffle === examDefaults.shuffle && examRow.showScore === examDefaults.showScore && examRow.showCorrectAnswers === examDefaults.showCorrectAnswers &&
      homeworkRow.durationMinutes === homeworkDefaults.durationMinutes && homeworkRow.showCorrectAnswers === homeworkDefaults.showCorrectAnswers &&
      examRow.teacherMembershipId === owner.membershipId,
  );
  check("The default homework deadline at a workspace is D-W03's: the next session − 30 min", deadline.basis === "nextSession");
  if (!exam.ok || !homework.ok) return;
  const listed = await listTeacherAssessments(prisma, owner, {});
  check("The workspace list holds both, the drafts included", [exam.id, homework.id].every((id) => listed.some((row) => row.id === id)));
  check(
    "Another teacher reaches nothing: the rival's handle finds neither and cannot write them (notFound)",
    rivalOwner !== null &&
      (await findTeacherAssessment(prisma, rivalOwner, exam.id)) === null &&
      errorOf(await publishAssessment(prisma, { userId: rival.id }, rivalOwner, exam.id, now)) === "notFound" &&
      errorOf(await createAssessment(prisma, { userId: rival.id }, rivalOwner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") })) === "notFound",
  );
  check(
    "A forged handle — the teacher's membership on another workspace's id — is forbidden",
    errorOf(await publishAssessment(prisma, me, { ...owner, centerId: wsRival }, exam.id, now)) === "forbidden",
  );

  const publishedAt = now;
  const pub = await publishAssessment(prisma, me, owner, exam.id, publishedAt);
  const pubHw = await publishAssessment(prisma, me, owner, homework.id, publishedAt);
  check("Publish works at a workspace (exam and homework)", pub.ok && pubHw.ok);
  const noticesFor = (userId: string, kind: string, assessmentId: string) =>
    prisma.notification.count({ where: { userId, centerId: ws, kind: kind as "ASSESSMENT_PUBLISHED", dedupeKey: { startsWith: `assessment:${assessmentId}:` } } });
  check(
    "Publish notifies only linked enrolled students: the enrolled and the (still enrolled) leaver, never the unlinked placeholder or the unenrolled",
    (await noticesFor(enrolled.user.id, "ASSESSMENT_PUBLISHED", exam.id)) === 1 && (await noticesFor(leaver.user.id, "ASSESSMENT_PUBLISHED", exam.id)) === 1 &&
      (await noticesFor(unlinkedProfile.userId, "ASSESSMENT_PUBLISHED", exam.id)) === 0 && (await noticesFor(unenrolled.user.id, "ASSESSMENT_PUBLISHED", exam.id)) === 0,
  );
  const payloads = await prisma.notification.findMany({ where: { centerId: ws, kind: { in: ["ASSESSMENT_PUBLISHED", "ASSESSMENT_EXTENDED", "ASSESSMENT_OPENS_SOON", "ASSESSMENT_DUE_SOON"] } }, select: { payload: true } });
  check("Every workspace assessment notice carries ids only ({assessmentId})", payloads.length > 0 && payloads.every((row) => JSON.stringify(Object.keys(row.payload as object)) === '["assessmentId"]'));

  // ── 17d. Eligibility at start (D-W07, D-W42 item 3) ─────────────────────
  await prisma.$transaction((tx) => leaveClass(tx, { centerId: ws, classGroupId: classId, studentUserId: leaver.user.id, now }));
  const asStudent = async (userId: string) => resolveAssessmentStudent(prisma, ws, userId);
  const stEnrolled = await asStudent(enrolled.user.id);
  const stUnenrolled = await asStudent(unenrolled.user.id);
  const stLeaver = await asStudent(leaver.user.id);
  const stUnlinked = { centerId: ws, studentProfileId: unlinkedProfileId, userId: unlinkedProfile.userId };
  const beforeStart = stEnrolled ? await readStudentAssessment(prisma, stEnrolled, exam.id, now) : null;
  check(
    "Before starting, the linked enrolled student reads it with Start and no question and no correctness in the payload",
    beforeStart !== null && beforeStart.canStart && beforeStart.taking === null && !/isCorrect/.test(JSON.stringify(beforeStart)),
  );
  const startUnlinked = await startAttempt(prisma, stUnlinked, exam.id, now);
  const startUnenrolled = stUnenrolled ? await startAttempt(prisma, stUnenrolled, exam.id, now) : null;
  const startLeaver = stLeaver ? await startAttempt(prisma, stLeaver, exam.id, now) : null;
  check("An unlinked profile is refused at start by direct call (notEligible) — on top of the enrolment check", errorOf(startUnlinked) === "notEligible");
  check("A linked student never enrolled is refused (notEligible)", errorOf(startUnenrolled) === "notEligible");
  check("A linked student who left the class is refused (notEligible)", errorOf(startLeaver) === "notEligible");
  check(
    "The unenrolled and the leaver do not even see it in their list",
    stUnenrolled !== null && stLeaver !== null &&
      !(await listStudentAssessments(prisma, stUnenrolled, now)).some((item) => item.id === exam.id) &&
      !(await listStudentAssessments(prisma, stLeaver, now)).some((item) => item.id === exam.id),
  );
  check(
    "Another workspace: the student has no profile in the teacher's second workspace, and its id does not find this exam",
    (await resolveAssessmentStudent(prisma, ws2, enrolled.user.id)) === null &&
      errorOf(await startAttempt(prisma, { centerId: ws2, studentProfileId: enrolled.profileId, userId: enrolled.user.id }, exam.id, now)) === "notFound",
  );
  if (!stEnrolled) return;
  const started = await startAttempt(prisma, stEnrolled, exam.id, now);
  check("The linked enrolled student starts", started.ok && !started.resumed);
  if (!started.ok) return;
  const taking = await readStudentAssessment(prisma, stEnrolled, exam.id, now);
  check(
    "The taking payload (the W2 serializer) carries no correctness: no isCorrect anywhere",
    taking?.taking !== null && taking?.taking !== undefined && taking.taking.questions.length === 3 && !/isCorrect/.test(JSON.stringify(taking)),
  );
  const questions = await prisma.assessmentQuestion.findMany({ where: { assessmentId: exam.id }, include: { options: true }, orderBy: { position: "asc" } });
  const correctOf = (q: (typeof questions)[number]) => q.options.find((option) => option.isCorrect)!.id;
  const wrongOf = (q: (typeof questions)[number]) => q.options.find((option) => !option.isCorrect)!.id;
  const saved = [
    await saveAnswer(prisma, stEnrolled, started.attemptId, { questionId: questions[0].id, optionId: correctOf(questions[0]) }, later(60_000)),
    await saveAnswer(prisma, stEnrolled, started.attemptId, { questionId: questions[1].id, optionId: wrongOf(questions[1]) }, later(61_000)),
  ];
  check("Autosave works at a workspace and answers nothing about correctness", saved.every((result) => result.ok) && !/isCorrect|correct/.test(JSON.stringify(saved)));

  // ── 17e. Locks and extend ───────────────────────────────────────────────
  check(
    "After the first attempt: no edit (notDraft), no unpublish and no delete (locked)",
    errorOf(await saveAssessmentDraft(prisma, me, owner, exam.id, w9Draft("EXAM"))) === "notDraft" &&
      errorOf(await unpublishAssessment(prisma, me, owner, exam.id)) === "locked" &&
      errorOf(await deleteAssessment(prisma, me, owner, exam.id)) === "locked",
  );
  const oldEnd = examRow!.windowEnd!;
  const extended = await extendAssessment(prisma, me, owner, exam.id, new Date(oldEnd.getTime() + HOUR), later(2 * 60_000));
  check(
    "Extend works and tells the enrolled linked student with no final attempt (ASSESSMENT_EXTENDED), never the placeholder",
    extended.ok && (await noticesFor(enrolled.user.id, "ASSESSMENT_EXTENDED", exam.id)) === 1 && (await noticesFor(unlinkedProfile.userId, "ASSESSMENT_EXTENDED", exam.id)) === 0,
  );
  check("Extend only later (notLater)", errorOf(await extendAssessment(prisma, me, owner, exam.id, oldEnd, later(3 * 60_000))) === "notLater");

  // ── 17f. Premium lapse: every teacher write refused, none of the student's ─
  const draftForLapse = await createAssessment(prisma, me, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") });
  const publishedNoAttempt = await createAssessment(prisma, me, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") });
  if (publishedNoAttempt.ok) await publishAssessment(prisma, me, owner, publishedNoAttempt.id, now);
  // Lapsed before this section's `now` too: every writer reads premium at the `now` it is given.
  await setPremium(teacher.id, new Date(now.getTime() - 60_000));
  const lapsedWrites = draftForLapse.ok && publishedNoAttempt.ok
    ? [
        await createAssessment(prisma, me, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") }),
        await saveAssessmentDraft(prisma, me, owner, draftForLapse.id, w9Draft("EXAM")),
        await publishAssessment(prisma, me, owner, draftForLapse.id, now),
        await unpublishAssessment(prisma, me, owner, publishedNoAttempt.id),
        await extendAssessment(prisma, me, owner, exam.id, new Date(oldEnd.getTime() + 2 * HOUR), later(4 * 60_000)),
        await deleteAssessment(prisma, me, owner, draftForLapse.id),
      ]
    : [];
  check(
    "Premium lapsed: create, save, publish, unpublish, extend and delete are all refused (premiumRequired), nothing written",
    lapsedWrites.length === 6 && lapsedWrites.every((result) => refusedWith(result, "premiumRequired")) &&
      (await prisma.assessment.count({ where: { centerId: ws } })) === 4,
    JSON.stringify(lapsedWrites.map(errorOf)),
  );
  const lapsedSave = await saveAnswer(prisma, stEnrolled, started.attemptId, { questionId: questions[2].id, optionId: wrongOf(questions[2]) }, later(5 * 60_000));
  const lapsedSubmit = await submitAttempt(prisma, stEnrolled, started.attemptId, later(6 * 60_000));
  check("Premium lapsed: the student's autosave and submit still work (a lapse never blocks an attempt)", lapsedSave.ok && lapsedSubmit.ok && lapsedSubmit.finalisedBy === "STUDENT");
  const lapsedResults = await readAssessmentResults(prisma, me, owner, exam.id, later(7 * 60_000));
  check("Premium lapsed: the owner still reads the results (reads never need premium)", lapsedResults.ok);
  await setPremium(teacher.id, inDays(30));

  // ── 17g. Scoring frozen, results, reveal ────────────────────────────────
  const attemptRow = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  check("The score is frozen at submit: 2 of 10 (only the 2-point question right)", attemptRow.score === 2 && attemptRow.maxScore === 10);
  await prisma.assessmentQuestion.update({ where: { id: questions[0].id }, data: { points: 50 } });
  const resultsAfter = await readAssessmentResults(prisma, me, owner, exam.id, later(8 * 60_000));
  check(
    "Results read the frozen score — a later change to the question's points recomputes nothing",
    resultsAfter.ok && resultsAfter.results.students.some((row) => row.score === 2 && row.maxScore === 10),
  );
  await prisma.assessmentQuestion.update({ where: { id: questions[0].id }, data: { points: 2 } });
  const answers = await readAttemptResult(prisma, me, owner, exam.id, started.attemptId, later(8 * 60_000));
  check("The owner reads the submitted attempt's answers", answers.ok && answers.attempt.answers?.length === 3);
  check(
    "No reveal before the close, and none after it while showCorrectAnswers is off (the exam's default)",
    (await readAttemptReveal(prisma, stEnrolled, started.attemptId, later(9 * 60_000))) === null &&
      (await readAttemptReveal(prisma, stEnrolled, started.attemptId, new Date(oldEnd.getTime() + 3 * HOUR))) === null,
  );
  const hwStart = await startAttempt(prisma, stEnrolled, homework.id, later(10 * 60_000));
  if (hwStart.ok) {
    const hwQuestions = await prisma.assessmentQuestion.findMany({ where: { assessmentId: homework.id }, include: { options: true }, orderBy: { position: "asc" } });
    await saveAnswer(prisma, stEnrolled, hwStart.attemptId, { questionId: hwQuestions[0].id, optionId: hwQuestions[0].options.find((o) => o.isCorrect)!.id }, later(11 * 60_000));
  }
  const hwDeadline = homeworkRow!.deadline!;
  check(
    "Homework reveal is closed before the deadline (the attempt is not even final)",
    hwStart.ok && (await readAttemptReveal(prisma, stEnrolled, hwStart.attemptId, later(12 * 60_000))) === null,
  );
  const afterDeadline = new Date(hwDeadline.getTime() + 60_000);
  const hwList = await listStudentAssessments(prisma, stEnrolled, afterDeadline);
  const hwAttempt = hwStart.ok ? await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: hwStart.attemptId } }) : null;
  check(
    "Lazy finalisation: an untouched attempt past its deadline is finalised by the next read (DEADLINE), stamped with the deadline, scored 2 of 10",
    hwAttempt !== null && hwAttempt.finalisedBy === "DEADLINE" && hwAttempt.submittedAt?.getTime() === hwDeadline.getTime() &&
      hwAttempt.score === 2 && hwAttempt.maxScore === 10 && hwList.some((item) => item.id === homework.id && item.state === "CLOSED"),
  );
  const reveal = hwStart.ok ? await readAttemptReveal(prisma, stEnrolled, hwStart.attemptId, afterDeadline) : null;
  check("After the deadline, with showCorrectAnswers on, the reveal opens", reveal !== null && reveal.length === 3);

  // ── 17h. Notices: computed "soon", the access re-check ──────────────────
  const soonExam = await createAssessment(prisma, me, owner, {
    type: "EXAM",
    classGroupId: classId,
    draft: w9Draft("EXAM", { windowStart: later(30 * 60_000), windowEnd: later(3 * HOUR) }),
  });
  if (soonExam.ok) await publishAssessment(prisma, me, owner, soonExam.id, now);
  await syncAssessmentSoonNotices(prisma, enrolled.user.id, [ws], now);
  await syncAssessmentSoonNotices(prisma, unlinkedProfile.userId, [ws], now);
  check(
    "The computed \"opens soon\" notice covers a workspace exam for the linked student, and nothing for the placeholder",
    soonExam.ok && (await noticesFor(enrolled.user.id, "ASSESSMENT_OPENS_SOON", soonExam.id)) === 1 &&
      (await prisma.notification.count({ where: { userId: unlinkedProfile.userId } })) === 0,
  );
  const reachOf = async (userId: string, withWorkspace: boolean) => {
    const studentCenterIds = withWorkspace ? [ws] : [];
    return {
      relationCenterIds: [],
      studentCenterIds,
      hiddenNoticeIds: await hiddenAssessmentNoticeIds(prisma, userId, studentCenterIds, now),
      workspaceCenterIds: withWorkspace ? [ws] : [],
    };
  };
  const visibleAssessmentNotices = async (userId: string, withWorkspace = true) =>
    prisma.notification.count({ where: { AND: [visibleWhere(userId, await reachOf(userId, withWorkspace)), { centerId: ws, kind: { in: ["ASSESSMENT_PUBLISHED", "ASSESSMENT_EXTENDED", "ASSESSMENT_OPENS_SOON", "ASSESSMENT_DUE_SOON"] } }] } });
  check(
    "The re-check shows the linked student's workspace notices through the opt-in reach, and none without it",
    (await visibleAssessmentNotices(enrolled.user.id)) >= 3 && (await visibleAssessmentNotices(enrolled.user.id, false)) === 0,
  );
  check("The student who left sees none of their earlier notices (enrolment gone — hidden, not deleted)", (await visibleAssessmentNotices(leaver.user.id)) === 0 && (await noticesFor(leaver.user.id, "ASSESSMENT_PUBLISHED", exam.id)) === 1);
  const beforeUnpublish = await visibleAssessmentNotices(enrolled.user.id);
  if (soonExam.ok) await unpublishAssessment(prisma, me, owner, soonExam.id);
  check("Unpublishing hides that assessment's notices", (await visibleAssessmentNotices(enrolled.user.id)) === beforeUnpublish - 2);
  check(
    "A deactivated profile drops out of the opt-in resolver's input, so its notices hide",
    await (async () => {
      await prisma.studentProfile.update({ where: { id: enrolled.profileId }, data: { active: false } });
      const gone = !(await studentWorkspaceProfiles(prisma, enrolled.user.id)).some((row) => row.centerId === ws);
      await prisma.studentProfile.update({ where: { id: enrolled.profileId }, data: { active: true } });
      return gone;
    })(),
  );

  // ── 17i. Assistants: each grant × each action ───────────────────────────
  const link = async (tag: string, permissions: readonly string[], preset: "GRADER" | "CO_TEACHER" | "FULL" = "CO_TEACHER") => {
    const user = await makeUser(`w9-assistant-${tag}`);
    const row = await prisma.teacherAssistant.create({ data: { teacherUserId: teacher.id, assistantUserId: user.id, preset } });
    if (permissions.length > 0) await prisma.assistantPermissionGrant.createMany({ data: permissions.map((permission) => ({ assistantId: row.id, permission })) });
    return { user, linkId: row.id };
  };
  const co = await link("co", PRESET_PERMISSIONS.CO_TEACHER);
  const grader = await link("grader", PRESET_PERMISSIONS.GRADER, "GRADER");
  const full = await link("full", PRESET_PERMISSIONS.FULL, "FULL");
  const checkinOnly = await link("checkin", ["checkin.workspace"]);
  const actingOf = async (userId: string) => resolveAssistantActing(prisma, { assistantUserId: userId, teacherUserId: teacher.id, now });
  const coActing = await actingOf(co.user.id);
  const graderActing = await actingOf(grader.user.id);
  const fullActing = await actingOf(full.user.id);
  const checkinActing = await actingOf(checkinOnly.user.id);
  const granted = (acting: Awaited<ReturnType<typeof actingOf>>) => ASSISTANT_PERMISSIONS.filter((permission) => assistantCan(acting, permission, ws)).join();
  check(
    "assistantCan in the workspace: Grader → assessments.review; Co-teacher and Full → both assessment keys (+ their W8d keys); check-in only → check-in",
    granted(graderActing) === "assessments.review" &&
      granted(coActing) === "assessments.review,assessments.manage,classes.view,checkin.workspace,payments.workspace" &&
      granted(fullActing) === "assessments.review,assessments.manage,classes.view,checkin.workspace,payments.workspace,analytics.view" &&
      granted(checkinActing) === "checkin.workspace",
    [granted(graderActing), granted(coActing), granted(fullActing), granted(checkinActing)].join(" | "),
  );
  check(
    "requests.manage grants nothing in a workspace, and the workspace keys still nothing at a branch",
    !assistantCan(coActing, "requests.manage", ws) && !assistantCan(coActing, "checkin.workspace", fx.branchId) && !assistantCan(coActing, "payments.workspace", fx.branchId),
  );
  const asCo = { userId: co.user.id };
  const coHw = await createAssessment(prisma, asCo, owner, { type: "HOMEWORK", sessionId, draft: w9Draft("HOMEWORK") });
  const coSave = coHw.ok ? await saveAssessmentDraft(prisma, asCo, owner, coHw.id, w9Draft("HOMEWORK", { title: "Co edit" })) : null;
  const coPublish = coHw.ok ? await publishAssessment(prisma, asCo, owner, coHw.id, now) : null;
  const coExtend = coHw.ok ? await extendAssessment(prisma, asCo, owner, coHw.id, later(5 * HOUR), now) : null;
  const coUnpublish = coHw.ok ? await unpublishAssessment(prisma, asCo, owner, coHw.id) : null;
  const coDraft = await createAssessment(prisma, asCo, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") });
  const coDelete = coDraft.ok ? await deleteAssessment(prisma, asCo, owner, coDraft.id) : null;
  check(
    "Co-teacher (assessments.manage): create a homework, save, publish, extend, unpublish, create and delete a draft — every one allowed",
    [coHw, coSave, coPublish, coExtend, coUnpublish, coDraft, coDelete].every((result) => result !== null && result.ok),
    JSON.stringify([coHw, coSave, coPublish, coExtend, coUnpublish, coDraft, coDelete].map(errorOf)),
  );
  check(
    "Co-teacher reads results and answers (Manage covers Review)",
    (await readAssessmentResults(prisma, asCo, owner, exam.id, now)).ok && (await readAttemptResult(prisma, asCo, owner, exam.id, started.attemptId, now)).ok,
  );
  const asGrader = { userId: grader.user.id };
  check(
    "Grader (assessments.review only): results and answers allowed; create, save, publish, extend, unpublish, delete all forbidden",
    (await readAssessmentResults(prisma, asGrader, owner, exam.id, now)).ok &&
      (await readAttemptResult(prisma, asGrader, owner, exam.id, started.attemptId, now)).ok &&
      [
        await createAssessment(prisma, asGrader, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") }),
        await saveAssessmentDraft(prisma, asGrader, owner, draftForLapse.ok ? draftForLapse.id : "", w9Draft("EXAM")),
        await publishAssessment(prisma, asGrader, owner, draftForLapse.ok ? draftForLapse.id : "", now),
        await extendAssessment(prisma, asGrader, owner, exam.id, new Date(oldEnd.getTime() + 2 * HOUR), now),
        await unpublishAssessment(prisma, asGrader, owner, publishedNoAttempt.ok ? publishedNoAttempt.id : ""),
        await deleteAssessment(prisma, asGrader, owner, draftForLapse.ok ? draftForLapse.id : ""),
      ].every((result) => refusedWith(result, "forbidden")),
  );
  const asCheckin = { userId: checkinOnly.user.id };
  check(
    "No assessment grant (check-in only): every assessment write and read is refused",
    refusedWith(await createAssessment(prisma, asCheckin, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") }), "forbidden") &&
      errorOf(await readAssessmentResults(prisma, asCheckin, owner, exam.id, now)) === "forbidden" &&
      (await assessmentResultProgress(prisma, asCheckin, owner, [exam.id], now)).size === 0,
  );
  check(
    "A swapped teacher (the rival's handle) and another teacher's workspace by id are refused for the assistant",
    rivalOwner !== null &&
      refusedWith(await createAssessment(prisma, asCo, rivalOwner, { type: "EXAM", classGroupId: rivalClassId, draft: w9Draft("EXAM") }), "forbidden") &&
      refusedWith(await createAssessment(prisma, asCo, { ...owner, centerId: wsRival }, { type: "EXAM", classGroupId: rivalClassId, draft: w9Draft("EXAM") }), "forbidden") &&
      errorOf(await readAssessmentResults(prisma, asCo, { ...owner, centerId: wsRival }, exam.id, now)) === "forbidden",
  );
  // Lapsed before this section's `now` too: every writer reads premium at the `now` it is given.
  await setPremium(teacher.id, new Date(now.getTime() - 60_000));
  check(
    "The teacher's premium lapsed: the assistant's link is not effective, so writes and reads are refused",
    refusedWith(await createAssessment(prisma, asCo, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") }), "forbidden") &&
      errorOf(await readAssessmentResults(prisma, asCo, owner, exam.id, now)) === "forbidden",
  );
  await setPremium(teacher.id, inDays(30));
  await prisma.teacherAssistant.update({ where: { id: full.linkId }, data: { revokedAt: new Date() } });
  check(
    "A removed link is refused",
    refusedWith(await createAssessment(prisma, { userId: full.user.id }, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") }), "forbidden"),
  );
  const coAudit = await prisma.auditLog.findMany({ where: { centerId: ws, actorUserId: co.user.id } });
  check(
    "Every assistant write is audited with actor = the assistant and onBehalfOf = the teacher, the teacher's action names, ids only",
    coAudit.length >= 7 && coAudit.every((row) => row.onBehalfOfUserId === teacher.id && row.action.startsWith("assessment.") && forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null),
    `${coAudit.length} rows`,
  );
  const ownAudit = await prisma.auditLog.findMany({ where: { centerId: ws, actorUserId: teacher.id, action: { startsWith: "assessment." } } });
  check("The owner's own writes carry no onBehalfOf", ownAudit.length > 0 && ownAudit.every((row) => row.onBehalfOfUserId === null));

  // ── 17j. Nothing reaches a centre-side surface, the hub or the switcher ──
  const branchCtx = {
    center: { id: fx.branchId },
    user: { id: teacher.id },
    role: "TEACHER" as const,
    grants: Object.fromEntries((await prisma.permissionGrant.findMany({ where: { centerId: fx.branchId, role: "TEACHER" } })).map((row) => [row.action, row.allowed])),
    experienceDenied: false,
  };
  const branchTeacher = await resolveAssessmentTeacher(prisma, branchCtx);
  const wsIds = new Set((await prisma.assessment.findMany({ where: { centerId: ws }, select: { id: true } })).map((row) => row.id));
  check(
    "The teacher's branch handle lists no workspace assessment (one scoped read per place)",
    branchTeacher !== null && !(await listTeacherAssessments(prisma, branchTeacher, {})).some((row) => wsIds.has(row.id)),
  );
  const feed = await loadAuditFeed(prisma, fx.branchId, "all", { take: 200, skip: 0 });
  check("The branch's audit feed holds no workspace assessment row", !feed.entries.some((entry) => wsIds.has((entry as { entityId?: string }).entityId ?? "")));
  const relationsT = await resolveCenterRelations(prisma, teacher.id);
  const relationsS = await resolveCenterRelations(prisma, enrolled.user.id);
  const expS = await loadExperiences(prisma, enrolled.user.id);
  check(
    "The hub, switcher, staff and teacher resolvers never include a PERSONAL centre: the teacher resolves the branch only, the student nothing, the experiences no workspace",
    relationsT.every((relation) => relation.center.kind !== "PERSONAL") && relationsT.some((relation) => relation.center.id === fx.branchId) &&
      relationsS.every((relation) => relation.center.kind !== "PERSONAL") &&
      expS.every((entry) => entry.centerId !== ws),
  );
  check("Admin and directory reads leave the workspace out", !(await platformCenterList(prisma)).some((center) => center.id === ws) && !(await listAccessibleCenters(prisma)).some((center) => center.id === ws));

  // ── 17k. Archived: new attempts blocked, results kept, writes refused ───
  const lastExam = await createAssessment(prisma, me, owner, { type: "EXAM", classGroupId: classId, draft: w9Draft("EXAM") });
  if (lastExam.ok) await publishAssessment(prisma, me, owner, lastExam.id, now);
  const archived = await archiveWorkspace(prisma, teacher.id, ws, now);
  check(
    "Archived: the class is deactivated, the published exam is hidden and a new attempt refused (notFound)",
    archived.ok && lastExam.ok &&
      errorOf(await startAttempt(prisma, stEnrolled, lastExam.id, now)) === "notFound" &&
      !(await listStudentAssessments(prisma, stEnrolled, now)).some((item) => item.id === lastExam.id),
  );
  check("Archived: the owner keeps every result", (await readAssessmentResults(prisma, me, owner, exam.id, now)).ok);
  check(
    "Archived: teacher and assistant writes are refused (workspaceArchived)",
    lastExam.ok &&
      refusedWith(await extendAssessment(prisma, me, owner, lastExam.id, later(6 * HOUR), now), "workspaceArchived") &&
      refusedWith(await createAssessment(prisma, asCo, owner, { type: "HOMEWORK", sessionId, draft: w9Draft("HOMEWORK") }), "workspaceArchived"),
  );

  // ── 17l. Statics ────────────────────────────────────────────────────────
  const optIn = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].filter((file) => /getStudentScheduleContexts\(/.test(readSource(file))).map((file) => relative(ROOT, file).replace(/\\/g, "/"));
  check(
    "The opt-in student resolver is called only by the student surfaces listed: the schedule, the calendar and the assessments scope",
    optIn.sort().join() === ["app/[locale]/(student)/student/assessments/scope.ts", "app/[locale]/(student)/student/calendar/page.tsx", "app/[locale]/(student)/student/schedule/page.tsx"].join(),
    optIn.join(", "),
  );
  check(
    "Every teacher assessment write re-runs the workspace gate inside its transaction (static)",
    (read("lib/db/assessments.ts").match(/const refused = await writeGate\(tx, actor, teacher, now\);/g) ?? []).length === 6 &&
      /workspaceCan\(\{ workspace: access \}, "workspace\.assessments\.manage"\)/.test(read("lib/db/assessments.ts")) &&
      /assertWorkspaceWritable\(tx, access, now\)/.test(read("lib/db/assessments.ts")),
  );
  check(
    "No student path runs the workspace write gate (a lapse never blocks an attempt) (static)",
    !/workspaceWriteGate|assertWorkspaceWritable|requirePremium/.test(read("lib/db/assessment-attempts.ts")),
  );
  check(
    "The workspace-only teacher shell is the shared constant, and it matches the hand-written oracle",
    TEACHER_WORKSPACE_ONLY_NAV.map((item) => item.labelKey).join() === EXPECTED_WORKSPACE_ONLY_TEACHER_NAV.join() &&
      /nav: session\.workspaceOnly\s*\?\s*TEACHER_WORKSPACE_ONLY_NAV/.test(read("app/[locale]/(teacher)/teacher-shell.ts")),
  );
}

// ── 18. W10: workspace share codes (D-W43) ─────────────────────────────────

let ipSeq = 0;
/** A run-unique client IP key per call, unless a test shares one on purpose. */
const freshIp = () => `w10-${RUN}-${(ipSeq += 1)}`;

/** An account that signed up on its own: an email, a login, no User.phone. */
async function selfRegistered(tag: string) {
  const user = await makeUser(tag);
  return prisma.user.update({
    where: { id: user.id },
    data: { authId: `${STEM}-auth-${tag}-${RUN}-${user.id.slice(0, 8)}`, firstName: `Redeemer${RUN}`, lastName: `Real${tag}${RUN}` },
  });
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function workspaceShareCodes(fx: {
  today: Date;
  classInput: { educationSystemId: null; gradeId: string; subjectId: string; price: number; lateThresholdMinutes: number; startDate: Date; endDate: Date };
  slot: { dayOfWeek: number; startTime: string; endTime: string };
  others: [string, string][];
}) {
  const { today } = fx;
  console.log("\n18. W10: workspace share codes — sha256, single use, expiry, the W8b move, authority, limits, audit, the student's reads");

  // ── 18a. Fixtures: two premium teachers, three workspaces, a class ─────
  // A real teacher signs in: a login, so the owner refusal is reached past the account gate.
  const teacherX = await prisma.user.update({
    where: { id: (await makeUser("w10-teacher-x", { premium: true })).id },
    data: { authId: `${STEM}-auth-w10-teacher-x-${RUN}` },
  });
  const teacherY = await makeUser("w10-teacher-y", { premium: true });
  const assistantX = await makeUser("w10-assistant", { premium: true });
  await prisma.teacherAssistant.create({ data: { teacherUserId: teacherX.id, assistantUserId: assistantX.id, preset: "FULL" } });
  const createdX = await createWorkspace(prisma, teacherX.id, { name: "X Physics" });
  const createdX2 = await createWorkspace(prisma, teacherX.id, { name: "X Maths" });
  const createdY = await createWorkspace(prisma, teacherY.id, { name: "Y Biology" });
  if (!createdX.ok || !createdX2.ok || !createdY.ok) {
    check("Setup: the W10 workspaces", false, JSON.stringify({ createdX, createdX2, createdY }));
    return;
  }
  const wsX = createdX.workspaceId;
  const wsX2 = createdX2.workspaceId;
  const wsY = createdY.workspaceId;
  const cls = await createWorkspaceClass(prisma, teacherX.id, wsX, { ...fx.classInput, slots: [{ ...fx.slot, startTime: "19:00", endTime: "20:00" }] }, { confirmConflicts: true, locale: "en" });
  const otherCls = await createWorkspaceClass(prisma, teacherX.id, wsX, { ...fx.classInput, slots: [{ ...fx.slot, startTime: "07:00", endTime: "08:00" }] }, { confirmConflicts: true, locale: "en" });
  if (!cls.ok || !otherCls.ok) {
    check("Setup: the W10 classes", false, JSON.stringify({ cls, otherCls }));
    return;
  }
  const classId = cls.classGroupId;
  const add = async (ws: string, owner: string, tag: string) => {
    const result = await addWorkspaceStudent(prisma, owner, ws, { ...PLACEHOLDER(tag), phone: freshPhone(), gradeId: null });
    if (!result.ok) throw new Error(`setup add ${tag}: ${result.error}`);
    return result.studentProfileId;
  };
  const pMain = await add(wsX, teacherX.id, "w10-main");
  const pRace = await add(wsX, teacherX.id, "w10-race");
  const pKeep = await add(wsX, teacherX.id, "w10-keep");
  const pTwinA = await add(wsX, teacherX.id, "w10-twin-a");
  const pTwinB = await add(wsX, teacherX.id, "w10-twin-b");
  const pMisc = await add(wsX, teacherX.id, "w10-misc");
  const pY = await add(wsY, teacherY.id, "w10-y");
  check("W10 fixtures built", (await enrolWorkspaceStudent(prisma, teacherX.id, wsX, classId, pMain)).ok);

  const issued: string[] = [];
  const create = async (profileId: string, actor = teacherX.id, ws = wsX, now?: Date) => {
    const result = await createWorkspaceShareCode(prisma, actor, ws, profileId, now);
    if (result.ok) issued.push(result.code);
    return result;
  };
  const preview = (userId: string, code: unknown, now?: Date) => previewWorkspaceShareCode(prisma, { userId, code, ip: freshIp(), now });
  const redeem = (userId: string, code: unknown, now?: Date) => redeemWorkspaceShareCode(prisma, { userId, code, ip: freshIp(), now });

  // ── 18b. sha256-only storage, shown once ───────────────────────────────
  const first = await create(pMain);
  check("Share code succeeds for the owner's unlinked profile", first.ok, JSON.stringify(first));
  if (!first.ok) return;
  const firstRow = await prisma.workspaceShareCode.findUniqueOrThrow({ where: { id: first.codeId } });
  check(
    "The code is 12 symbols of the parent/assistant alphabet",
    first.code.length === 12 && [...first.code].every((char) => WORKSPACE_SHARE_CODE_ALPHABET.includes(char)) && WORKSPACE_SHARE_CODE_ALPHABET === ASSISTANT_CODE_ALPHABET,
  );
  check(
    "Only its sha256 is stored — no column holds the code",
    firstRow.codeHash === sha256(first.code) && /^[0-9a-f]{64}$/.test(firstRow.codeHash) && !JSON.stringify(firstRow).includes(first.code),
  );
  check(
    "It expires 7 days after creation, on the workspace, by the owner",
    Math.abs(firstRow.expiresAt.getTime() - firstRow.createdAt.getTime() - 7 * 86_400_000) < 1000 &&
      firstRow.centerId === wsX && firstRow.createdByUserId === teacherX.id && firstRow.usedAt === null,
  );
  check(
    "The teacher's read of codes is the expiry only — never retrievable",
    (await activeShareCodeExpiries(prisma, wsX)).get(pMain)?.getTime() === firstRow.expiresAt.getTime(),
  );

  // ── 18c. One active per profile; a new code revokes the old ────────────
  const second = await create(pMain);
  check("Share code again succeeds and says it replaced an active one", second.ok && second.replaced);
  if (!second.ok) return;
  check(
    "The first code is revoked; one active code remains for the profile",
    (await prisma.workspaceShareCode.findUniqueOrThrow({ where: { id: first.codeId } })).revokedAt !== null &&
      (await prisma.workspaceShareCode.count({ where: { studentProfileId: pMain, usedAt: null, revokedAt: null } })) === 1,
  );
  let partialRefused = false;
  try {
    await prisma.workspaceShareCode.create({
      data: { centerId: wsX, studentProfileId: pMain, createdByUserId: teacherX.id, codeHash: sha256(`stray-${RUN}`), expiresAt: inDays(7) },
    });
  } catch {
    partialRefused = true;
  }
  check("A second active code for one profile is refused by the partial unique index", partialRefused);
  const [index] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'WorkspaceShareCode_one_active_per_profile'
      AND indexdef ILIKE '%usedAt%IS NULL%' AND indexdef ILIKE '%revokedAt%IS NULL%'`;
  check("The hand-written partial index exists (CLAUDE.md rule 7)", Number(index?.count ?? 0) === 1);
  const [rls] = await prisma.$queryRaw<{ on: boolean }[]>`
    SELECT c.relrowsecurity AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'WorkspaceShareCode'`;
  check("RLS is on for WorkspaceShareCode", rls?.on === true);

  // ── 18d. One answer for unknown, expired, used and revoked ─────────────
  const prober = await selfRegistered("w10-prober");
  const revokedAnswer = await preview(prober.id, first.code);
  const unknownAnswer = await preview(prober.id, generateAssistantCode());
  const malformedAnswer = await preview(prober.id, "not a code");
  const expiredCode = await create(pMisc, teacherX.id, wsX, new Date(Date.now() - 8 * 86_400_000));
  const expiredAnswer = expiredCode.ok ? await preview(prober.id, expiredCode.code) : null;
  // `used` is checked after 18f; keep the shape here.
  const generic = JSON.stringify({ ok: false, error: "invalidCode" });
  check(
    "Revoked, unknown, malformed and expired codes give the same answer (invalidCode)",
    [revokedAnswer, unknownAnswer, malformedAnswer, expiredAnswer].every((answer) => JSON.stringify(answer) === generic),
    [revokedAnswer, unknownAnswer, malformedAnswer, expiredAnswer].map((answer) => JSON.stringify(answer)).join(" "),
  );

  // ── 18e. The expiry boundary ───────────────────────────────────────────
  const boundary = await create(pKeep);
  if (boundary.ok) {
    const just = new Date(boundary.expiresAt.getTime() - 1);
    const at = new Date(boundary.expiresAt.getTime());
    const before = await preview(prober.id, boundary.code, just);
    const atExpiry = await preview(prober.id, boundary.code, at);
    const redeemAt = await redeem(prober.id, boundary.code, at);
    check("One millisecond before expiresAt the code previews", before.ok, JSON.stringify(before));
    check(
      "At expiresAt it is invalidCode, preview and confirm alike, and nothing moved",
      JSON.stringify(atExpiry) === generic && JSON.stringify(redeemAt) === generic &&
        (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pKeep } })).userId !== prober.id,
    );
  } else check("Setup: the boundary code", false, JSON.stringify(boundary));

  // ── 18f. Preview writes nothing; Confirm links, atomically ─────────────
  const student = await selfRegistered("w10-student");
  const shown = await preview(student.id, formatWorkspaceShareCodeForDisplay(second.code).toLowerCase());
  check(
    "The preview reads the workspace's name and the teacher's only (dashes and case ignored)",
    shown.ok && shown.workspaceName === "X Physics" && shown.teacherName === `${teacherX.firstName} ${teacherX.lastName}` &&
      JSON.stringify(Object.keys(shown).sort()) === JSON.stringify(["ok", "teacherName", "workspaceName"]),
    JSON.stringify(shown),
  );
  check(
    "The preview wrote nothing",
    (await prisma.workspaceShareCode.findUniqueOrThrow({ where: { id: second.codeId } })).usedAt === null &&
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pMain } })).userId !== student.id,
  );
  // A pending invitation for this profile (to someone else) must be cancelled by the redemption.
  const bystander = await selfRegistered("w10-bystander");
  const pending = await prisma.workspaceInvitation.create({ data: { centerId: wsX, studentProfileId: pMain, targetUserId: bystander.id } });
  const placeholderId = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pMain } })).userId;
  const linked = await redeem(student.id, second.code);
  check("Confirm succeeds", linked.ok, JSON.stringify(linked));
  const moved = await prisma.studentProfile.findUniqueOrThrow({ where: { id: pMain } });
  const usedRow = await prisma.workspaceShareCode.findUniqueOrThrow({ where: { id: second.codeId } });
  check(
    "The profile moved to the redeemer; the code is used by them; the placeholder (holding nothing else) is gone",
    moved.userId === student.id && usedRow.usedAt !== null && usedRow.usedByUserId === student.id &&
      (await prisma.user.count({ where: { id: placeholderId } })) === 0 && linked.ok && linked.placeholderRemoved,
  );
  check(
    "The local record and the enrolment are untouched",
    moved.lastName === PLACEHOLDER("w10-main").lastName && moved.phone !== null &&
      (await prisma.enrollment.count({ where: { studentProfileId: pMain, classGroupId: classId, status: "ACTIVE" } })) === 1,
  );
  check("The pending invitation for the profile is CANCELLED", (await prisma.workspaceInvitation.findUniqueOrThrow({ where: { id: pending.id } })).status === "CANCELLED");
  const prober2 = await selfRegistered("w10-prober-two");
  const usedAnswer = await preview(prober2.id, second.code);
  const usedAgain = await redeem(student.id, second.code);
  check("The code works once: used is the same invalidCode, preview and confirm", JSON.stringify(usedAnswer) === generic && JSON.stringify(usedAgain) === generic);

  // A placeholder that holds another relation is kept.
  const keepPlaceholder = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pKeep } })).userId;
  await prisma.studentProfile.create({ data: { userId: keepPlaceholder, centerId: wsX2, studentCode: `${STEM}-w10-keep-${RUN}` } });
  const keepCode = await create(pKeep);
  const keeper = await selfRegistered("w10-keeper");
  const kept = keepCode.ok ? await redeem(keeper.id, keepCode.code) : null;
  check(
    "A placeholder that holds another relation is kept (placeholderRemoved false)",
    kept?.ok === true && !kept.placeholderRemoved && (await prisma.user.count({ where: { id: keepPlaceholder } })) === 1 &&
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pKeep } })).userId === keeper.id,
    JSON.stringify(kept),
  );

  // ── 18g. Refusals: already in the workspace, already linked, own workspace ──
  const twinA = await create(pTwinA);
  const twinB = await create(pTwinB);
  if (twinA.ok && twinB.ok) {
    const already = await preview(student.id, twinA.code);
    const alreadyConfirm = await redeem(student.id, twinA.code);
    check(
      "An account that already has a profile in the workspace is refused (alreadyInWorkspace), and the code stays usable",
      !already.ok && already.error === "alreadyInWorkspace" && !alreadyConfirm.ok && alreadyConfirm.error === "alreadyInWorkspace" &&
        (await prisma.workspaceShareCode.findFirstOrThrow({ where: { codeHash: sha256(twinA.code) } })).usedAt === null,
    );
    const own = await preview(teacherX.id, twinA.code);
    check("The workspace's own owner is refused (ownWorkspace)", !own.ok && own.error === "ownWorkspace");
    // Linked meanwhile (the placeholder gained a login): already linked.
    const twinPlaceholder = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pTwinB } })).userId;
    await prisma.user.update({ where: { id: twinPlaceholder }, data: { authId: `${STEM}-auth-twin-${RUN}` } });
    const late = await selfRegistered("w10-late");
    const linkedAnswer = await preview(late.id, twinB.code);
    const linkedConfirm = await redeem(late.id, twinB.code);
    check(
      "A profile already linked is refused (alreadyLinked), preview and confirm",
      !linkedAnswer.ok && linkedAnswer.error === "alreadyLinked" && !linkedConfirm.ok && linkedConfirm.error === "alreadyLinked",
    );
    const onLinked = await create(pTwinB);
    check("Share code on a linked profile is refused (alreadyLinked)", !onLinked.ok && onLinked.error === "alreadyLinked");
    await prisma.user.update({ where: { id: twinPlaceholder }, data: { authId: null } });
  } else check("Setup: the twin codes", false, JSON.stringify({ twinA, twinB }));

  // ── 18h. Concurrency: exactly one wins ─────────────────────────────────
  const race = await create(pRace);
  if (race.ok) {
    const racerA = await selfRegistered("w10-racer-a");
    const racerB = await selfRegistered("w10-racer-b");
    const results = await Promise.all([redeem(racerA.id, race.code), redeem(racerB.id, race.code)]);
    const winners = results.filter((result) => result.ok);
    const owner = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: pRace } })).userId;
    check(
      "Two concurrent redemptions of one code: exactly one links, the other is refused",
      winners.length === 1 && [racerA.id, racerB.id].includes(owner) &&
        (await prisma.auditLog.count({ where: { centerId: wsX, action: "workspace.code.redeem", entityId: (await prisma.workspaceShareCode.findFirstOrThrow({ where: { codeHash: sha256(race.code) } })).id } })) === 1,
      results.map((result) => (result.ok ? "ok" : result.error)).join(","),
    );
  } else check("Setup: the race code", false, JSON.stringify(race));
  // One account, two codes into one workspace at once: at most one profile there.
  const twinACode = issued.find((code) => code === (twinA.ok ? twinA.code : ""));
  const freshTwinB = await create(pTwinB);
  if (twinACode && freshTwinB.ok) {
    const doubler = await selfRegistered("w10-doubler");
    const both = await Promise.all([redeem(doubler.id, twinACode), redeem(doubler.id, freshTwinB.code)]);
    check(
      "One account racing two codes into one workspace ends with exactly one profile there",
      both.filter((result) => result.ok).length === 1 &&
        (await prisma.studentProfile.count({ where: { centerId: wsX, userId: doubler.id } })) === 1,
      both.map((result) => (result.ok ? "ok" : result.error)).join(","),
    );
  } else check("Setup: the double codes", false);

  // ── 18i. Authority: owner only; assistants, other teachers, staff ──────
  const miscCode = await create(pMisc);
  check("Setup: an active code on another profile", miscCode.ok);
  const intruders: [string, string][] = [...fx.others, ["X's own assistant (FULL)", assistantX.id], ["another premium teacher (Y)", teacherY.id]];
  for (const [label, actor] of intruders) {
    const created = await createWorkspaceShareCode(prisma, actor, wsX, pMisc);
    const revoked = await revokeWorkspaceShareCode(prisma, actor, wsX, pMisc);
    check(
      `${label}: Share code and Revoke code answer notFound by direct call`,
      !created.ok && created.error === "notFound" && !revoked.ok && revoked.error === "notFound",
      `${created.ok ? "ok" : created.error},${revoked.ok ? "ok" : revoked.error}`,
    );
  }
  check("…and the active code is still the owner's one", (await activeShareCodeExpiries(prisma, wsX)).has(pMisc));
  const crossProfile = await createWorkspaceShareCode(prisma, teacherX.id, wsX, pY);
  const crossWorkspace = await createWorkspaceShareCode(prisma, teacherX.id, wsY, pY);
  const crossRevoke = await revokeWorkspaceShareCode(prisma, teacherY.id, wsY, pMisc);
  check(
    "Isolation: another workspace's profile, another teacher's workspace and a revoke across teachers are all notFound",
    !crossProfile.ok && crossProfile.error === "notFound" && !crossWorkspace.ok && crossWorkspace.error === "notFound" && !crossRevoke.ok && crossRevoke.error === "notFound",
  );
  check("Another workspace's reads hold none of X's codes", (await activeShareCodeExpiries(prisma, wsY)).size === 0);

  // ── 18j. Premium and archive ───────────────────────────────────────────
  const pLapseRedeem = await add(wsX, teacherX.id, "w10-lapse-redeem");
  const pLapseRevoke = await add(wsX, teacherX.id, "w10-lapse-revoke");
  const pArchRedeem = await add(wsX, teacherX.id, "w10-arch-redeem");
  const pArchRevoke = await add(wsX, teacherX.id, "w10-arch-revoke");
  const lapseRedeemCode = await create(pLapseRedeem);
  const lapseRevokeCode = await create(pLapseRevoke);
  const archRedeemCode = await create(pArchRedeem);
  const archRevokeCode = await create(pArchRevoke);
  check("Setup: four codes before the lapse", lapseRedeemCode.ok && lapseRevokeCode.ok && archRedeemCode.ok && archRevokeCode.ok);
  await setPremium(teacherX.id, new Date(Date.now() - 60_000));
  const lapsedCreate = await createWorkspaceShareCode(prisma, teacherX.id, wsX, pMisc);
  check("Lapsed: Share code is refused (premiumRequired)", !lapsedCreate.ok && lapsedCreate.error === "premiumRequired");
  const lapsedRedeemer = await selfRegistered("w10-lapsed");
  const lapsedRedeem = lapseRedeemCode.ok ? await redeem(lapsedRedeemer.id, lapseRedeemCode.code) : null;
  check("Lapsed: a code issued before still redeems (no premium needed)", lapsedRedeem?.ok === true, JSON.stringify(lapsedRedeem));
  check("Lapsed: Revoke code still works (it only withdraws)", (await revokeWorkspaceShareCode(prisma, teacherX.id, wsX, pLapseRevoke)).ok);
  await setPremium(teacherX.id, inDays(30));
  await prisma.center.update({ where: { id: wsX }, data: { archivedAt: new Date(), archivedByUserId: teacherX.id } });
  const archivedCreate = await createWorkspaceShareCode(prisma, teacherX.id, wsX, pMisc);
  check("Archived: Share code is refused (workspaceArchived)", !archivedCreate.ok && archivedCreate.error === "workspaceArchived");
  const archivedRedeemer = await selfRegistered("w10-archived");
  const archivedRedeem = archRedeemCode.ok ? await redeem(archivedRedeemer.id, archRedeemCode.code) : null;
  check("Archived: a code still redeems (as accepting an invitation does)", archivedRedeem?.ok === true, JSON.stringify(archivedRedeem));
  check("Archived: Revoke code still works", (await revokeWorkspaceShareCode(prisma, teacherX.id, wsX, pArchRevoke)).ok);
  await prisma.center.update({ where: { id: wsX }, data: { archivedAt: null, archivedByUserId: null } });
  const loginless = await makeUser("w10-loginless");
  const noLoginAnswer = await preview(loginless.id, generateAssistantCode());
  check("An account with no login is refused before any lookup (forbidden)", !noLoginAnswer.ok && noLoginAnswer.error === "forbidden");

  // ── 18k. Rate limits (the existing limiter) ────────────────────────────
  const limiter = await makeUser("w10-limits", { premium: true });
  const limitWs = await createWorkspace(prisma, limiter.id, { name: "W10 Limits" });
  if (limitWs.ok) {
    const limitProfile = await add(limitWs.workspaceId, limiter.id, "w10-lim");
    const dayBefore = Math.floor(Date.now() / RATE_LIMITS.workspaceShareCodePerUser.windowMs);
    let made = 0;
    let refusal: string | null = null;
    for (let index = 0; index < RATE_LIMITS.workspaceShareCodePerUser.limit + 1; index += 1) {
      const result = await create(limitProfile, limiter.id, limitWs.workspaceId);
      if (result.ok) made += 1;
      else refusal ??= result.error;
    }
    const crossed = Math.floor(Date.now() / RATE_LIMITS.workspaceShareCodePerUser.windowMs) !== dayBefore;
    check(
      "30 Share codes a day per teacher, the 31st rateLimited",
      RATE_LIMITS.workspaceShareCodePerUser.limit === 30 && (crossed || (made === 30 && refusal === "rateLimited")),
      crossed ? "the day turned mid-run; not judged" : `${made} made, then ${refusal}`,
    );
  } else check("Setup: the limits workspace", false, JSON.stringify(limitWs));
  const guesser = await selfRegistered("w10-guesser");
  const hourBefore = Math.floor(Date.now() / RATE_LIMITS.workspaceJoinPerUser.windowMs);
  const guesses = [];
  for (let index = 0; index < RATE_LIMITS.workspaceJoinPerUser.limit + 1; index += 1) guesses.push(await preview(guesser.id, generateAssistantCode()));
  const hourCrossed = Math.floor(Date.now() / RATE_LIMITS.workspaceJoinPerUser.windowMs) !== hourBefore;
  check(
    "Redemption attempts per account: 10 an hour (valid or not), the 11th rateLimited",
    hourCrossed || (guesses.slice(0, 10).every((answer) => JSON.stringify(answer) === generic) && !guesses[10].ok && guesses[10].error === "rateLimited"),
    hourCrossed ? "the hour turned mid-run; not judged" : guesses.map((answer) => (answer.ok ? "ok" : answer.error)).join(","),
  );
  const sharedIp = `w10-shared-${RUN}`;
  const ipUsers = [];
  for (let index = 0; index < 7; index += 1) ipUsers.push(await selfRegistered(`w10-ip${index}`));
  const ipHourBefore = Math.floor(Date.now() / RATE_LIMITS.workspaceJoinPerIp.windowMs);
  const fromIp = [];
  for (let index = 0; index < RATE_LIMITS.workspaceJoinPerIp.limit + 1; index += 1) {
    fromIp.push(await previewWorkspaceShareCode(prisma, { userId: ipUsers[index % 7].id, code: generateAssistantCode(), ip: sharedIp }));
  }
  const ipCrossed = Math.floor(Date.now() / RATE_LIMITS.workspaceJoinPerIp.windowMs) !== ipHourBefore;
  check(
    "Redemption attempts per client IP: 60 an hour, the 61st rateLimited",
    ipCrossed || (fromIp.slice(0, 60).every((answer) => !answer.ok && answer.error === "invalidCode") && !fromIp[60].ok && fromIp[60].error === "rateLimited"),
    ipCrossed ? "the hour turned mid-run; not judged" : `${fromIp.filter((answer) => !answer.ok && answer.error === "rateLimited").length} refused`,
  );

  // ── 18l. The teacher never sees the redeemer ───────────────────────────
  const teacherReads = JSON.stringify([
    await listWorkspaceStudents(prisma, wsX),
    await workspaceClassRoster(prisma, wsX, classId),
    [...(await activeShareCodeExpiries(prisma, wsX)).entries()],
    second,
  ]);
  const redeemers = [student, keeper, lapsedRedeemer, archivedRedeemer];
  check(
    "The teacher's reads (students, roster, codes, the Share code answer) carry no redeemer's id, email or real name",
    redeemers.every((user) => !teacherReads.includes(user.id) && !teacherReads.includes(user.email ?? "@@") && !teacherReads.includes(user.lastName)) &&
      !teacherReads.includes(`Redeemer${RUN}`),
  );
  check(
    "The teacher reads Linked for the redeemed profile, and nothing more",
    (await listWorkspaceStudents(prisma, wsX)).find((row) => row.id === pMain)?.linked === true,
  );

  // ── 18m. The linked student sees exactly the W8b set ───────────────────
  const profiles = await studentWorkspaceProfiles(prisma, student.id);
  check("The opt-in resolver's input: exactly the linked workspace profile", profiles.length === 1 && profiles[0].centerId === wsX);
  const upcoming = await studentUpcomingSessions(prisma, wsX, pMain, today);
  check(
    "Schedule: the enrolled class's sessions only (not the workspace's other class)",
    upcoming.length > 0 && upcoming.every((session) => session.classGroupId === classId),
  );
  const month = await studentCalendarMonth(prisma, wsX, pMain, { start: today, end: addDays(today, 30) }, today);
  check("Calendar: the enrolled class, which the done-when check opens", month.length > 0 && month.every((entry) => entry.classGroupId === classId));
  const entries = await loadExperiences(prisma, student.id);
  check(
    "A self-registered account linked only by a code has the one Student experience, landing on the schedule",
    entries.length === 1 && entries[0].kind === "student" && entries[0].href === ROUTES.studentSchedule,
    entries.map((entry) => entry.key).join(","),
  );
  check(
    "Nothing else: no branch relation (hub, switcher), no Discover listing, no other teacher's workspace",
    (await resolveCenterRelations(prisma, student.id)).length === 0 &&
      !(await listAccessibleCenters(prisma)).some((center) => center.id === wsX) &&
      (await prisma.studentProfile.count({ where: { userId: student.id, centerId: { in: [wsY, wsX2] } } })) === 0,
  );

  // ── 18n. Audit: ids only, never the code ───────────────────────────────
  const codeRows = await prisma.auditLog.findMany({ where: { action: { startsWith: "workspace.code." }, centerId: { in: [wsX, wsY] } } });
  const rowsJson = JSON.stringify(codeRows);
  check(
    "workspace.code.create / .revoke / .redeem are written, ids only, on behalf of no one, and never contain a code",
    ["workspace.code.create", "workspace.code.revoke", "workspace.code.redeem"].every((action) => codeRows.some((row) => row.action === action)) &&
      codeRows.every((row) => forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null && row.onBehalfOfUserId === null) &&
      issued.every((code) => !rowsJson.includes(code) && !rowsJson.includes(sha256(code))),
    `${codeRows.length} rows`,
  );
  const redeemRow = codeRows.find((row) => row.action === "workspace.code.redeem" && row.entityId === second.codeId);
  check("Redeem is audited with the redeemer as actor", redeemRow?.actorUserId === student.id);

  // ── 18o. Statics ───────────────────────────────────────────────────────
  const teacherActions = read("app/[locale]/(teacher)/teacher/workspaces/share-code-actions.ts");
  const joinActions = read("app/[locale]/(auth)/workspace-join-actions.ts");
  const w10Exported = [...teacherActions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g), ...joinActions.matchAll(/export async function (\w+)\([\s\S]*?\n\}/g)];
  check(
    "Every W10 action takes the actor from the session, never a posted user, and consults no centre matrix (static)",
    w10Exported.length === 4 &&
      w10Exported.every(([body]) => /await getCurrentUser\(\)/.test(body) && /user\.id/.test(body)) &&
      !/formData\.get\(["'](userId|actorUserId|teacherId|targetUserId|usedByUserId)/.test(teacherActions + joinActions) &&
      !/ctxCan\(|getTenantContext\(|requireExperience\(/.test(teacherActions + joinActions),
    `${w10Exported.length} actions`,
  );
  const codesModule = read("lib/db/workspace-share-codes.ts");
  const codesCode = codesModule.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("The share-code module reads no phone and no contactPhone (CLAUDE.md rule 4) (static)", !/phone/i.test(codesCode));
  check(
    "Accepting an invitation and redeeming a code share the one W8b move (static)",
    /await moveWorkspaceProfileToAccount\(tx, \{/.test(codesCode) &&
      (read("lib/db/workspace-students.ts").match(/await moveWorkspaceProfileToAccount\(tx, \{/g) ?? []).length === 1 &&
      (read("lib/db/workspace-students.ts").match(/data: \{ userId: input\.accountUserId \}/g) ?? []).length === 1,
  );
  check(
    "Share code re-runs authorizeWrite inside its transaction; Revoke needs ownership and the capability only (static)",
    (codesCode.match(/await authorizeWrite\(/g) ?? []).length === 2 &&
      /revokeWorkspaceShareCode[\s\S]*?resolveWorkspaceAccess\(tx[\s\S]*?workspaceCan\(/.test(codesCode) &&
      !/revokeWorkspaceShareCode[\s\S]*?assertWorkspaceWritable/.test(codesCode.slice(codesCode.indexOf("export async function revokeWorkspaceShareCode"), codesCode.indexOf("export async function activeShareCodeExpiries"))),
  );
  const assistantSurface = [...walk(join(ROOT, "app", "[locale]", "(assistant)")), ...walk(join(ROOT, "lib", "db")).filter((file) => /assistant-/.test(file))];
  const reachingCodes = assistantSurface.filter((file) => /createWorkspaceShareCode|revokeWorkspaceShareCode|share-code-actions/.test(readSource(file)));
  check("The assistant surface never reaches a share-code writer (static)", reachingCodes.length === 0, reachingCodes.join(", "));
  const joinForm = read("components/workspaces/join-workspace-form.tsx");
  check(
    "The join page takes the code from the fragment, clears the address bar, and never puts it in a query (static)",
    /window\.location\.hash/.test(joinForm) && /window\.history\.replaceState/.test(joinForm) &&
      /ROUTES\.workspaceJoin\}#\$\{code\}/.test(read("lib/routes.ts")) && !/searchParams/.test(read("app/[locale]/(auth)/workspace-join/page.tsx")),
  );
  check(
    "The WhatsApp share is wa.me with the text only — no phone number (static)",
    /https:\/\/wa\.me\/\?text=\$\{encodeURIComponent\(text\)\}/.test(read("lib/routes.ts")),
  );
  const w10Dir = readdirSync(join(ROOT, "prisma", "migrations")).find((dir) => dir.endsWith("_w10_workspace_share_codes"));
  const w10Migration = w10Dir ? read(`prisma/migrations/${w10Dir}/migration.sql`) : "";
  check(
    "The W10 migration is additive: the table, RLS on, the partial index, no DROP, no policy (static)",
    /CREATE TABLE "WorkspaceShareCode"/.test(w10Migration) && /ENABLE ROW LEVEL SECURITY/.test(w10Migration) &&
      /WorkspaceShareCode_one_active_per_profile/.test(w10Migration) && !/^\s*DROP\s/im.test(w10Migration) && !/POLICY/i.test(w10Migration),
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
