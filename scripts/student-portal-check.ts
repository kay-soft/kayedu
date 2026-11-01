/**
 * Student portal check — the M8 acceptance gate (docs/03-build-order.md M8
 * "Done when": "a student reserves a class, the center/teacher confirms per
 * the rule, and the class appears in the student's personal schedule").
 *
 * Run with:  npm run check:student-portal
 *
 * Exercises the real production functions — `lib/db/reservations.ts` (the
 * module Discover's Server Action and a future Approvals screen both call),
 * `lib/db/discover.ts`/`lib/db/student-portal.ts` (the cross-center read
 * helpers Discover/Schedule/My Reservations call) and the tenant-scoping
 * primitives (`lib/db/tenant-scope.ts`) — against two throwaway centers.
 * Needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { type BlockScope } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  cancelReservation,
  confirmReservation,
  leaveClass,
  rejectReservation,
  reserveOrEnroll,
} from "../lib/db/reservations.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import {
  BOOKING_CAPS,
  bookingDisplayStatus,
  cancelBookingByStaff,
  cancelBookingByStudent,
  confirmBooking,
  rejectBooking,
  requestBooking,
  upcomingBookableSessions,
} from "../lib/db/session-bookings.ts";
import { generateFamilyCode, hashFamilyCode } from "../lib/db/parents.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { dateKey, dayMarker, zonedDateTimeToUtc } from "../lib/scheduling.ts";
import { calendarGrid, calendarMonthRange, parseCalendarDay, parseCalendarMonth } from "../lib/calendar.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import {
  bookedCalendarEntries,
  childBookedUpcoming,
  studentCalendarMonth,
  studentActiveEnrollmentClassIds,
  studentBlockedRefsByCenter,
  studentBookedUpcoming,
  studentReservationStatusByClass,
  studentUpcomingSessions,
} from "../lib/db/student-portal.ts";
import {
  listPublicBranches,
  publicBranchBySlug,
  publicBranchLogo,
  publicClassById,
  publicClassImage,
  publicClassesForBranch,
  publicTeacherAt,
  searchPublicClasses,
  EXPLORE_BRANCH_PAGE_SIZE,
} from "../lib/db/public-catalog.ts";

const prisma = await gatePrisma();

const SLUG_A = "student-portal-check-a";
const SLUG_B = "student-portal-check-b";
/** F5 — one branch per listing case. */
const PUBLIC_SLUGS = {
  listed: "student-portal-check-pub-listed",
  grace: "student-portal-check-pub-grace",
  unlisted: "student-portal-check-pub-unlisted",
  onboarding: "student-portal-check-pub-onboarding",
  suspended: "student-portal-check-pub-suspended",
  archived: "student-portal-check-pub-archived",
} as const;
/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER_SCOPE: BlockScope = "TEACHER";
const CLASS_SCOPE: BlockScope = "CLASS";

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
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B, ...Object.values(PUBLIC_SLUGS)] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "student-portal-check-" } } });
  // F4 fixture grades are global catalog rows — they do not cascade away with the centres.
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: "Student-Portal-Check" } } });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email: `student-portal-check-${tag}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

async function makeStudentUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `student-portal-check-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeClass(
  centerId: string,
  teacherId: string,
  opts: { requiresConfirmation?: boolean; capacity?: number; acceptsNewStudents?: boolean } = {},
) {
  // R3 fixture shape: a class's seats come from its room set, so a
  // "capacity-N class" is a class on a capacity-N room.
  const room = opts.capacity
    ? await prisma.room.create({
        data: scopedData(centerId, { name: `SP room ${Math.random()}`, capacity: opts.capacity }),
      })
    : null;
  return prisma.classGroup.create({
    data: scopedData(centerId, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId,
      roomId: room?.id ?? null,
      price: 10_000,
      requiresConfirmation: opts.requiresConfirmation ?? false,
      acceptsNewStudents: opts.acceptsNewStudents ?? true,
    }),
  });
}

