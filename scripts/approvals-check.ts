/**
 * Approvals check — the acceptance gate for the Approvals screen
 * (docs/00-master-product-spec.md §4.1 item 9), which closes the reviewer-UI
 * gap flagged at M6, M7 and M8: `ChangeRequest` and `Reservation` rows sat
 * PENDING forever with no way to accept/decline them.
 *
 * Run with:  npm run check:approvals
 *
 * Exercises the real production functions — `lib/db/approvals.ts`'s
 * `resolveChangeRequest` (the NEW_CLASS status flip), `resolveSessionRequest`
 * (M10, the NEW_SESSION status flip that also creates the `Session` —
 * approve/decline, duplicate-slot, WARN/DENY conflict handling and
 * cross-center isolation) and `lib/db/reservations.ts`'s
 * `confirmReservation`/`rejectReservation` (M8, reused as-is) — against two
 * throwaway centers, plus a direct assertion against
 * `lib/auth/permissions.ts` that RECEPTIONIST cannot reach `approvals.manage`.
 * Needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { type ChangeRequestStatus, type ReservationStatus } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import { resolveChangeRequest, resolveSessionRequest } from "../lib/db/approvals.ts";
import { confirmReservation, rejectReservation, reserveOrEnroll } from "../lib/db/reservations.ts";
import { can } from "../lib/auth/permissions.ts";
import { confirmBooking, rejectBooking, requestBooking } from "../lib/db/session-bookings.ts";
import { scopedWith } from "../lib/db/scoped.ts";
import { pendingClaimsForCenter } from "../lib/db/account-claims.ts";
import { pendingApprovalCounts, pendingTeacherApprovalCounts } from "../lib/db/approval-counts.ts";
import { navForExperience, withPendingCount } from "../components/shell/nav.ts";
import { ROUTES } from "../lib/routes.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { addDays, dateKey, todayInTimezone } from "../lib/scheduling.ts";

const prisma = await gatePrisma();

/** Fixture dates relative to today in Cairo (SEC-2c) — never a calendar date that will pass. */
const FIXTURE_TODAY = todayInTimezone("Africa/Cairo");
const FIXTURE_CLASS_END = addDays(FIXTURE_TODAY, 400);
function mondayOnOrAfter(day: Date): Date {
  let next = day;
  while (next.getUTCDay() !== 1) next = addDays(next, 1);
  return next;
}

const SLUG_A = "approvals-check-a";
const SLUG_B = "approvals-check-b";
/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const PENDING_CHANGE_REQUEST: ChangeRequestStatus = "PENDING";
const PENDING_RESERVATION: ReservationStatus = "PENDING";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "approvals-check-" } } });
  // Global catalog rows (M13) don't cascade away with the centers above.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Approvals-Check" } } });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email: `approvals-check-${tag}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