async function main() {
  await cleanup();

  console.log("Database-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Student Portal A", organization: { create: { name: "Student Portal A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Student Portal B", organization: { create: { name: "Student Portal B" } } },
  });

  const teacherA = await makeTeacher(centerA.id, "teacherA");
  const teacherB = await makeTeacher(centerB.id, "teacherB");

  const classInstant = await makeClass(centerA.id, teacherA.id, { capacity: 1 });
  const classConfirm = await makeClass(centerA.id, teacherA.id, { requiresConfirmation: true });
  const classReRequest = await makeClass(centerA.id, teacherA.id, { requiresConfirmation: true });
  const classBlockedTeacher = await makeClass(centerA.id, teacherA.id);
  const classBlockedClass = await makeClass(centerA.id, teacherA.id);
  const classNotAccepting = await makeClass(centerA.id, teacherA.id, { acceptsNewStudents: false });
  const classB = await makeClass(centerB.id, teacherB.id);

  const studentX = await makeStudentUser("studentX");
  const studentY = await makeStudentUser("studentY");
  const studentBlocked = await makeStudentUser("studentBlocked");
  const isolationStudent = await makeStudentUser("isolation");

  // ── 1. Instant enroll (requiresConfirmation = false) ─────────────────────
  const instantResult = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classInstant.id, studentUserId: studentX.id }),
  );
  check(
    "Instant enroll writes an ACTIVE Enrollment directly, no Reservation row",
    instantResult.ok && instantResult.kind === "enrolled",
    JSON.stringify(instantResult),
  );
  const reservationForInstant = await prisma.reservation.findFirst({
    where: { classGroupId: classInstant.id, studentId: studentX.id },
  });
  check("Instant enroll never creates a Reservation row", reservationForInstant === null);
  const profileX = await prisma.studentProfile.findFirst({ where: { userId: studentX.id, centerId: centerA.id } });
  check("Instant enroll creates the StudentProfile at that center", profileX !== null);

  // ── 2. Capacity enforcement ───────────────────────────────────────────────
  const capacityResult = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classInstant.id, studentUserId: studentY.id }),
  );
  check(
    "A capacity-1 class's second instant-enroll is refused as classFull",
    !capacityResult.ok && capacityResult.error === "classFull",
    JSON.stringify(capacityResult),
  );

  // ── 3. Duplicate-enrollment prevention ────────────────────────────────────
  const duplicateEnroll = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classInstant.id, studentUserId: studentX.id }),
  );
  check(
    "Re-submitting an instant enroll for the same student/class is refused as alreadyEnrolled",
    !duplicateEnroll.ok && duplicateEnroll.error === "alreadyEnrolled",
    JSON.stringify(duplicateEnroll),
  );

  // ── 4. Requires confirmation → PENDING Reservation, no profile yet ───────
  const pendingResult = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentY.id }),
  );
  check(
    "requiresConfirmation writes a PENDING Reservation",
    pendingResult.ok && pendingResult.kind === "pending",
    JSON.stringify(pendingResult),
  );
  const profileYBeforeConfirm = await prisma.studentProfile.findFirst({
    where: { userId: studentY.id, centerId: centerA.id },
  });
  check(
    "A pending request alone does not create a StudentProfile",
    profileYBeforeConfirm === null,
  );

  // ── 5. Duplicate-reservation prevention ───────────────────────────────────
  const duplicatePending = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classConfirm.id, studentUserId: studentY.id }),
  );
  check(
    "A second request for the same PENDING class/student is refused as alreadyRequested",
    !duplicatePending.ok && duplicatePending.error === "alreadyRequested",
    JSON.stringify(duplicatePending),
  );

  // ── 6. Blocked-student denial — both StudentBlock scopes ─────────────────
  await prisma.studentBlock.create({
    data: scopedData(centerA.id, { scope: TEACHER_SCOPE, refId: teacherA.id, blockedUserId: studentBlocked.id }),
  });
  const blockedByTeacher = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classBlockedTeacher.id, studentUserId: studentBlocked.id }),
  );
  check(
    "A student blocked from the teacher (scope TEACHER) is denied",
    !blockedByTeacher.ok && blockedByTeacher.error === "studentBlocked",
    JSON.stringify(blockedByTeacher),
  );

  await prisma.studentBlock.create({
    data: scopedData(centerA.id, { scope: CLASS_SCOPE, refId: classBlockedClass.id, blockedUserId: studentX.id }),
  });
  const blockedByClass = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classBlockedClass.id, studentUserId: studentX.id }),
  );
  check(
    "A student blocked from the class (scope CLASS) is denied",
    !blockedByClass.ok && blockedByClass.error === "studentBlocked",
    JSON.stringify(blockedByClass),
  );

  // ── 7. acceptsNewStudents = false ─────────────────────────────────────────
  const notAccepting = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classNotAccepting.id, studentUserId: studentX.id }),
  );
  check(
    "A class with acceptsNewStudents=false refuses new requests",
    !notAccepting.ok && notAccepting.error === "notAcceptingStudents",
    JSON.stringify(notAccepting),
  );

  // ── 8. A spoofed centerId/classGroupId pair resolves to notFound ─────────
  const spoofed = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerB.id, classGroupId: classInstant.id, studentUserId: studentX.id }),
  );
  check(
    "A classGroupId that does not belong to the given centerId resolves to notFound",
    !spoofed.ok && spoofed.error === "notFound",
    JSON.stringify(spoofed),
  );

  // ── 9. Confirming a PENDING reservation creates the Enrollment ───────────
  const confirmed = await prisma.$transaction((tx) =>
    confirmReservation(tx, centerA.id, pendingResult.ok && pendingResult.kind === "pending" ? pendingResult.reservationId : "", teacherA.id),
  );
  check(
    "confirmReservation creates an ACTIVE Enrollment and marks the Reservation CONFIRMED",
    confirmed.ok && confirmed.reservation.status === "CONFIRMED" && confirmed.enrollment?.status === "ACTIVE",
    JSON.stringify(confirmed),
  );
  const profileYAfterConfirm = await prisma.studentProfile.findFirst({
    where: { userId: studentY.id, centerId: centerA.id },
  });
  check("Confirming a reservation creates the StudentProfile at that center", profileYAfterConfirm !== null);

  // ── 10. Reject → re-request reuses the same Reservation row ──────────────
  // (M15, spec §5.1 "Approvals & enrolment": a rejected student cannot
  // re-request the same class for 7 days — full coverage of that cooling-off
  // lives in `npm run check:enrollment`; this just confirms the pre-existing
  // "same row reused" guarantee still holds once the cooldown has elapsed.)
  const firstRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classReRequest.id, studentUserId: studentX.id }),
  );
  const firstReservationId = firstRequest.ok && firstRequest.kind === "pending" ? firstRequest.reservationId : "";
  const rejected = await rejectReservation(prisma, centerA.id, firstReservationId, teacherA.id);
  check("rejectReservation marks a PENDING request REJECTED", rejected.ok && rejected.reservation.status === "REJECTED");

  const immediateRetry = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classReRequest.id, studentUserId: studentX.id }),
  );
  check(
    "Re-requesting immediately after REJECTED is refused as coolingOff (M15)",
    !immediateRetry.ok && immediateRetry.error === "coolingOff",
    JSON.stringify(immediateRetry),
  );

  const eightDaysAgo = new Date();
  eightDaysAgo.setUTCDate(eightDaysAgo.getUTCDate() - 8);
  await prisma.reservation.update({ where: { id: firstReservationId }, data: { rejectedAt: eightDaysAgo } });

  const secondRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classReRequest.id, studentUserId: studentX.id }),
  );
  check(
    "Once the cooling-off has elapsed, re-requesting after REJECTED succeeds and reuses the same row (the (classGroupId, studentId) unique constraint)",
    secondRequest.ok &&
      secondRequest.kind === "pending" &&
      secondRequest.reservationId === firstReservationId,
    JSON.stringify(secondRequest),
  );
  const reservationRowCount = await prisma.reservation.count({
    where: { classGroupId: classReRequest.id, studentId: studentX.id },
  });
  check("Exactly one Reservation row exists across the whole reject/re-request lifecycle", reservationRowCount === 1);

  // ── 11. A student cancelling their own PENDING reservation ───────────────
  const cancelled = await cancelReservation(prisma, centerA.id, firstReservationId, studentX.id);
  check("cancelReservation marks the student's own PENDING request CANCELLED", cancelled.ok && cancelled.reservation.status === "CANCELLED");

  const cancelSomeoneElses = await cancelReservation(prisma, centerA.id, firstReservationId, studentY.id);
  check(
    "A student cannot cancel a reservation that isn't theirs",
    !cancelSomeoneElses.ok && cancelSomeoneElses.error === "notFound",
  );

  const cancelAlreadyResolved = await cancelReservation(prisma, centerA.id, firstReservationId, studentX.id);
  check(
    "Cancelling an already-resolved (CANCELLED) reservation is refused",
    !cancelAlreadyResolved.ok && cancelAlreadyResolved.error === "notPending",
  );

  // ── 12. Cross-center isolation on a student's own reservations/enrollments ─
  await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classBlockedTeacher.id, studentUserId: isolationStudent.id }),
  );
  await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerB.id, classGroupId: classB.id, studentUserId: isolationStudent.id }),
  );

  const enrolledClassIds = await studentActiveEnrollmentClassIds(prisma, isolationStudent.id);
  check(
    "A student's own active-enrollment union spans exactly the centers they actually joined — Center A's class and Center B's class, nothing else",
    enrolledClassIds.has(classBlockedTeacher.id) &&
      enrolledClassIds.has(classB.id) &&
      enrolledClassIds.size === 2,
    JSON.stringify([...enrolledClassIds]),
  );

  const blockedRefs = await studentBlockedRefsByCenter(prisma, studentBlocked.id);
  check(
    "A block placed at Center A does not appear under Center B in the per-center block map (M3 regression)",
    blockedRefs.get(centerA.id)?.teacherIds.has(teacherA.id) === true &&
      !blockedRefs.has(centerB.id),
    JSON.stringify([...blockedRefs.entries()].map(([id, v]) => [id, [...v.teacherIds]])),
  );

  const reservationStatusMap = await studentReservationStatusByClass(prisma, studentY.id);
  check(
    "A student's own reservation-status map is keyed correctly across every center they requested at",
    reservationStatusMap.get(classConfirm.id) === "CONFIRMED",
    JSON.stringify([...reservationStatusMap.entries()]),
  );

  check(
    "Center B cannot resolve Center A's Reservation by id",
    (await scopedFindById(
      prisma.reservation,
      centerB.id,
      (await prisma.reservation.findFirstOrThrow({ where: { classGroupId: classConfirm.id, studentId: studentY.id } })).id,
    )) === null,
  );
  check(
    "Center B cannot resolve Center A's StudentProfile by id",
    (await scopedFindById(prisma.studentProfile, centerB.id, profileX!.id)) === null,
  );
  check(
    "Center B cannot resolve Center A's Enrollment by id",
    (await scopedFindById(
      prisma.enrollment,
      centerB.id,
      (await prisma.enrollment.findFirstOrThrow({ where: { classGroupId: classInstant.id, studentProfileId: profileX!.id } })).id,
    )) === null,
  );

  // A direct scoped query for Center A's data must never surface Center B's rows.
  const centerAReservations = await prisma.reservation.findMany({ where: scopedWhere(centerA.id, {}) });
  check(
    "A centerId-scoped Reservation query returns only that center's rows",
    centerAReservations.every((row) => row.centerId === centerA.id),
  );

  await checkAccountSeeding(centerA, centerB, teacherA, teacherB);
  await checkPublicCatalog();
  await checkSessionBookings(centerA, centerB, teacherA);
  await checkCalendar(centerA, centerB, teacherA);
}

/**
 * U8 - "Leave class": a student ends only their own ACTIVE enrolment, at their
 * own branch; the row is REMOVED and marked as the student's doing, audited
 * with ids only; the schedule drops it; and rejoining goes through the normal
 * join (instant, or a fresh request that staff confirm), with no cooling-off.
 */
async function checkLeaveClass(
  centerA: { id: string },
  centerB: { id: string },
  teacherA: { id: string },
): Promise<void> {
  console.log("\nU8 - leave a class");

  const instant = await makeClass(centerA.id, teacherA.id);
  const approval = await makeClass(centerA.id, teacherA.id, { requiresConfirmation: true });
  const leaver = await makeStudentUser("u8-leaver");
  const mate = await makeStudentUser("u8-mate");
  const outsider = await makeStudentUser("u8-outsider");
  const removedByStaff = await makeStudentUser("u8-staff-removed");

  const join = (classGroupId: string, studentUserId: string) =>
    prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId: centerA.id, classGroupId, studentUserId }));
  const leave = (centerId: string, classGroupId: string, studentUserId: string) =>
    prisma.$transaction((tx) => leaveClass(tx, { centerId, classGroupId, studentUserId }));
  const enrollmentOf = (studentUserId: string, classGroupId: string) =>
    prisma.enrollment.findFirstOrThrow({ where: { classGroupId, studentProfile: { userId: studentUserId } } });

  await join(instant.id, leaver.id);
  await join(instant.id, mate.id);
  const session = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: instant.id,
      teacherId: teacherA.id,
      date: dayMarker("2027-06-15"),
      startTime: "16:00",
      endTime: "17:00",
      timezone: "Africa/Cairo",
      priceSnapshot: 10_000,
    }),
  });
  const leaverProfile = await prisma.studentProfile.findFirstOrThrow({ where: { userId: leaver.id, centerId: centerA.id } });
  const mateProfile = await prisma.studentProfile.findFirstOrThrow({ where: { userId: mate.id, centerId: centerA.id } });
  const today = dayMarker("2026-11-01");
  const range = calendarMonthRange(parseCalendarMonth("2027-06", today));

  const calendarBefore = await studentCalendarMonth(prisma, centerA.id, leaverProfile.id, range, today);
  check(
    "The calendar entry of an enrolled session names its class (the day list's Leave class)",
    calendarBefore.some((row) => row.sessionId === session.id && row.status === "UPCOMING" && row.classGroupId === instant.id),
    JSON.stringify(calendarBefore.map((row) => [row.status, row.classGroupId])),
  );

  // Only the student's own ACTIVE enrolment, at their own branch.
  const byOutsider = await leave(centerA.id, instant.id, outsider.id);
  check("A student with no enrolment in the class cannot end anyone's (notFound)", !byOutsider.ok && byOutsider.error === "notFound", JSON.stringify(byOutsider));
  const wrongBranch = await leave(centerB.id, instant.id, leaver.id);
  check("Another branch's centre id finds no enrolment to end (notFound)", !wrongBranch.ok && wrongBranch.error === "notFound", JSON.stringify(wrongBranch));
  check(
    "Both enrolments are untouched by the refusals",
    (await enrollmentOf(leaver.id, instant.id)).status === "ACTIVE" && (await enrollmentOf(mate.id, instant.id)).status === "ACTIVE",
  );

  // Staff-ended and blocked rows are not the student's to end.
  await join(instant.id, removedByStaff.id);
  const staffRow = await enrollmentOf(removedByStaff.id, instant.id);
  await prisma.enrollment.update({ where: { id: staffRow.id }, data: { status: "REMOVED" } });
  const onRemoved = await leave(centerA.id, instant.id, removedByStaff.id);
  await prisma.enrollment.update({ where: { id: staffRow.id }, data: { status: "BLOCKED" } });
  const onBlocked = await leave(centerA.id, instant.id, removedByStaff.id);
  const staffRowAfter = await enrollmentOf(removedByStaff.id, instant.id);
  check(
    "A removed or blocked enrolment cannot be 'left' (notFound) and is not marked as the student's doing",
    !onRemoved.ok && !onBlocked.ok && staffRowAfter.status === "BLOCKED" && staffRowAfter.leftByStudentAt === null,
  );

  // Leaving.
  const left = await leave(centerA.id, instant.id, leaver.id);
  const leaverRow = await enrollmentOf(leaver.id, instant.id);
  check(
    "Leaving ends the student's own enrolment: REMOVED, marked as left by the student",
    left.ok && leaverRow.status === "REMOVED" && leaverRow.leftByStudentAt !== null,
    JSON.stringify(leaverRow),
  );
  check("...and leaves the classmate's enrolment alone", (await enrollmentOf(mate.id, instant.id)).status === "ACTIVE");
  const again = await leave(centerA.id, instant.id, leaver.id);
  check("Leaving twice is refused (notFound)", !again.ok && again.error === "notFound", JSON.stringify(again));

  const audit = await prisma.auditLog.findMany({ where: { centerId: centerA.id, action: "enrollment.leave" } });
  check(
    "Exactly one enrollment.leave audit row, by the student, with ids and statuses only",
    audit.length === 1 &&
      audit[0].actorUserId === leaver.id &&
      audit[0].entityType === "Enrollment" &&
      audit[0].entityId === leaverRow.id &&
      forbiddenAuditKey(audit[0].before) === null &&
      forbiddenAuditKey(audit[0].after) === null,
    JSON.stringify(audit),
  );

  const enrolledIds = await studentActiveEnrollmentClassIds(prisma, leaver.id);
  const leaverSchedule = await studentUpcomingSessions(prisma, centerA.id, leaverProfile.id, today);
  const mateSchedule = await studentUpcomingSessions(prisma, centerA.id, mateProfile.id, today);
  const calendarAfter = await studentCalendarMonth(prisma, centerA.id, leaverProfile.id, range, today);
  check(
    "The class leaves the student's enrolled set, schedule and calendar; the classmate's stay",
    !enrolledIds.has(instant.id) &&
      !leaverSchedule.some((row) => row.id === session.id) &&
      !calendarAfter.some((row) => row.sessionId === session.id) &&
      mateSchedule.some((row) => row.id === session.id),
  );

  // Rejoin: the normal join, no cooling-off.
  const rejoined = await join(instant.id, leaver.id);
  const rejoinedRow = await enrollmentOf(leaver.id, instant.id);
  check(
    "Rejoining an instant class works at once: ACTIVE again, no longer marked as left, enrolled from now",
    rejoined.ok &&
      rejoined.kind === "enrolled" &&
      rejoinedRow.status === "ACTIVE" &&
      rejoinedRow.leftByStudentAt === null &&
      rejoinedRow.enrolledAt.getTime() >= (leaverRow.leftByStudentAt?.getTime() ?? Infinity),
    JSON.stringify(rejoined),
  );

  // A class that needs approval: the old CONFIRMED request is finished, so a
  // fresh request is allowed and is confirmed like any other.
  const asked = await join(approval.id, leaver.id);
  const confirmedFirst = await prisma.$transaction((tx) =>
    confirmReservation(tx, centerA.id, asked.ok && asked.kind === "pending" ? asked.reservationId : "", teacherA.id),
  );
  const leftApproval = await leave(centerA.id, approval.id, leaver.id);
  const askedAgain = await join(approval.id, leaver.id);
  check(
    "After leaving an approval class a new request is allowed (not alreadyEnrolled) and reuses the request row",
    confirmedFirst.ok &&
      leftApproval.ok &&
      askedAgain.ok &&
      askedAgain.kind === "pending" &&
      asked.ok &&
      asked.kind === "pending" &&
      askedAgain.reservationId === asked.reservationId,
    JSON.stringify(askedAgain),
  );
  const confirmedAgain = await prisma.$transaction((tx) =>
    confirmReservation(tx, centerA.id, askedAgain.ok && askedAgain.kind === "pending" ? askedAgain.reservationId : "", teacherA.id),
  );
  const approvalRow = await enrollmentOf(leaver.id, approval.id);
  check(
    "...and confirming it reactivates the same enrolment, no longer marked as left",
    confirmedAgain.ok && approvalRow.status === "ACTIVE" && approvalRow.leftByStudentAt === null,
    JSON.stringify(confirmedAgain),
  );
}

/**
 * U7 — the student (and parent) calendar: the month rules, and every status
 * `studentCalendarMonth` reads from the schedule's own data — attended,
 * absent, a drop-in who never came, cancelled, upcoming, a live session not
 * yet arrived, a moved original — plus "an enrolled session wins over a
 * booking" and branch isolation.
 */
async function checkCalendar(
  centerA: { id: string },
  centerB: { id: string },
  teacherA: { id: string },
): Promise<void> {
  console.log("\nU7 — the calendar");

  check(
    "?month=YYYY-MM parses; a malformed month falls back to today's",
    dateKey(parseCalendarMonth("2026-05", dayMarker("2026-10-31"))) === "2026-05-01" &&
      dateKey(parseCalendarMonth("2026-13", dayMarker("2026-10-31"))) === "2026-10-01",
  );
  const november = calendarGrid(dayMarker("2026-11-01"), 6);
  check(
    "The grid holds whole weeks opening on the week start (Saturday in Arabic, Sunday in English)",
    november[0].getUTCDay() === 6 &&
      november.length % 7 === 0 &&
      november.some((day) => dateKey(day) === "2026-11-30") &&
      calendarGrid(dayMarker("2026-11-01"), 0)[0].getUTCDay() === 0,
  );
  check(
    "?day= must be inside the month shown; else today when today is in it, else none",
    parseCalendarDay("2026-11-20", dayMarker("2026-11-01"), dayMarker("2026-11-15")) === "2026-11-20" &&
      parseCalendarDay("2026-12-01", dayMarker("2026-11-01"), dayMarker("2026-11-15")) === "2026-11-15" &&
      parseCalendarDay("2026-11-31", dayMarker("2026-11-01"), dayMarker("2026-10-15")) === null,
  );

  const DAY = 24 * 60 * 60 * 1000;
  const utcDay = (offset: number) => {
    const d = new Date(Date.now() + offset * DAY);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const today = utcDay(0);
  const range = { start: utcDay(-10), end: utcDay(10) };

  const enrolledClass = await makeClass(centerA.id, teacherA.id);
  const otherClass = await makeClass(centerA.id, teacherA.id);
  const student = await makeStudentUser("u7-calendar");
  const enrol = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: enrolledClass.id, studentUserId: student.id }),
  );
  check("fixture: the calendar student is enrolled", enrol.ok);
  const profile = await prisma.studentProfile.findFirstOrThrow({ where: { centerId: centerA.id, userId: student.id } });

  let hour = 7;
  const session = (classGroupId: string, offset: number, extra: { status?: "CANCELLED"; closedAt?: Date; rescheduledToId?: string } = {}) => {
    hour += 1;
    return prisma.session.create({
      data: scopedData(centerA.id, {
        classGroupId,
        teacherId: teacherA.id,
        date: utcDay(offset),
        startTime: `${String(hour).padStart(2, "0")}:00`,
        endTime: `${String(hour).padStart(2, "0")}:45`,
        priceSnapshot: 10_000,
        ...extra,
      }),
    });
  };
  const attend = (sessionId: string, attendanceStatus: "PRESENT" | "LATE" | "ABSENT", isDropIn = false) =>
    prisma.sessionAttendee.create({
      data: scopedData(centerA.id, { sessionId, studentProfileId: profile.id, attendanceStatus, isDropIn, recordedBy: teacherA.id }),
    });

  const closed = new Date();
  const present = await session(enrolledClass.id, -3, { closedAt: closed });
  await attend(present.id, "PRESENT");
  const late = await session(enrolledClass.id, -2, { closedAt: closed });
  await attend(late.id, "LATE");
  const absent = await session(enrolledClass.id, -1, { closedAt: closed });
  await attend(absent.id, "ABSENT");
  const dropInCame = await session(otherClass.id, -2, { closedAt: closed });
  await attend(dropInCame.id, "PRESENT", true);
  const dropInNoShow = await session(otherClass.id, -1, { closedAt: closed });
  await attend(dropInNoShow.id, "ABSENT", true);
  const live = await session(enrolledClass.id, 0);
  await attend(live.id, "ABSENT");
  const cancelled = await session(enrolledClass.id, 2, { status: "CANCELLED" });
  const upcoming = await session(enrolledClass.id, 3);
  const replacement = await session(enrolledClass.id, 5);
  const moved = await session(enrolledClass.id, 4, { rescheduledToId: replacement.id });

  const entries = await studentCalendarMonth(prisma, centerA.id, profile.id, range, today);
  const status = new Map(entries.map((entry) => [entry.sessionId, entry.status]));
  check("A past session attended is Present; a late one Late", status.get(present.id) === "PRESENT" && status.get(late.id) === "LATE");
  check("An enrolled student's closed absence is Absent", status.get(absent.id) === "ABSENT");
  check("A drop-in who came shows Present; a drop-in who never came shows nothing (T5)", status.get(dropInCame.id) === "PRESENT" && !status.has(dropInNoShow.id));
  check("A live session the enrolled student has not arrived at is still Upcoming", status.get(live.id) === "UPCOMING");
  check("A cancelled session is Cancelled; a future one Upcoming", status.get(cancelled.id) === "CANCELLED" && status.get(upcoming.id) === "UPCOMING");
  check("A moved original never shows; its replacement does (U2)", !status.has(moved.id) && status.get(replacement.id) === "UPCOMING");
  check("Every entry names its own branch", entries.every((entry) => entry.centerId === centerA.id));
  check(
    "Another branch's read of this profile returns nothing (centerId-scoped)",
    (await studentCalendarMonth(prisma, centerB.id, profile.id, range, today)).length === 0,
  );

  const enrolledIds = new Set(entries.map((entry) => entry.sessionId));
  const fakeBooking = (sessionRow: typeof upcoming, bookingStatus: "PENDING" | "CONFIRMED") => ({
    bookingId: `b-${sessionRow.id}`,
    bookingStatus,
    centerId: centerA.id,
    centerName: "Student Portal A",
    session: { ...sessionRow, classGroup: null, subject: null, grade: null, room: null, rescheduledFrom: null },
  });
  const otherFuture = await session(otherClass.id, 6);
  const booked = bookedCalendarEntries(
    [fakeBooking(upcoming, "CONFIRMED"), fakeBooking(otherFuture, "CONFIRMED"), fakeBooking(otherFuture, "PENDING")],
    range,
    enrolledIds,
  );
  check(
    "A booking reads Booked (CONFIRMED) or Requested (PENDING); an enrolled session wins over a booking",
    booked.length === 2 &&
      booked.every((entry) => entry.sessionId === otherFuture.id) &&
      booked.some((entry) => entry.status === "BOOKED") &&
      booked.some((entry) => entry.status === "REQUESTED"),
  );
}