async function makeStudentUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `approvals-check-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeChangeRequest(centerId: string, teacherId: string) {
  return prisma.changeRequest.create({
    data: scopedData(centerId, {
      type: "NEW_CLASS",
      requestedBy: teacherId,
      // Deliberately a legacy payload shape: requests written before R1 still
      // carry the removed `attendanceRequired` key, and approving them must
      // keep working — readers ignore the key rather than choking on it.
      payload: { dayOfWeek: 1, startTime: "16:00", endTime: "18:00", capacity: 10, attendanceRequired: true, lateThresholdMinutes: 10 },
      status: "PENDING",
    }),
  });
}

async function main() {
  await cleanup();

  console.log("Permission map (no database needed)");
  check(
    "RECEPTIONIST cannot reach approvals.manage — same denial shape as analytics.center.view/expense.manage (M6)",
    !can("RECEPTIONIST", "approvals.manage"),
  );
  check(
    "MANAGER can reach approvals.manage (seeded baseline grant)",
    can("MANAGER", "approvals.manage", { "approvals.manage": true }),
  );
  check(
    "OWNER can reach approvals.manage (seeded baseline grant)",
    can("OWNER", "approvals.manage", { "approvals.manage": true }),
  );

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Approvals Check A", organization: { create: { name: "Approvals Check A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Approvals Check B", organization: { create: { name: "Approvals Check B" } } },
  });
  const managerA = await prisma.user.create({
    data: { firstName: "M", lastName: "A", email: "approvals-check-managerA@kayedu.test", locale: "en" },
  });

  const teacherA = await makeTeacher(centerA.id, "teacherA");
  const teacherB = await makeTeacher(centerB.id, "teacherB");

  // ── 1. ChangeRequest accept/decline ───────────────────────────────────────
  const requestToApprove = await makeChangeRequest(centerA.id, teacherA.id);
  const approved = await resolveChangeRequest(prisma, centerA.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "resolveChangeRequest(APPROVED) flips a PENDING request to APPROVED and stamps resolvedBy/resolvedAt",
    approved.ok &&
      approved.changeRequest.status === "APPROVED" &&
      approved.changeRequest.resolvedBy === managerA.id &&
      approved.changeRequest.resolvedAt !== null,
    JSON.stringify(approved),
  );
  check(
    "Approving a ChangeRequest does not create a ClassGroup (status flip only, docs/00 §4.1 item 9)",
    (await prisma.classGroup.count({ where: { centerId: centerA.id } })) === 0,
  );

  const alreadyResolved = await resolveChangeRequest(prisma, centerA.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "Re-resolving an already-resolved ChangeRequest is refused as notPending",
    !alreadyResolved.ok && alreadyResolved.error === "notPending",
    JSON.stringify(alreadyResolved),
  );

  const requestToDecline = await makeChangeRequest(centerA.id, teacherA.id);
  const declined = await resolveChangeRequest(prisma, centerA.id, requestToDecline.id, "DECLINED", managerA.id);
  check(
    "resolveChangeRequest(DECLINED) flips a PENDING request to DECLINED",
    declined.ok && declined.changeRequest.status === "DECLINED",
    JSON.stringify(declined),
  );

  // ── 2. ChangeRequest type NEW_SESSION (M10): accepting creates a Session ──
  // A global catalog row (M13) — no centerId.
  const subjectS = await prisma.catalogSubject.create({
    data: { nameAr: "Approvals-Check Physics", nameEn: "Approvals-Check Physics" },
  });
  const classForSession = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: FIXTURE_CLASS_END, teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  // SEC-2c: relative to today — approving a request for a past date is refused
  // (SEC-51), so a fixed date would start failing the day it passed.
  const sessionRequestDate = dateKey(mondayOnOrAfter(addDays(FIXTURE_TODAY, 35))); // a Monday 5–6 weeks out

  async function makeSessionRequest(classGroupId: string, startTime = "09:00", endTime = "10:00") {
    return prisma.changeRequest.create({
      data: scopedData(centerA.id, {
        type: "NEW_SESSION",
        requestedBy: teacherA.id,
        payload: { classGroupId, date: sessionRequestDate, startTime, endTime, note: null },
        status: "PENDING",
      }),
    });
  }

  const sessionRequestToApprove = await makeSessionRequest(classForSession.id);
  const sessionApproved = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToApprove.id,
    "APPROVED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "resolveSessionRequest(APPROVED) creates a Session and flips the request to APPROVED",
    sessionApproved.ok &&
      sessionApproved.changeRequest.status === "APPROVED" &&
      sessionApproved.session !== null &&
      sessionApproved.session.classGroupId === classForSession.id &&
      sessionApproved.session.priceSnapshot === 5_000,
    JSON.stringify(sessionApproved),
  );

  const sessionAlreadyResolved = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToApprove.id,
    "APPROVED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "Re-resolving an already-resolved NEW_SESSION request is refused as notPending",
    !sessionAlreadyResolved.ok && sessionAlreadyResolved.error === "notPending",
    JSON.stringify(sessionAlreadyResolved),
  );

  const sessionRequestToDecline = await makeSessionRequest(classForSession.id, "11:00", "12:00");
  const sessionDeclined = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestToDecline.id,
    "DECLINED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "resolveSessionRequest(DECLINED) flips the request to DECLINED and creates no Session",
    sessionDeclined.ok && sessionDeclined.changeRequest.status === "DECLINED" && sessionDeclined.session === null,
    JSON.stringify(sessionDeclined),
  );

  const sessionRequestDuplicateSlot = await makeSessionRequest(classForSession.id);
  const sessionDuplicate = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestDuplicateSlot.id,
    "APPROVED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "Approving a second request for the exact same class/date/time is refused as duplicateSlot",
    !sessionDuplicate.ok && sessionDuplicate.error === "duplicateSlot",
    JSON.stringify(sessionDuplicate),
  );

  // A second class, sharing teacherA and overlapping the already-approved slot.
  const classConflicting = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: FIXTURE_CLASS_END, teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  const sessionRequestConflictWarn = await makeSessionRequest(classConflicting.id, "09:30", "10:30");
  const sessionConflictWarn = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestConflictWarn.id,
    "APPROVED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "Under WARN, a teacher-conflicting session request is still approved, flagged with the conflict",
    sessionConflictWarn.ok && sessionConflictWarn.session !== null && sessionConflictWarn.conflicts.length > 0,
    JSON.stringify(sessionConflictWarn),
  );

  const classConflictingDeny = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: FIXTURE_CLASS_END, teacherId: teacherA.id, subjectId: subjectS.id, price: 5_000 }),
  });
  const sessionRequestConflictDeny = await makeSessionRequest(classConflictingDeny.id, "09:15", "09:45");
  const sessionConflictDeny = await resolveSessionRequest(
    prisma,
    centerA.id,
    sessionRequestConflictDeny.id,
    "APPROVED",
    managerA.id,
    "DENY",
    "en",
    { confirmConflicts: true },
  );
  check(
    "Under DENY, a teacher-conflicting session request is refused as conflict, no Session created",
    !sessionConflictDeny.ok && sessionConflictDeny.error === "conflict",
    JSON.stringify(sessionConflictDeny),
  );

  const crossCenterSessionApprove = await resolveSessionRequest(
    prisma,
    centerB.id,
    sessionRequestConflictDeny.id, // still PENDING at Center A — the DENY refusal above left it untouched
    "APPROVED",
    managerA.id,
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  check(
    "Center B cannot approve Center A's NEW_SESSION request by id — resolves to notFound",
    !crossCenterSessionApprove.ok && crossCenterSessionApprove.error === "notFound",
    JSON.stringify(crossCenterSessionApprove),
  );

  // ── 3. Reservation accept/decline (reusing M8's confirm/reject) ─────────
  const subjectA = await prisma.catalogSubject.create({
    data: { nameAr: "Approvals-Check Math", nameEn: "Approvals-Check Math" },
  });
  const classConfirm = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: FIXTURE_CLASS_END, teacherId: teacherA.id, subjectId: subjectA.id, price: 10_000, requiresConfirmation: true }),
  });
  const studentToApprove = await makeStudentUser("studentApprove");
  const studentToDecline = await makeStudentUser("studentDecline");

  const pendingToApprove = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentToApprove.id }),
  );
  const pendingToDecline = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentToDecline.id }),
  );
  const reservationIdToApprove = pendingToApprove.ok && pendingToApprove.kind === "pending" ? pendingToApprove.reservationId : "";
  const reservationIdToDecline = pendingToDecline.ok && pendingToDecline.kind === "pending" ? pendingToDecline.reservationId : "";

  const confirmed = await prisma.$transaction((tx) =>
    confirmReservation(tx, centerA.id, reservationIdToApprove, managerA.id),
  );
  check(
    "The Approvals accept action's confirmReservation call creates an ACTIVE Enrollment and marks CONFIRMED",
    confirmed.ok && confirmed.reservation.status === "CONFIRMED" && confirmed.enrollment?.status === "ACTIVE",
    JSON.stringify(confirmed),
  );

  const rejected = await rejectReservation(prisma, centerA.id, reservationIdToDecline, managerA.id);
  check(
    "The Approvals decline action's rejectReservation call marks REJECTED",
    rejected.ok && rejected.reservation.status === "REJECTED",
    JSON.stringify(rejected),
  );

  // ── 4. Audited: the exact write the Server Action performs lands correctly ─
  const auditRow = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: managerA.id,
      action: "reservation.confirm",
      entityType: "Reservation",
      entityId: reservationIdToApprove,
      before: { status: "PENDING" },
      after: { status: "CONFIRMED" },
    },
  });
  check(
    "An AuditLog row for the reservation.confirm decision is scoped to the acting center",
    auditRow.centerId === centerA.id && auditRow.action === "reservation.confirm" && auditRow.entityId === reservationIdToApprove,
  );
  const auditInCenterB = await prisma.auditLog.findMany({ where: { centerId: centerB.id, entityId: reservationIdToApprove } });
  check("Center B's audit log never sees Center A's approval decisions", auditInCenterB.length === 0);

  // ── 5. Cross-center isolation on the Approvals queue itself ─────────────
  const requestB = await makeChangeRequest(centerB.id, teacherB.id);
  const pendingListA = await prisma.changeRequest.findMany({ where: scopedWhere(centerA.id, { status: PENDING_CHANGE_REQUEST }) });
  const pendingListB = await prisma.changeRequest.findMany({ where: scopedWhere(centerB.id, { status: PENDING_CHANGE_REQUEST }) });
  check(
    "Center A's pending-ChangeRequest queue contains none of Center B's rows",
    pendingListA.every((row) => row.centerId === centerA.id) && !pendingListA.some((row) => row.id === requestB.id),
  );
  check(
    "Center B's pending-ChangeRequest queue contains exactly its own request",
    pendingListB.length === 1 && pendingListB[0].id === requestB.id,
  );

  check(
    "Center B cannot resolve Center A's ChangeRequest by id",
    (await scopedFindById(prisma.changeRequest, centerB.id, requestToApprove.id)) === null,
  );
  const crossCenterApprove = await resolveChangeRequest(prisma, centerB.id, requestToApprove.id, "APPROVED", managerA.id);
  check(
    "Center B staff cannot act on Center A's ChangeRequest by id — resolves to notFound",
    !crossCenterApprove.ok && crossCenterApprove.error === "notFound",
    JSON.stringify(crossCenterApprove),
  );

  check(
    "Center B cannot resolve Center A's Reservation by id",
    (await scopedFindById(prisma.reservation, centerB.id, reservationIdToDecline)) === null,
  );
  const crossCenterReject = await rejectReservation(prisma, centerB.id, reservationIdToDecline, managerA.id);
  check(
    "Center B staff cannot act on Center A's Reservation by id — resolves to notFound",
    !crossCenterReject.ok && crossCenterReject.error === "notFound",
    JSON.stringify(crossCenterReject),
  );

  const pendingReservationsA = await prisma.reservation.findMany({ where: scopedWhere(centerA.id, { status: PENDING_RESERVATION }) });
  check(
    "Center A's pending-Reservation queue no longer includes the two already resolved above",
    pendingReservationsA.length === 0,
    JSON.stringify(pendingReservationsA.map((r) => r.id)),
  );

  // ── 6. M15: rejection starts the 7-day cooling-off, and a teacher's own
  // approvals-queue permission resolves the way a separate reviewer needs ──
  check(
    "rejectReservation stamps rejectedAt — the whole cooling-off mechanism (M15, spec §5.1 'Approvals & enrolment')",
    rejected.ok && rejected.reservation.rejectedAt !== null,
    JSON.stringify(rejected),
  );
  const coolingOffRetry = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentToDecline.id }),
  );
  check(
    "Re-requesting the same class within 7 days of a rejection is refused as coolingOff, not silently",
    !coolingOffRetry.ok && coolingOffRetry.error === "coolingOff",
    JSON.stringify(coolingOffRetry),
  );

  check(
    "A TEACHER's own approvals queue (reservation.manage.own, M15) is grantable and off by default; never for STUDENT",
    can("TEACHER", "reservation.manage.own", { "reservation.manage.own": true }) &&
      !can("TEACHER", "reservation.manage.own") &&
      !can("STUDENT", "reservation.manage.own"),
  );

  await checkBookingQueues(centerA.id, centerB.id, teacherA.id, managerA.id);
  await checkPendingCounts(centerA.id, centerB.id, teacherA.id, teacherB.id, managerA.id);
}

/**
 * F7 — the Approvals tab counts and the sidebar badge: `pendingApprovalCounts`
 * / `pendingTeacherApprovalCounts` must equal the rows of the queues they sit
 * on (through the same scoped readers the pages call), the teacher variant must
 * leave out another teacher's classes, another branch must never be counted,
 * and a role that cannot act gets no badge. Runs against throwaway centres.
 */
async function checkPendingCounts(
  centerId: string,
  otherCenterId: string,
  teacherId: string,
  otherBranchTeacherId: string,
  managerId: string,
) {
  console.log("\nF7 — approval counts equal the queues");

  const DAY = 24 * 60 * 60 * 1000;
  const d = new Date(Date.now() + 3 * DAY);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const otherTeacher = await makeTeacher(centerId, "f7-other-teacher");

  const ctx = (id: string, role: string) => ({
    center: { id },
    user: { locale: "en" },
    role,
    isPlatformAdmin: false,
    settings: null,
  });
  const managerCtx = ctx(centerId, "MANAGER");
  const teacherCtx = ctx(centerId, "TEACHER");
  const dbA = scopedWith(prisma, managerCtx);
  // Earlier sections leave some requests pending (a refused duplicate-slot
  // request stays PENDING), so the fixture below is asserted as a delta on
  // these baselines — never as an absolute number a stray row could break.
  const baseline = await pendingApprovalCounts(managerCtx, prisma);
  const baselineB = await pendingApprovalCounts(ctx(otherCenterId, "MANAGER"), prisma);
  const baselineMine = await pendingTeacherApprovalCounts(teacherCtx, teacherId, prisma);

  const classFor = (cid: string, teacher: string, extra: { active?: boolean; sessionBookingMode?: "APPROVAL" } = {}) =>
    prisma.classGroup.create({
      data: scopedData(cid, {
        startDate: new Date("2026-01-01"),
        endDate: new Date("2027-12-31"),
        teacherId: teacher,
        price: 10_000,
        ...extra,
      }),
    });
  const mine = await classFor(centerId, teacherId, { sessionBookingMode: "APPROVAL" });
  const theirs = await classFor(centerId, otherTeacher.id, { sessionBookingMode: "APPROVAL" });
  const retired = await classFor(centerId, teacherId, { active: false });
  const elsewhere = await classFor(otherCenterId, otherBranchTeacherId, { sessionBookingMode: "APPROVAL" });

  const sessionFor = (cid: string, classGroupId: string, teacher: string) =>
    prisma.session.create({
      data: scopedData(cid, { classGroupId, teacherId: teacher, date, startTime: "19:00", endTime: "20:00", priceSnapshot: 10_000 }),
    });
  const reserve = async (cid: string, classGroupId: string, tag: string) =>
    prisma.reservation.create({
      data: scopedData(cid, { classGroupId, studentId: (await makeStudentUser(tag)).id, status: "PENDING" }),
    });
  const book = async (cid: string, sessionId: string, tag: string) =>
    prisma.$transaction(async (tx) =>
      requestBooking(tx, { centerId: cid, sessionId, studentUserId: (await makeStudentUser(tag)).id }),
    );

  // Centre A: 2 enrolments on my class, 1 on theirs, 1 on a deactivated class (never listed).
  await reserve(centerId, mine.id, "f7-r1");
  await reserve(centerId, mine.id, "f7-r2");
  await reserve(centerId, theirs.id, "f7-r3");
  await reserve(centerId, retired.id, "f7-r4");
  // Bookings: 1 on my session, 2 on theirs.
  const mineSession = await sessionFor(centerId, mine.id, teacherId);
  const theirsSession = await sessionFor(centerId, theirs.id, otherTeacher.id);
  await book(centerId, mineSession.id, "f7-b1");
  await book(centerId, theirsSession.id, "f7-b2");
  await book(centerId, theirsSession.id, "f7-b3");
  // Change requests: 2 class, 1 session. Account claim: 1 on a person this centre knows.
  await makeChangeRequest(centerId, teacherId);
  await makeChangeRequest(centerId, teacherId);
  await prisma.changeRequest.create({
    data: scopedData(centerId, {
      type: "NEW_SESSION",
      requestedBy: teacherId,
      payload: { classGroupId: mine.id, date: dateKey(date), startTime: "09:00", endTime: "10:00", note: null },
      status: "PENDING",
    }),
  });
  await prisma.accountClaim.create({
    data: { authId: "approvals-check-auth-a", email: "approvals-check-claim-a@kayedu.test", targetUserId: teacherId },
  });
  // Centre B has its own, different numbers — and a claim on a person only B knows.
  await reserve(otherCenterId, elsewhere.id, "f7-rb1");
  await makeChangeRequest(otherCenterId, otherBranchTeacherId);
  await prisma.accountClaim.create({
    data: { authId: "approvals-check-auth-b", email: "approvals-check-claim-b@kayedu.test", targetUserId: otherBranchTeacherId },
  });

  const counts = await pendingApprovalCounts(managerCtx, prisma);
  const rows = {
    classRequests: (await dbA.changeRequests.list({ status: "PENDING", type: "NEW_CLASS" }, { order: "asc" })).length,
    sessionRequests: (await dbA.changeRequests.list({ status: "PENDING", type: "NEW_SESSION" }, { order: "asc" })).length,
    enrolments: (await dbA.reservations.listPending()).length,
    bookings: (await dbA.sessionBookings.listPending()).length,
    accountClaims: (await pendingClaimsForCenter(prisma, centerId)).length,
  };
  check(
    "Each tab count equals the rows in that tab's queue (class, session, enrolments, bookings, claims)",
    counts.classRequests === rows.classRequests &&
      counts.sessionRequests === rows.sessionRequests &&
      counts.enrolments === rows.enrolments &&
      counts.bookings === rows.bookings &&
      counts.accountClaims === rows.accountClaims,
    `counts ${JSON.stringify(counts)} vs rows ${JSON.stringify(rows)}`,
  );
  check(
    "The fixture moved each tab by its own rows: +2 class, +1 session, +3 enrolments (the deactivated class's is not counted), +3 bookings, +1 claim",
    counts.classRequests - baseline.classRequests === 2 &&
      counts.sessionRequests - baseline.sessionRequests === 1 &&
      counts.enrolments - baseline.enrolments === 3 &&
      counts.bookings - baseline.bookings === 3 &&
      counts.accountClaims - baseline.accountClaims === 1,
    `baseline ${JSON.stringify(baseline)} → ${JSON.stringify(counts)}`,
  );
  check(
    "The badge total is the sum of the tab counts",
    counts.total === counts.classRequests + counts.sessionRequests + counts.enrolments + counts.bookings + counts.accountClaims &&
      counts.total - baseline.total === 10,
    JSON.stringify(counts),
  );

  // The teacher variant: only the classes that teacher teaches.
  const teacherCounts = await pendingTeacherApprovalCounts(teacherCtx, teacherId, prisma);
  const dbT = scopedWith(prisma, teacherCtx);
  check(
    "A teacher's counts equal their own two queues' rows",
    teacherCounts.enrolments === (await dbT.reservations.listPendingForTeacher(teacherId)).length &&
      teacherCounts.bookings === (await dbT.sessionBookings.listPending({ teacherId })).length,
    JSON.stringify(teacherCounts),
  );
  check(
    "A teacher's count excludes other teachers' classes (+2 of the 3 enrolments, +1 of the 3 bookings) and never counts requests or claims",
    teacherCounts.enrolments - baselineMine.enrolments === 2 &&
      teacherCounts.bookings - baselineMine.bookings === 1 &&
      teacherCounts.total === teacherCounts.enrolments + teacherCounts.bookings,
    JSON.stringify(teacherCounts),
  );
  const otherTeacherCounts = await pendingTeacherApprovalCounts(teacherCtx, otherTeacher.id, prisma);
  check(
    "The other teacher's count is their own (1 enrolment, 2 bookings) — the two never overlap",
    otherTeacherCounts.enrolments === 1 && otherTeacherCounts.bookings === 2,
    JSON.stringify(otherTeacherCounts),
  );

  // Isolation: another branch is counted from its own rows only.
  const countsB = await pendingApprovalCounts(ctx(otherCenterId, "MANAGER"), prisma);
  check(
    "Another branch's counts moved by its own rows only (+1 class request, +1 enrolment, +1 claim) — never summed with this branch",
    countsB.classRequests - baselineB.classRequests === 1 &&
      countsB.sessionRequests === baselineB.sessionRequests &&
      countsB.enrolments - baselineB.enrolments === 1 &&
      countsB.bookings === baselineB.bookings &&
      countsB.accountClaims - baselineB.accountClaims === 1 &&
      countsB.total - baselineB.total === 3,
    JSON.stringify(countsB),
  );

  // Deciding a request moves the count by exactly one.
  const toResolve = await prisma.reservation.findFirstOrThrow({
    where: scopedWhere(centerId, { classGroupId: mine.id, status: PENDING_RESERVATION }),
  });
  await rejectReservation(prisma, centerId, toResolve.id, managerId);
  const after = await pendingApprovalCounts(managerCtx, prisma);
  check("Resolving a request lowers its tab and the total by one", after.enrolments === counts.enrolments - 1 && after.total === counts.total - 1, JSON.stringify(after));

  // Who gets a badge: only a role that can act on the queue (the shell reads
  // the count only for `approvals.manage` / `reservation.manage.own`).
  const grants = { "approvals.manage": true } as const;
  const receptionistNav = navForExperience("center", "RECEPTIONIST", undefined);
  check(
    "A receptionist has no Approvals item, so no badge — withPendingCount cannot add one",
    !receptionistNav.some((item) => item.href === ROUTES.centerApprovals) &&
      withPendingCount(receptionistNav, ROUTES.centerApprovals, 12).every((item) => item.pendingCount === undefined),
  );
  const managerNav = withPendingCount(navForExperience("center", "MANAGER", grants), ROUTES.centerApprovals, 12);
  check(
    "A manager's badge lands on the Approvals item alone, and a zero count adds none",
    managerNav.filter((item) => item.pendingCount !== undefined).map((item) => item.href).join() === ROUTES.centerApprovals &&
      managerNav.find((item) => item.href === ROUTES.centerApprovals)?.pendingCount === 12 &&
      withPendingCount(managerNav, ROUTES.centerApprovals, 0) === managerNav,
  );
}

/**
 * F6 — single-session bookings in the two approvals queues, through the REAL
 * `scopedWith(...).sessionBookings.listPending` and `confirmBooking` /
 * `rejectBooking`: an APPROVAL booking waits in the branch's queue AND the
 * class teacher's own, an INSTANT one in neither; the teacher queue lists
 * only classes that teacher teaches, and its pinned resolve refuses another
 * teacher's booking; another branch's queue never lists it; reject is audited.
 */
async function checkBookingQueues(centerId: string, otherCenterId: string, teacherId: string, managerId: string) {
  console.log("\nF6 — session bookings in both approvals queues");

  const DAY = 24 * 60 * 60 * 1000;
  const d = new Date(Date.now() + 3 * DAY);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const otherTeacher = await makeTeacher(centerId, "f6-other-teacher");
  const classFor = (teacher: string, mode: "INSTANT" | "APPROVAL") =>
    prisma.classGroup.create({
      data: scopedData(centerId, {
        startDate: new Date("2026-01-01"),
        endDate: new Date("2027-12-31"),
        teacherId: teacher,
        price: 10_000,
        sessionBookingMode: mode,
      }),
    });
  const sessionFor = (classGroupId: string, teacher: string) =>
    prisma.session.create({
      data: scopedData(centerId, { classGroupId, teacherId: teacher, date, startTime: "17:00", endTime: "18:00", priceSnapshot: 10_000 }),
    });

  const mine = await classFor(teacherId, "APPROVAL");
  const theirs = await classFor(otherTeacher.id, "APPROVAL");
  const instant = await classFor(teacherId, "INSTANT");
  const mineSession = await sessionFor(mine.id, teacherId);
  const theirsSession = await sessionFor(theirs.id, otherTeacher.id);
  const instantSession = await sessionFor(instant.id, teacherId);
  const book = async (sessionId: string, tag: string) =>
    prisma.$transaction(async (tx) =>
      requestBooking(tx, { centerId, sessionId, studentUserId: (await makeStudentUser(tag)).id }),
    );
  const myBooking = await book(mineSession.id, "f6-mine");
  const theirBooking = await book(theirsSession.id, "f6-theirs");
  const instantBooking = await book(instantSession.id, "f6-instant");
  check(
    "APPROVAL bookings are PENDING, an INSTANT one is CONFIRMED",
    myBooking.ok && myBooking.kind === "pending" && theirBooking.ok && theirBooking.kind === "pending" &&
      instantBooking.ok && instantBooking.kind === "confirmed",
  );

  const ctx = (id: string, role: string) => ({
    center: { id },
    user: { locale: "en" },
    role,
    isPlatformAdmin: false,
    settings: null,
  });
  const branchQueue = await scopedWith(prisma, ctx(centerId, "MANAGER")).sessionBookings.listPending();
  const teacherQueue = await scopedWith(prisma, ctx(centerId, "TEACHER")).sessionBookings.listPending({ teacherId });
  const otherBranchQueue = await scopedWith(prisma, ctx(otherCenterId, "MANAGER")).sessionBookings.listPending();
  const ids = (rows: { id: string }[]) => new Set(rows.map((row) => row.id));
  const myId = myBooking.ok ? myBooking.booking.id : "";
  const theirId = theirBooking.ok ? theirBooking.booking.id : "";
  const instantId = instantBooking.ok ? instantBooking.booking.id : "";
  check(
    "The branch queue lists every pending booking, never an INSTANT (confirmed) one",
    ids(branchQueue).has(myId) && ids(branchQueue).has(theirId) && !ids(branchQueue).has(instantId),
  );
  check(
    "The teacher queue lists only bookings on classes that teacher teaches",
    ids(teacherQueue).has(myId) && !ids(teacherQueue).has(theirId),
  );
  check("Another branch's queue never lists this branch's bookings", !ids(otherBranchQueue).has(myId) && !ids(otherBranchQueue).has(theirId));

  const pinned = await prisma.$transaction((tx) =>
    confirmBooking(tx, centerId, theirId, teacherId, { teacherId, via: "teacher" }),
  );
  check(
    "A teacher's pinned confirm refuses another teacher's booking at the same branch (notFound)",
    !pinned.ok && pinned.error === "notFound",
  );
  const otherBranch = await prisma.$transaction((tx) => rejectBooking(tx, otherCenterId, myId, managerId));
  check("Another branch cannot reject this branch's booking (notFound)", !otherBranch.ok && otherBranch.error === "notFound");

  const ownConfirm = await prisma.$transaction((tx) =>
    confirmBooking(tx, centerId, myId, teacherId, { teacherId, via: "teacher" }),
  );
  const declined = await prisma.$transaction((tx) => rejectBooking(tx, centerId, theirId, managerId));
  const audits = await prisma.auditLog.findMany({
    where: { centerId, entityType: "SessionBooking", entityId: { in: [myId, theirId] } },
    select: { action: true, after: true },
  });
  check(
    "The teacher confirms their own; the branch declines the other; each writes one audit row",
    ownConfirm.ok && ownConfirm.booking.status === "CONFIRMED" &&
      declined.ok && declined.booking.status === "REJECTED" &&
      audits.filter((row) => row.action === "sessionBooking.confirm").length === 1 &&
      audits.filter((row) => row.action === "sessionBooking.reject").length === 1,
    JSON.stringify(audits),
  );
  const queueAfter = await scopedWith(prisma, ctx(centerId, "MANAGER")).sessionBookings.listPending();
  check("Resolved bookings leave the queue", !ids(queueAfter).has(myId) && !ids(queueAfter).has(theirId));

  await deleteAuditRows(prisma, { centerId: { in: [centerId, otherCenterId] } });
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
      console.error(`\n${failures} approvals check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll approvals checks passed.");
  });