/**
 * F5 — the public catalog (lib/db/public-catalog.ts) lists only ACTIVE/GRACE
 * branches with `publicListing`, only active, accepting, not-ended classes,
 * keeps every read branch-scoped, and lets no count leave: seats are a
 * status, and a teacher page is a name, an average and classes.
 */
async function checkPublicCatalog() {
  console.log("\nF5 — public catalog");
  const now = new Date();

  const makeBranch = (
    slug: string,
    lifecycleState: "ACTIVE" | "GRACE" | "ONBOARDING" | "SUSPENDED" | "ARCHIVED",
    publicListing = true,
  ) =>
    prisma.center.create({
      data: {
        slug,
        name: slug,
        lifecycleState,
        organization: { create: { name: slug } },
        settings: { create: { publicListing } },
      },
    });

  const listed = await makeBranch(PUBLIC_SLUGS.listed, "ACTIVE");
  const grace = await makeBranch(PUBLIC_SLUGS.grace, "GRACE");
  const unlisted = await makeBranch(PUBLIC_SLUGS.unlisted, "ACTIVE", false);
  const onboarding = await makeBranch(PUBLIC_SLUGS.onboarding, "ONBOARDING");
  const suspended = await makeBranch(PUBLIC_SLUGS.suspended, "SUSPENDED");
  const archived = await makeBranch(PUBLIC_SLUGS.archived, "ARCHIVED");

  // Branches: listed and GRACE resolve; everything else is null (a 404).
  check("a listed ACTIVE branch resolves by slug", (await publicBranchBySlug(prisma, PUBLIC_SLUGS.listed)) !== null);
  check("a listed GRACE branch resolves by slug", (await publicBranchBySlug(prisma, PUBLIC_SLUGS.grace)) !== null);
  const hiddenCases: [string, string][] = [
    ["an unlisted (publicListing off)", PUBLIC_SLUGS.unlisted],
    ["an ONBOARDING", PUBLIC_SLUGS.onboarding],
    ["a SUSPENDED", PUBLIC_SLUGS.suspended],
    ["an ARCHIVED", PUBLIC_SLUGS.archived],
  ];
  for (const [label, slug] of hiddenCases) {
    check(`${label} branch is hidden (null, so 404)`, (await publicBranchBySlug(prisma, slug)) === null);
  }

  const listedSlugs = new Set<string>();
  for (let page = 1; ; page += 1) {
    const { branches, total } = await listPublicBranches(prisma, page);
    branches.forEach((branch) => listedSlugs.add(branch.slug));
    if (page * EXPLORE_BRANCH_PAGE_SIZE >= total) break;
  }
  check(
    "the branch list shows listed and GRACE, never unlisted / ONBOARDING / SUSPENDED / ARCHIVED",
    listedSlugs.has(PUBLIC_SLUGS.listed) &&
      listedSlugs.has(PUBLIC_SLUGS.grace) &&
      ![PUBLIC_SLUGS.unlisted, PUBLIC_SLUGS.onboarding, PUBLIC_SLUGS.suspended, PUBLIC_SLUGS.archived].some((slug) =>
        listedSlugs.has(slug),
      ),
  );
  check(
    "a guest gets no logo key for an unlisted, ONBOARDING, SUSPENDED or ARCHIVED branch",
    (await publicBranchLogo(prisma, unlisted.id)) === null &&
      (await publicBranchLogo(prisma, onboarding.id)) === null &&
      (await publicBranchLogo(prisma, suspended.id)) === null &&
      (await publicBranchLogo(prisma, archived.id)) === null,
  );

  // Classes at the listed branch.
  const teacher = await makeTeacher(listed.id, "pubTeacher");
  const idleTeacher = await makeTeacher(listed.id, "pubIdleTeacher");
  const hiddenTeacher = await makeTeacher(unlisted.id, "pubHiddenTeacher");
  const open = await makeClass(listed.id, teacher.id);
  const full = await makeClass(listed.id, teacher.id, { capacity: 1 });
  const few = await makeClass(listed.id, teacher.id, { capacity: 4 });
  const inactive = await prisma.classGroup.update({
    where: { id: (await makeClass(listed.id, teacher.id)).id },
    data: { active: false },
  });
  const ended = await prisma.classGroup.update({
    where: { id: (await makeClass(listed.id, teacher.id)).id },
    data: { startDate: new Date("2020-01-01"), endDate: new Date("2020-06-30") },
  });
  const closed = await makeClass(listed.id, teacher.id, { acceptsNewStudents: false });
  await prisma.classGroup.update({
    where: { id: (await makeClass(listed.id, idleTeacher.id)).id },
    data: { active: false },
  });
  const unlistedClass = await makeClass(unlisted.id, hiddenTeacher.id);

  const enrolFixtures: [string, string][] = [
    ["pubFull", full.id],
    ["pubFew", few.id],
  ];
  for (const [tag, classGroupId] of enrolFixtures) {
    const student = await makeStudentUser(tag);
    const result = await prisma.$transaction((tx) =>
      reserveOrEnroll(tx, { centerId: listed.id, classGroupId, studentUserId: student.id }),
    );
    check(`fixture: ${tag} student enrolled`, result.ok);
  }

  const listedBranch = (await publicBranchBySlug(prisma, PUBLIC_SLUGS.listed))!;
  const graceBranch = (await publicBranchBySlug(prisma, PUBLIC_SLUGS.grace))!;
  const classes = await publicClassesForBranch(prisma, listedBranch, now);
  const ids = new Set(classes.map((item) => item.id));
  check("an active, accepting, running class is listed", ids.has(open.id) && ids.has(full.id) && ids.has(few.id));
  check("an inactive class is hidden", !ids.has(inactive.id));
  check("an ended class is hidden", !ids.has(ended.id));
  check("a class not accepting new students is hidden", !ids.has(closed.id));
  check("an ended class page is null (404)", (await publicClassById(prisma, listedBranch, ended.id, now)) === null);
  check("an inactive class page is null (404)", (await publicClassById(prisma, listedBranch, inactive.id, now)) === null);
  check(
    "a class id read through another branch is null (branch-scoped)",
    (await publicClassById(prisma, graceBranch, open.id, now)) === null,
  );

  const seatsOf = (id: string) => classes.find((item) => item.id === id)?.seats;
  check("a class at capacity shows Full", seatsOf(full.id) === "full", String(seatsOf(full.id)));
  check("a class with 3 or fewer seats left shows Few seats left", seatsOf(few.id) === "few", String(seatsOf(few.id)));
  check("an uncapped class shows Open", seatsOf(open.id) === "open", String(seatsOf(open.id)));

  const ALLOWED_CLASS_KEYS = [
    // G2 (OD-14): F6's sessionBookingMode (OFF / INSTANT / APPROVAL) is the one booking field a public class carries (docs/02).
    // U9: imageUrl is the class card's signing-route path (cover, else the teacher's photo) — never a storage key.
    "endDate", "grade", "id", "imageUrl", "price", "requiresConfirmation", "schedules", "seats",
    "sessionBookingMode", "startDate", "subject", "teacherName", "teacherRating", "teacherUserId",
  ].join(",");
  check(
    "a public class carries exactly the allowlisted fields (no count, room, student, or money but price)",
    classes.every((item) => Object.keys(item).sort().join(",") === ALLOWED_CLASS_KEYS),
    Object.keys(classes[0] ?? {}).sort().join(","),
  );

  // U9: the card's image is null until a cover or the teacher's photo exists, then a path under /api — never the key.
  check("a class with no cover and no teacher photo has no image", classes.every((item) => item.imageUrl === null));
  await prisma.classGroup.update({ where: { id: open.id }, data: { coverKey: `${listedBranch.id}/cover.${open.id}.v1.png` } });
  const withCover = (await publicClassesForBranch(prisma, listedBranch, now)).find((item) => item.id === open.id);
  check(
    "a class with a cover gets the signing-route path, not the storage key",
    withCover?.imageUrl === `/api/class-images/${listedBranch.id}/${open.id}?v=cover.${open.id}.v1.png` && !JSON.stringify(withCover).includes(`${listedBranch.id}/cover`),
    String(withCover?.imageUrl),
  );
  check(
    "a guest's image lookup resolves for a listed class and refuses an unlisted branch's class",
    (await publicClassImage(prisma, listedBranch.id, open.id, now))?.kind === "cover" &&
      (await publicClassImage(prisma, unlisted.id, unlistedClass.id, now)) === null,
  );
  await prisma.classGroup.update({ where: { id: open.id }, data: { coverKey: null } });

  const search = await searchPublicClasses(prisma, now, {});
  check("the class search never returns an unlisted branch class", !search.some((item) => item.id === unlistedClass.id));
  check(
    "the class search never returns an inactive, ended or closed class",
    !search.some((item) => [inactive.id, ended.id, closed.id].includes(item.id)),
  );

  // The teacher page: a name, an average and classes — no count anywhere.
  const teacherPage = await publicTeacherAt(prisma, listedBranch, teacher.id, now);
  check("a teacher with listed classes has a page", teacherPage !== null);
  check(
    "the teacher page exposes exactly teacherUserId, name, rating and classes",
    teacherPage !== null && Object.keys(teacherPage).sort().join(",") === "classes,name,rating,teacherUserId",
    Object.keys(teacherPage ?? {}).join(","),
  );
  check("the teacher page exposes no count", !/count|capacity|enrolled|"ratings"/i.test(JSON.stringify(teacherPage)));
  check(
    "the teacher page rating is an average or null, never an object",
    teacherPage !== null && (teacherPage.rating === null || typeof teacherPage.rating === "number"),
  );
  check(
    "a teacher with nothing listed at the branch has no page",
    (await publicTeacherAt(prisma, listedBranch, idleTeacher.id, now)) === null,
  );
  check(
    "a teacher of an unlisted branch has no page",
    (await publicTeacherAt(prisma, listedBranch, hiddenTeacher.id, now)) === null,
  );

  await deleteAuditRows(prisma, {
    centerId: { in: [listed.id, grace.id, unlisted.id, onboarding.id, suspended.id, archived.id] },
  });
}

/**
 * F4 — a NEW branch profile is seeded from the student's own account (the
 * grade they say they are in, when the branch offers it, and the parent they
 * declared); an existing profile is never overwritten; and a sign-up intent
 * grants nothing. Runs the REAL `ensureStudentProfile` (through
 * `reserveOrEnroll`).
 */
async function checkAccountSeeding(
  centerA: { id: string },
  centerB: { id: string },
  teacherA: { id: string },
  teacherB: { id: string },
): Promise<void> {
  console.log("\nF4 - account grade and declared parent seed a new branch profile");

  const gSeed = await prisma.catalogGrade.create({ data: { nameAr: "Student-Portal-Check Seed", nameEn: "Student-Portal-Check Seed" } });
  const gOther = await prisma.catalogGrade.create({ data: { nameAr: "Student-Portal-Check Other", nameEn: "Student-Portal-Check Other" } });
  const gNotOffered = await prisma.catalogGrade.create({ data: { nameAr: "Student-Portal-Check Unoffered", nameEn: "Student-Portal-Check Unoffered" } });
  for (const centerId of [centerA.id, centerB.id]) {
    for (const grade of [gSeed, gOther]) {
      await prisma.centerCatalogSelection.create({ data: { centerId, kind: "GRADE", gradeId: grade.id } });
    }
  }

  const user = (tag: string, data: { gradeId?: string; signupIntent?: "STUDENT" | "PARENT" | "TEACHER" } = {}) =>
    prisma.user.create({
      data: { firstName: "F4", lastName: tag, email: `student-portal-check-f4-${tag}@kayedu.test`, locale: "en", ...data },
    });
  const invite = (studentUserId: string, phone: string, status: "PENDING" | "ACCEPTED" | "REVOKED", createdAt: Date, first = "Pat") =>
    prisma.familyInvitation.create({
      data: {
        studentUserId,
        codeHash: hashFamilyCode(generateFamilyCode()),
        codeHint: "ab",
        source: "STUDENT_INVITE",
        createdBy: studentUserId,
        declaredParentFirstName: first,
        declaredParentLastName: "Parent",
        declaredParentPhone: phone,
        status,
        createdAt,
      },
    });
  const classA = await makeClass(centerA.id, teacherA.id);
  const classA2 = await makeClass(centerA.id, teacherA.id);
  const classB = await makeClass(centerB.id, teacherB.id);
  const join = (centerId: string, classGroupId: string, studentUserId: string) =>
    prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId, classGroupId, studentUserId }));
  const profileAt = (centerId: string, userId: string) => prisma.studentProfile.findFirst({ where: { centerId, userId } });
  const day = 24 * 60 * 60 * 1000;

  // a. grade + declared parent -> seeded, and whole: no second form.
  const u1 = await user("whole", { gradeId: gSeed.id });
  await invite(u1.id, "+201000000001", "ACCEPTED", new Date(Date.now() - 2 * day), "Older");
  await invite(u1.id, "+201000000002", "PENDING", new Date(Date.now() - day), "Newer");
  await join(centerA.id, classA.id, u1.id);
  const whole = await profileAt(centerA.id, u1.id);
  check(
    "A new profile takes the account grade and the latest declared parent, and is stamped complete",
    whole?.gradeId === gSeed.id && whole.parentPhone === "+201000000002" && whole.parentFirstName === "Newer" &&
      whole.parentLastName === "Parent" && whole.profileCompletedAt !== null,
    JSON.stringify(whole),
  );

  // b. grade only -> the form stays.
  const u2 = await user("grade-only", { gradeId: gSeed.id });
  await join(centerA.id, classA.id, u2.id);
  const gradeOnly = await profileAt(centerA.id, u2.id);
  check("Grade without a parent: seeded, but the one-time form still stands", gradeOnly?.gradeId === gSeed.id && gradeOnly.parentPhone === null && gradeOnly.profileCompletedAt === null);

  // c. parent only -> the form stays.
  const u3 = await user("parent-only");
  await invite(u3.id, "+201000000003", "PENDING", new Date());
  await join(centerA.id, classA.id, u3.id);
  const parentOnly = await profileAt(centerA.id, u3.id);
  check("Parent without a grade: seeded, but the one-time form still stands", parentOnly?.gradeId === null && parentOnly.parentPhone === "+201000000003" && parentOnly.profileCompletedAt === null);

  // d. a grade this branch does not offer is not seeded (SEC-49).
  const u4 = await user("unoffered", { gradeId: gNotOffered.id });
  await invite(u4.id, "+201000000004", "PENDING", new Date());
  await join(centerA.id, classA.id, u4.id);
  const unoffered = await profileAt(centerA.id, u4.id);
  check("A grade the branch does not offer is left empty, so the form stays", unoffered?.gradeId === null && unoffered.profileCompletedAt === null);

  // e. a cancelled invitation declares nobody.
  const u5 = await user("cancelled", { gradeId: gSeed.id });
  await invite(u5.id, "+201000000005", "REVOKED", new Date());
  await join(centerA.id, classA.id, u5.id);
  const cancelled = await profileAt(centerA.id, u5.id);
  check("A cancelled invitation seeds no parent", cancelled?.parentPhone === null && cancelled.profileCompletedAt === null);

  // f. an existing profile is never overwritten; the account never reaches into a branch.
  const before = await profileAt(centerA.id, u1.id);
  await prisma.user.update({ where: { id: u1.id }, data: { gradeId: gOther.id } });
  await join(centerA.id, classA2.id, u1.id);
  const after = await profileAt(centerA.id, u1.id);
  check(
    "Changing the account grade changes no existing branch record (and joining a second class re-seeds nothing)",
    before !== null && after !== null && after.gradeId === gSeed.id && after.updatedAt.getTime() === before.updatedAt.getTime(),
  );
  await join(centerB.id, classB.id, u1.id);
  const atB = await profileAt(centerB.id, u1.id);
  check("A second branch seeds from the account as it is now, independently of the first", atB?.gradeId === gOther.id && atB.parentPhone === "+201000000002");

  // g. a sign-up intent grants nothing.
  for (const intent of ["STUDENT", "PARENT", "TEACHER"] as const) {
    const declared = await user(`intent-${intent.toLowerCase()}`, { signupIntent: intent });
    const relations = await resolveCenterRelations(prisma, declared.id);
    const reads = await Promise.all([
      prisma.membership.count({ where: { userId: declared.id } }),
      prisma.studentProfile.count({ where: { userId: declared.id } }),
      prisma.familyLink.count({ where: { OR: [{ parentUserId: declared.id }, { studentUserId: declared.id }] } }),
    ]);
    check(
      `A ${intent} sign-up intent creates and grants nothing: no relation, membership, profile or family link`,
      relations.length === 0 && reads.every((count) => count === 0),
    );
  }
  await checkLeaveClass(centerA, centerB, teacherA);
  await deleteAuditRows(prisma, { centerId: { in: [centerA.id, centerB.id] } });
}

/**
 * F6 — single-session booking, through the REAL `lib/db/session-bookings.ts`:
 * OFF refuses; INSTANT confirms at once (and only then makes the profile);
 * APPROVAL waits and confirm makes the profile; the last seat cannot be taken
 * twice by two concurrent requests; `maxBookingSeats` caps confirmed
 * bookings; both blocks refuse at request and at confirm; the per-account
 * cap of 10 open bookings; a started session takes no booking and a pending
 * one expires (nothing written); a student cancels only until start; seats
 * leave as a status; and another branch cannot resolve this branch's booking.
 */
async function checkSessionBookings(
  centerA: { id: string },
  centerB: { id: string },
  teacherA: { id: string },
): Promise<void> {
  console.log("\nF6 — single-session booking");

  const DAY = 24 * 60 * 60 * 1000;
  const utcDay = (offset: number) => {
    const d = new Date(Date.now() + offset * DAY);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  let slot = 0;
  const session = (classGroupId: string, dayOffset = 3) =>
    prisma.session.create({
      data: scopedData(centerA.id, {
        classGroupId,
        teacherId: teacherA.id,
        date: utcDay(dayOffset),
        // Distinct start times keep the (class, date, start) unique happy.
        startTime: `${String(8 + (slot % 12)).padStart(2, "0")}:${String((slot++ * 5) % 60).padStart(2, "0")}`,
        endTime: "22:00",
        priceSnapshot: 10_000,
      }),
    });
  const bookingClass = async (
    mode: "OFF" | "INSTANT" | "APPROVAL",
    opts: { capacity?: number; maxBookingSeats?: number } = {},
  ) => {
    const row = await makeClass(centerA.id, teacherA.id, { capacity: opts.capacity });
    return prisma.classGroup.update({
      where: { id: row.id },
      data: { sessionBookingMode: mode, maxBookingSeats: opts.maxBookingSeats ?? null },
    });
  };
  const book = (sessionId: string, studentUserId: string, centerId = centerA.id) =>
    prisma.$transaction((tx) => requestBooking(tx, { centerId, sessionId, studentUserId }));

  // OFF — every pre-F6 class.
  const off = await bookingClass("OFF");
  const offSession = await session(off.id);
  const s1 = await makeStudentUser("f6-s1");
  const offResult = await book(offSession.id, s1.id);
  check("A class with booking OFF refuses a booking (bookingOff)", !offResult.ok && offResult.error === "bookingOff");

  // INSTANT — confirmed at once; the profile is made then.
  const instant = await bookingClass("INSTANT");
  const instantSession = await session(instant.id);
  const instantResult = await book(instantSession.id, s1.id);
  const s1Profile = await prisma.studentProfile.findFirst({ where: { centerId: centerA.id, userId: s1.id } });
  check(
    "INSTANT: the booking is CONFIRMED at once and the StudentProfile is created then",
    instantResult.ok && instantResult.kind === "confirmed" && instantResult.booking.status === "CONFIRMED" && s1Profile !== null,
    JSON.stringify(instantResult),
  );
  const again = await book(instantSession.id, s1.id);
  check("A second booking of the same session is alreadyBooked", !again.ok && again.error === "alreadyBooked");

  // APPROVAL — pending, no profile until confirmed.
  const approval = await bookingClass("APPROVAL");
  const approvalSession = await session(approval.id);
  const s2 = await makeStudentUser("f6-s2");
  const pending = await book(approvalSession.id, s2.id);
  const s2ProfileBefore = await prisma.studentProfile.count({ where: { centerId: centerA.id, userId: s2.id } });
  check(
    "APPROVAL: the booking is PENDING and no StudentProfile exists yet",
    pending.ok && pending.kind === "pending" && s2ProfileBefore === 0,
  );
  const crossCentre = pending.ok
    ? await prisma.$transaction((tx) => confirmBooking(tx, centerB.id, pending.booking.id, teacherA.id))
    : null;
  check("Another branch cannot confirm this branch's booking (notFound)", crossCentre?.ok === false && crossCentre.error === "notFound");
  const confirmed = pending.ok
    ? await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, pending.booking.id, teacherA.id))
    : null;
  const s2ProfileAfter = await prisma.studentProfile.count({ where: { centerId: centerA.id, userId: s2.id } });
  const confirmAudit = pending.ok
    ? await prisma.auditLog.count({ where: { centerId: centerA.id, action: "sessionBooking.confirm", entityId: pending.booking.id } })
    : 0;
  check(
    "Confirming makes it CONFIRMED, creates the profile, and writes one sessionBooking.confirm audit row",
    confirmed?.ok === true && confirmed.booking.status === "CONFIRMED" && s2ProfileAfter === 1 && confirmAudit === 1,
  );
  const reconfirm = pending.ok
    ? await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, pending.booking.id, teacherA.id))
    : null;
  check("A resolved booking cannot be resolved again (notPending)", reconfirm?.ok === false && reconfirm.error === "notPending");

  // Enrolled students do not book.
  const enrolledUser = await makeStudentUser("f6-enrolled");
  await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: instant.id, studentUserId: enrolledUser.id }),
  );
  const enrolledBook = await book(instantSession.id, enrolledUser.id);
  check(
    "A student enrolled in the class cannot book one of its sessions (alreadyEnrolled)",
    !enrolledBook.ok && enrolledBook.error === "alreadyEnrolled",
  );

  // The last seat, two concurrent requests → exactly one.
  const tiny = await bookingClass("INSTANT", { capacity: 1 });
  const tinySession = await session(tiny.id);
  const racerA = await makeStudentUser("f6-race-a");
  const racerB = await makeStudentUser("f6-race-b");
  const race = await Promise.all([book(tinySession.id, racerA.id), book(tinySession.id, racerB.id)]);
  const winners = race.filter((result) => result.ok).length;
  const losers = race.filter((result) => !result.ok && result.error === "sessionFull").length;
  const confirmedTiny = await prisma.sessionBooking.count({ where: { sessionId: tinySession.id, status: "CONFIRMED" } });
  check(
    "Two concurrent requests for the last seat: exactly one wins, the other is sessionFull",
    winners === 1 && losers === 1 && confirmedTiny === 1,
    JSON.stringify(race.map((result) => (result.ok ? "ok" : result.error))),
  );
  const tinyRoom = tiny.roomId
    ? await prisma.room.findFirst({ where: { id: tiny.roomId }, select: { id: true, name: true, capacity: true } })
    : null;
  const tinySeats = await upcomingBookableSessions(prisma, centerA.id, { ...tiny, room: tinyRoom, extraRooms: [] });
  check(
    "The class page shows the full session as a status, never a count",
    tinySeats.find((row) => row.id === tinySession.id)?.seats === "full" &&
      tinySeats.every((row) => Object.keys(row).sort().join(",") === "date,endTime,id,seats,startTime"),
  );

  // maxBookingSeats caps CONFIRMED bookings under a roomy seat limit.
  const capped = await bookingClass("INSTANT", { capacity: 10, maxBookingSeats: 1 });
  const cappedSession = await session(capped.id);
  const c1 = await book(cappedSession.id, (await makeStudentUser("f6-cap-1")).id);
  const c2 = await book(cappedSession.id, (await makeStudentUser("f6-cap-2")).id);
  check(
    "maxBookingSeats: the first booking fits, the next is bookingSeatsFull",
    c1.ok && !c2.ok && c2.error === "bookingSeatsFull",
  );

  // Both blocks, at request and at confirm.
  const blockClass = await bookingClass("APPROVAL");
  const blockSession = await session(blockClass.id);
  const teacherBlocked = await makeStudentUser("f6-block-teacher");
  await prisma.studentBlock.create({
    data: scopedData(centerA.id, { scope: TEACHER_SCOPE, refId: teacherA.id, blockedUserId: teacherBlocked.id }),
  });
  const atRequest = await book(blockSession.id, teacherBlocked.id);
  check(
    "A TEACHER-scope block refuses the booking at request (studentBlocked)",
    !atRequest.ok && atRequest.error === "studentBlocked",
  );
  const lateBlocked = await makeStudentUser("f6-block-class");
  const waiting = await book(blockSession.id, lateBlocked.id);
  await prisma.studentBlock.create({
    data: scopedData(centerA.id, { scope: CLASS_SCOPE, refId: blockClass.id, blockedUserId: lateBlocked.id }),
  });
  const atConfirm = waiting.ok
    ? await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, waiting.booking.id, teacherA.id))
    : null;
  check(
    "A CLASS-scope block placed after the request refuses the confirm (studentBlocked)",
    waiting.ok && atConfirm?.ok === false && atConfirm.error === "studentBlocked",
  );

  // The per-account cap: 10 open bookings, the 11th refused.
  const many = await bookingClass("INSTANT");
  const manySessions = [];
  for (let i = 0; i < BOOKING_CAPS.openBookings + 1; i += 1) manySessions.push(await session(many.id, 4 + i));
  const heavy = await makeStudentUser("f6-cap-account");
  const manyResults = [];
  for (const row of manySessions) manyResults.push(await book(row.id, heavy.id));
  const last = manyResults.at(-1)!;
  check(
    `One account holds at most ${BOOKING_CAPS.openBookings} open bookings; the next is bookingLimit`,
    BOOKING_CAPS.openBookings === 10 &&
      manyResults.slice(0, -1).every((result) => result.ok) &&
      !last.ok && last.error === "bookingLimit",
  );

  // A started session takes no booking; a pending one expires and cannot be confirmed.
  const past = await session(instant.id, -1);
  const lateBook = await book(past.id, (await makeStudentUser("f6-late")).id);
  check(
    "A session that has started takes no booking (sessionUnavailable)",
    !lateBook.ok && lateBook.error === "sessionUnavailable",
  );
  const expiring = await session(approval.id, 2);
  const expiringBooking = await book(expiring.id, (await makeStudentUser("f6-expiring")).id);
  const afterStart = new Date(Date.now() + 4 * DAY);
  const expiredConfirm = expiringBooking.ok
    ? await prisma.$transaction((tx) =>
        confirmBooking(tx, centerA.id, expiringBooking.booking.id, teacherA.id, { now: afterStart }),
      )
    : null;
  const expiredReject = expiringBooking.ok
    ? await prisma.$transaction((tx) =>
        rejectBooking(tx, centerA.id, expiringBooking.booking.id, teacherA.id, { now: afterStart }),
      )
    : null;
  const stillPending = expiringBooking.ok
    ? await prisma.sessionBooking.findUniqueOrThrow({ where: { id: expiringBooking.booking.id } })
    : null;
  check(
    "A pending booking whose session started is expired: confirm and reject are refused, nothing is written",
    expiredConfirm?.ok === false && expiredConfirm.error === "expired" &&
      expiredReject?.ok === false && expiredReject.error === "expired" &&
      stillPending?.status === "PENDING" && stillPending.resolvedAt === null,
  );

  // The student cancels their own booking, until the session starts.
  const cancellable = await session(instant.id, 5);
  const canceller = await makeStudentUser("f6-canceller");
  const toCancel = await book(cancellable.id, canceller.id);
  const someoneElse = toCancel.ok
    ? await cancelBookingByStudent(prisma, centerA.id, toCancel.booking.id, s1.id)
    : null;
  check("Another student cannot cancel this booking (notFound)", someoneElse?.ok === false && someoneElse.error === "notFound");
  const tooLate = toCancel.ok
    ? await cancelBookingByStudent(prisma, centerA.id, toCancel.booking.id, canceller.id, new Date(Date.now() + 6 * DAY))
    : null;
  check("After the session starts, a booking can no longer be cancelled (tooLate)", tooLate?.ok === false && tooLate.error === "tooLate");
  const cancelled = toCancel.ok
    ? await cancelBookingByStudent(prisma, centerA.id, toCancel.booking.id, canceller.id)
    : null;
  check(
    "Before the start, the student cancels it (CANCELLED, reason STUDENT)",
    cancelled?.ok === true && cancelled.booking.status === "CANCELLED" && cancelled.booking.cancelReason === "STUDENT",
  );
  const rebook = await book(cancellable.id, canceller.id);
  check(
    "A cancelled booking can be booked again (the same row is reused)",
    rebook.ok && toCancel.ok && rebook.booking.id === toCancel.booking.id,
  );

  // ── T7 — bookings on the schedule, staff cancel, confirm after OFF ────────
  console.log("\nT7 — bookings on the schedule, staff cancel, confirm after OFF");

  // (a) The schedule shows confirmed and pending bookings, nothing else.
  const t7Class = await bookingClass("APPROVAL", { capacity: 6 });
  const t7Session = await session(t7Class.id, 6);
  const t7Confirmed = await makeStudentUser("t7-confirmed");
  const t7Pending = await makeStudentUser("t7-pending");
  const t7Rejected = await makeStudentUser("t7-rejected");
  const t7Withdrew = await makeStudentUser("t7-withdrew");
  const t7Bookings = {
    confirmed: await book(t7Session.id, t7Confirmed.id),
    pending: await book(t7Session.id, t7Pending.id),
    rejected: await book(t7Session.id, t7Rejected.id),
    withdrew: await book(t7Session.id, t7Withdrew.id),
  };
  const t7Ids = Object.fromEntries(
    Object.entries(t7Bookings).map(([key, result]) => [key, result.ok ? result.booking.id : ""]),
  ) as Record<keyof typeof t7Bookings, string>;
  await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, t7Ids.confirmed, teacherA.id));
  await prisma.$transaction((tx) => rejectBooking(tx, centerA.id, t7Ids.rejected, teacherA.id));
  await cancelBookingByStudent(prisma, centerA.id, t7Ids.withdrew, t7Withdrew.id);

  const scheduleOf = (userId: string, now?: Date) => studentBookedUpcoming(prisma, userId, now);
  const confirmedRows = await scheduleOf(t7Confirmed.id);
  check(
    "A CONFIRMED booking is on the student schedule as Booked, with its branch",
    confirmedRows.length === 1 &&
      confirmedRows[0].bookingStatus === "CONFIRMED" &&
      confirmedRows[0].session.id === t7Session.id &&
      confirmedRows[0].centerId === centerA.id,
  );
  const pendingRows = await scheduleOf(t7Pending.id);
  const pendingProfiles = await prisma.studentProfile.count({ where: { centerId: centerA.id, userId: t7Pending.id } });
  check(
    "A PENDING booking is on the schedule as Requested, even before any StudentProfile exists",
    pendingRows.length === 1 && pendingRows[0].bookingStatus === "PENDING" && pendingProfiles === 0,
  );
  check(
    "A rejected booking and a cancelled one are not on the schedule",
    (await scheduleOf(t7Rejected.id)).length === 0 && (await scheduleOf(t7Withdrew.id)).length === 0,
  );
  check(
    "A pending booking whose session has started is expired and drops off the schedule",
    (await scheduleOf(t7Pending.id, new Date(Date.now() + 10 * DAY))).length === 0,
  );
  check(
    "A schedule never carries another student booking",
    confirmedRows.every((row) => row.session.id === t7Session.id) &&
      (await scheduleOf((await makeStudentUser("t7-nobody")).id)).length === 0,
  );
  const t7Profile = await prisma.studentProfile.findFirstOrThrow({ where: { centerId: centerA.id, userId: t7Confirmed.id } });
  const childRows = await childBookedUpcoming(prisma, centerA.id, t7Profile.id);
  const childFromB = await childBookedUpcoming(prisma, centerB.id, t7Profile.id);
  check(
    "The parent portal reads the same bookings for that child at that branch, and nothing through another branch",
    childRows.length === 1 && childRows[0].bookingStatus === "CONFIRMED" && childFromB.length === 0,
  );

  // (b) Staff cancel frees the seat and is audited (ids only, same transaction).
  const t7Tiny = await bookingClass("INSTANT", { capacity: 1 });
  const t7TinySession = await session(t7Tiny.id, 7);
  const holder = await makeStudentUser("t7-holder");
  const waiter = await makeStudentUser("t7-waiter");
  const held = await book(t7TinySession.id, holder.id);
  const fullNow = await book(t7TinySession.id, waiter.id);
  check("Setup: the only seat is taken (sessionFull)", held.ok && !fullNow.ok && fullNow.error === "sessionFull");
  const heldId = held.ok ? held.booking.id : "";

  const rolledBack = await prisma
    .$transaction(async (tx) => {
      await cancelBookingByStaff(tx, centerA.id, heldId, teacherA.id);
      throw new Error("force rollback");
    })
    .catch(() => "rolled back");
  const afterRollback = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: heldId } });
  const rollbackAudit = await prisma.auditLog.count({
    where: { centerId: centerA.id, action: "sessionBooking.cancel", entityId: heldId },
  });
  check(
    "The cancel and its audit row are one transaction: a rolled-back cancel leaves the booking CONFIRMED and writes no row",
    rolledBack === "rolled back" && afterRollback.status === "CONFIRMED" && rollbackAudit === 0,
  );

  const fromB = await prisma.$transaction((tx) => cancelBookingByStaff(tx, centerB.id, heldId, teacherA.id));
  check("Another branch cannot cancel this branch booking (notFound)", !fromB.ok && fromB.error === "notFound");

  const staffCancelled = await prisma.$transaction((tx) => cancelBookingByStaff(tx, centerA.id, heldId, teacherA.id));
  check(
    "Staff cancel: CANCELLED with reason STAFF",
    staffCancelled.ok && staffCancelled.booking.status === "CANCELLED" && staffCancelled.booking.cancelReason === "STAFF",
  );
  const freed = await book(t7TinySession.id, waiter.id);
  check("...and the seat is free at once: the waiting student now books it", freed.ok && freed.kind === "confirmed");
  const cancelAudit = await prisma.auditLog.findMany({
    where: { centerId: centerA.id, action: "sessionBooking.cancel", entityId: heldId },
  });
  const auditPayload = JSON.stringify(cancelAudit[0] ?? {});
  check(
    "...and exactly one sessionBooking.cancel audit row, attributed to the actor, with ids and statuses only",
    cancelAudit.length === 1 &&
      cancelAudit[0].actorUserId === teacherA.id &&
      auditPayload.includes('"cancelReason":"STAFF"') &&
      !/"(name|firstName|lastName|email|phone|reason|note)"/.test(auditPayload),
    auditPayload,
  );
  const heldRow = await prisma.sessionBooking.findFirstOrThrow({
    where: { id: heldId },
    include: {
      session: {
        select: {
          classGroupId: true,
          status: true,
          closedAt: true,
          rescheduledToId: true,
          date: true,
          startTime: true,
          timezone: true,
        },
      },
    },
  });
  check(
    "The student sees it as Cancelled by the branch (its own display status, not the student own cancel)",
    bookingDisplayStatus(heldRow, new Date()) === "CANCELLED_BY_BRANCH" &&
      bookingDisplayStatus({ ...heldRow, cancelReason: "STUDENT" }, new Date()) === "CANCELLED",
  );
  const cancelAgain = await prisma.$transaction((tx) => cancelBookingByStaff(tx, centerA.id, heldId, teacherA.id));
  check("A cancelled booking cannot be cancelled again (notOpen)", !cancelAgain.ok && cancelAgain.error === "notOpen");
  const pendingCancel = await prisma.$transaction((tx) => cancelBookingByStaff(tx, centerA.id, t7Ids.pending, teacherA.id));
  check("A PENDING booking is rejected, not cancelled (notOpen)", !pendingCancel.ok && pendingCancel.error === "notOpen");
  const closedSession = await session(t7Class.id, 8);
  const closedBooking = await book(closedSession.id, (await makeStudentUser("t7-closed")).id);
  if (closedBooking.ok) {
    await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, closedBooking.booking.id, teacherA.id));
  }
  await prisma.session.update({ where: { id: closedSession.id }, data: { closedAt: new Date() } });
  const onClosed = closedBooking.ok
    ? await prisma.$transaction((tx) => cancelBookingByStaff(tx, centerA.id, closedBooking.booking.id, teacherA.id))
    : null;
  check(
    "A booking on a closed session cannot be cancelled (sessionClosed)",
    onClosed?.ok === false && onClosed.error === "sessionClosed",
  );

  // A teacher cancels only bookings on their own classes.
  const otherTeacher = await makeTeacher(centerA.id, "t7-other-teacher");
  const pinnedClass = await bookingClass("INSTANT", { capacity: 4 });
  const pinnedSession = await session(pinnedClass.id, 9);
  const pinnedBooking = await book(pinnedSession.id, (await makeStudentUser("t7-pinned")).id);
  const pinnedId = pinnedBooking.ok ? pinnedBooking.booking.id : "";
  const byOther = await prisma.$transaction((tx) =>
    cancelBookingByStaff(tx, centerA.id, pinnedId, otherTeacher.id, { teacherId: otherTeacher.id, via: "teacher" }),
  );
  const stillConfirmed = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: pinnedId } });
  check(
    "A teacher cannot cancel a booking on another teacher class (notFound, nothing written)",
    !byOther.ok &&
      byOther.error === "notFound" &&
      stillConfirmed.status === "CONFIRMED" &&
      (await prisma.auditLog.count({ where: { centerId: centerA.id, action: "sessionBooking.cancel", entityId: pinnedId } })) === 0,
  );
  const byOwner = await prisma.$transaction((tx) =>
    cancelBookingByStaff(tx, centerA.id, pinnedId, teacherA.id, { teacherId: teacherA.id, via: "teacher" }),
  );
  const ownerAudit = await prisma.auditLog.findFirst({
    where: { centerId: centerA.id, action: "sessionBooking.cancel", entityId: pinnedId },
  });
  check(
    "...while the class own teacher can, and the audit row records it was a teacher",
    byOwner.ok &&
      byOwner.booking.cancelReason === "STAFF" &&
      JSON.stringify(ownerAudit?.after ?? {}).includes('"via":"teacher"'),
  );

  // (c) Confirm is refused once the class booking mode is OFF; confirmed ones stand.
  const offLater = await bookingClass("APPROVAL", { capacity: 6 });
  const offLaterSession = await session(offLater.id, 10);
  const waitingUser = await makeStudentUser("t7-waiting");
  const standingUser = await makeStudentUser("t7-standing");
  const waitingBooking = await book(offLaterSession.id, waitingUser.id);
  const standingBooking = await book(offLaterSession.id, standingUser.id);
  if (standingBooking.ok) {
    await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, standingBooking.booking.id, teacherA.id));
  }
  await prisma.classGroup.update({ where: { id: offLater.id }, data: { sessionBookingMode: "OFF" } });
  const waitingId = waitingBooking.ok ? waitingBooking.booking.id : "";
  const refusedWhenOff = await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, waitingId, teacherA.id));
  const waitingAfter = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: waitingId } });
  check(
    "Confirm after the class booking is switched OFF is refused (bookingOff); the booking stays PENDING, with no profile and no audit row",
    !refusedWhenOff.ok &&
      refusedWhenOff.error === "bookingOff" &&
      waitingAfter.status === "PENDING" &&
      (await prisma.studentProfile.count({ where: { centerId: centerA.id, userId: waitingUser.id } })) === 0 &&
      (await prisma.auditLog.count({ where: { centerId: centerA.id, action: "sessionBooking.confirm", entityId: waitingId } })) === 0,
  );
  const rejectedWhenOff = await prisma.$transaction((tx) => rejectBooking(tx, centerA.id, waitingId, teacherA.id));
  check("...a pending booking can still be rejected while the class is OFF", rejectedWhenOff.ok);
  const standing = standingBooking.ok
    ? await prisma.sessionBooking.findUniqueOrThrow({ where: { id: standingBooking.booking.id } })
    : null;
  check(
    "...and a booking confirmed before the switch is unaffected (still CONFIRMED, still on the schedule)",
    standing?.status === "CONFIRMED" && (await scheduleOf(standingUser.id)).length === 1,
  );

  // ── G1 — "today" is the centre's day, not the UTC day ─────────────────────
  // At 00:30 Cairo the UTC clock still reads yesterday. A session later the
  // same Cairo day has not started: it takes a booking, is on the class page's
  // upcoming list, and is on the student's schedule.
  console.log(`
G1 — the centre's day at 00:30 Cairo`);
  const g1Day = "2027-01-14";
  const g1Now = zonedDateTimeToUtc(g1Day, 30, "Africa/Cairo");
  const g1Class = await bookingClass("INSTANT", { capacity: 6 });
  const g1Session = await prisma.session.create({
    data: scopedData(centerA.id, {
      classGroupId: g1Class.id,
      teacherId: teacherA.id,
      date: dayMarker(g1Day),
      startTime: "18:00",
      endTime: "19:30",
      timezone: "Africa/Cairo",
      priceSnapshot: 10_000,
    }),
  });
  const g1Student = await makeStudentUser("g1-midnight");
  const g1Upcoming = await upcomingBookableSessions(prisma, centerA.id, { ...g1Class, room: null, extraRooms: [] }, g1Now);
  const g1Booked = await prisma.$transaction((tx) =>
    requestBooking(tx, { centerId: centerA.id, sessionId: g1Session.id, studentUserId: g1Student.id, now: g1Now }),
  );
  const g1Schedule = await scheduleOf(g1Student.id, g1Now);
  check(
    "At 00:30 Cairo, today's later session is bookable and shows as upcoming (class page and student schedule)",
    g1Now.toISOString() === "2027-01-13T22:30:00.000Z" &&
      g1Upcoming.some((row) => row.id === g1Session.id) &&
      g1Booked.ok && g1Booked.kind === "confirmed" &&
      g1Schedule.some((row) => row.session.id === g1Session.id),
    JSON.stringify({ upcoming: g1Upcoming.length, booked: g1Booked.ok || g1Booked.error, schedule: g1Schedule.length }),
  );

  await deleteAuditRows(prisma, { centerId: { in: [centerA.id, centerB.id] } });
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
      console.error(`\n${failures} student-portal check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll student-portal checks passed.");
  });
