/**
 * Enrollment check — the M15 acceptance gate (docs/03-build-order.md M15
 * "Done when"): both `StudentBlock` scopes refused at request *and* approval
 * time; a rejected re-request refused (and explained) inside 7 days;
 * enrolment hard-capped by room capacity while attendance past that cap
 * still succeeds; a reschedule target free at the start but busy before the
 * window ends is refused; a cancelled (and an already-rescheduled) session
 * refuses attendance and payment by direct call, not just in the UI; and a
 * zero-membership teacher's onboarding request goes through the same
 * `ChangeRequest`/approvals machinery as any other.
 *
 * Run with:  npm run check:enrollment
 *
 * Exercises the real production functions — `lib/db/reservations.ts`
 * (`reserveOrEnroll`/`confirmReservation`/`rejectReservation`),
 * `lib/capacity.ts`, `lib/db/sessions.ts` (`rescheduleSession`),
 * `lib/db/attendance.ts` (`createAttendance`/`updateAttendanceStatus`,
 * M15's `SessionClosedError`), `lib/db/payments.ts` (`recordPayment`) and
 * `lib/db/approvals.ts` (`resolveChangeRequest`) — against a throwaway
 * center. Needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { type BlockScope } from "@prisma/client";
import { scopedData } from "../lib/db/tenant-scope.ts";
import {
  confirmReservation,
  rejectReservation,
  reserveOrEnroll,
} from "../lib/db/reservations.ts";
import { enrollmentCap, isAtCapacity, isInCooldown, cooldownUntil } from "../lib/capacity.ts";
import {
  createAttendance,
  updateAttendanceStatus,
  SessionClosedError,
} from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { cancelSession, rescheduleSession } from "../lib/db/sessions.ts";
import { resolveChangeRequest } from "../lib/db/approvals.ts";

const prisma = await gatePrisma();

// R2 fixture clock: the cancel/reschedule fixtures below are hard-dated
// December 2026 sessions. Pinning "now" before them keeps them open (not
// closed by the end-of-day rule) on any date the gate runs.
const LIFECYCLE_NOW = new Date("2026-11-30T08:00:00.000Z");

/** R1 fixture shape: a centre's first active payment method, created on demand. */
const fixtureMethodIds = new Map<string, string>();
async function fixtureMethodId(centerId: string): Promise<string> {
  const cached = fixtureMethodIds.get(centerId);
  if (cached) return cached;
  await ensureDefaultPaymentMethods(prisma, centerId);
  const [method] = await listActivePaymentMethods(prisma, centerId);
  fixtureMethodIds.set(centerId, method.id);
  return method.id;
}

const SLUG = "enrollment-check";
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
  await prisma.center.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "enrollment-check-" } } });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email: `enrollment-check-${tag}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

async function makeStudentUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `enrollment-check-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeStudentProfile(centerId: string, tag: string) {
  const user = await makeStudentUser(tag);
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: `EC-${tag}`, firstName: "S", lastName: tag }),
  });
  return { user, profile };
}

async function makeClass(
  centerId: string,
  teacherId: string,
  opts: {
    roomId?: string | null;
    requiresConfirmation?: boolean;
  } = {},
) {
  return prisma.classGroup.create({
    data: scopedData(centerId, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId,
      roomId: opts.roomId ?? null,
      price: 10_000,
      requiresConfirmation: opts.requiresConfirmation ?? false,
    }),
  });
}

async function makeSession(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  roomId: string | null,
  date: Date,
  startTime: string,
  endTime: string,
) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      roomId,
      date,
      startTime,
      endTime,
      priceSnapshot: 10_000,
    }),
  });
}

async function main() {
  await cleanup();

  console.log("Pure capacity/cooldown primitives (lib/capacity.ts)");

  // R3 reverses M15's min(class, room): the cap is the room set's capacity only.
  check("enrollmentCap: room set of 20 → cap is 20", enrollmentCap(20) === 20);
  check("enrollmentCap: room set 0 (no room / no capacity set) → unlimited (0)", enrollmentCap(0) === 0);
  check("enrollmentCap: no room set at all → unlimited (0)", enrollmentCap(null) === 0);
  check("isAtCapacity: cap 0 (unlimited) is never at capacity", !isAtCapacity(1_000_000, 0));
  check("isAtCapacity: active === cap is at capacity", isAtCapacity(5, 5));

  const rejectedNow = new Date();
  check(
    "isInCooldown: true the instant a rejection lands",
    isInCooldown(rejectedNow, rejectedNow),
  );
  const eightDaysLater = new Date(rejectedNow);
  eightDaysLater.setUTCDate(eightDaysLater.getUTCDate() + 8);
  check(
    "isInCooldown: false once 7 days have passed",
    !isInCooldown(rejectedNow, eightDaysLater),
  );
  check(
    "cooldownUntil: exactly 7 days after the rejection",
    cooldownUntil(rejectedNow).getTime() - rejectedNow.getTime() === 7 * 24 * 60 * 60 * 1000,
  );

  console.log("\nDatabase-backed checks");

  const center = await prisma.center.create({
    data: { slug: SLUG, name: "Enrollment Check", organization: { create: { name: "Enrollment Check" } } },
  });
  const centerId = center.id;
  const teacher = await makeTeacher(centerId, "teacher");
  const managerId = (await makeTeacher(centerId, "manager")).id; // stands in for an acting staff id — no role check here

  // ── 1. Both StudentBlock scopes, refused at REQUEST time ──────────────────
  const classForTeacherBlockReq = await makeClass(centerId, teacher.id);
  const classForClassBlockReq = await makeClass(centerId, teacher.id);
  const blockedAtRequest = await makeStudentUser("blockedAtRequestTeacher");
  await prisma.studentBlock.create({
    data: scopedData(centerId, { scope: TEACHER_SCOPE, refId: teacher.id, blockedUserId: blockedAtRequest.id }),
  });
  const teacherBlockAtRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classForTeacherBlockReq.id, studentUserId: blockedAtRequest.id }),
  );
  check(
    "TEACHER-scope block refuses the request itself, not just approval",
    !teacherBlockAtRequest.ok && teacherBlockAtRequest.error === "studentBlocked",
    JSON.stringify(teacherBlockAtRequest),
  );

  const blockedAtRequestClass = await makeStudentUser("blockedAtRequestClass");
  await prisma.studentBlock.create({
    data: scopedData(centerId, { scope: CLASS_SCOPE, refId: classForClassBlockReq.id, blockedUserId: blockedAtRequestClass.id }),
  });
  const classBlockAtRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classForClassBlockReq.id, studentUserId: blockedAtRequestClass.id }),
  );
  check(
    "CLASS-scope block refuses the request itself, not just approval",
    !classBlockAtRequest.ok && classBlockAtRequest.error === "studentBlocked",
    JSON.stringify(classBlockAtRequest),
  );

  // ── 2. Both StudentBlock scopes, refused at APPROVAL time (block placed
  // *after* an unblocked request was already accepted into the queue) ──────
  const classForTeacherBlockApprove = await makeClass(centerId, teacher.id, { requiresConfirmation: true });
  const studentBlockedLaterTeacher = await makeStudentUser("blockedLaterTeacher");
  const requestBeforeTeacherBlock = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classForTeacherBlockApprove.id, studentUserId: studentBlockedLaterTeacher.id }),
  );
  check(
    "An unblocked student's request is accepted into the queue",
    requestBeforeTeacherBlock.ok && requestBeforeTeacherBlock.kind === "pending",
    JSON.stringify(requestBeforeTeacherBlock),
  );
  await prisma.studentBlock.create({
    data: scopedData(centerId, { scope: TEACHER_SCOPE, refId: teacher.id, blockedUserId: studentBlockedLaterTeacher.id }),
  });
  const teacherBlockAtApproval =
    requestBeforeTeacherBlock.ok && requestBeforeTeacherBlock.kind === "pending"
      ? await prisma.$transaction((tx) => confirmReservation(tx, centerId, requestBeforeTeacherBlock.reservationId, managerId))
      : null;
  check(
    "A TEACHER-scope block placed between request and approval refuses the approval",
    teacherBlockAtApproval !== null && !teacherBlockAtApproval.ok && teacherBlockAtApproval.error === "studentBlocked",
    JSON.stringify(teacherBlockAtApproval),
  );

  const classForClassBlockApprove = await makeClass(centerId, teacher.id, { requiresConfirmation: true });
  const studentBlockedLaterClass = await makeStudentUser("blockedLaterClass");
  const requestBeforeClassBlock = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classForClassBlockApprove.id, studentUserId: studentBlockedLaterClass.id }),
  );
  await prisma.studentBlock.create({
    data: scopedData(centerId, { scope: CLASS_SCOPE, refId: classForClassBlockApprove.id, blockedUserId: studentBlockedLaterClass.id }),
  });
  const classBlockAtApproval =
    requestBeforeClassBlock.ok && requestBeforeClassBlock.kind === "pending"
      ? await prisma.$transaction((tx) => confirmReservation(tx, centerId, requestBeforeClassBlock.reservationId, managerId))
      : null;
  check(
    "A CLASS-scope block placed between request and approval refuses the approval",
    classBlockAtApproval !== null && !classBlockAtApproval.ok && classBlockAtApproval.error === "studentBlocked",
    JSON.stringify(classBlockAtApproval),
  );

  // ── 3. The 7-day cooling-off, explained rather than silent ───────────────
  const classCooldown = await makeClass(centerId, teacher.id, { requiresConfirmation: true });
  const studentCooldown = await makeStudentUser("cooldown");
  const cooldownRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCooldown.id, studentUserId: studentCooldown.id }),
  );
  const cooldownReservationId =
    cooldownRequest.ok && cooldownRequest.kind === "pending" ? cooldownRequest.reservationId : "";
  const cooldownRejected = await rejectReservation(prisma, centerId, cooldownReservationId, managerId);
  check(
    "rejectReservation stamps rejectedAt",
    cooldownRejected.ok && cooldownRejected.reservation.rejectedAt !== null,
    JSON.stringify(cooldownRejected),
  );

  const immediateRetry = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCooldown.id, studentUserId: studentCooldown.id }),
  );
  check(
    "Re-requesting the same class right after a rejection is refused as coolingOff, with the retry date attached",
    !immediateRetry.ok && immediateRetry.error === "coolingOff" && "cooldownUntil" in immediateRetry,
    JSON.stringify(immediateRetry),
  );

  // Simulate the cooldown having already elapsed.
  const eightDaysAgo = new Date();
  eightDaysAgo.setUTCDate(eightDaysAgo.getUTCDate() - 8);
  await prisma.reservation.update({
    where: { id: cooldownReservationId },
    data: { rejectedAt: eightDaysAgo },
  });
  const retryAfterCooldown = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCooldown.id, studentUserId: studentCooldown.id }),
  );
  check(
    "Once 7 days have passed, the same student can re-request the same class, reusing the same row",
    retryAfterCooldown.ok &&
      retryAfterCooldown.kind === "pending" &&
      retryAfterCooldown.reservationId === cooldownReservationId,
    JSON.stringify(retryAfterCooldown),
  );
  check(
    "Exactly one Reservation row exists across the whole reject → cooldown → re-request lifecycle",
    (await prisma.reservation.count({ where: { classGroupId: classCooldown.id, studentId: studentCooldown.id } })) === 1,
  );

  // ── 4. Capacity: hard-capped by the ROOM, not the class's own target ─────
  const roomSmall = await prisma.room.create({ data: scopedData(centerId, { name: "Small Room", capacity: 2 }) });
  const classCapacityInstant = await makeClass(centerId, teacher.id, { roomId: roomSmall.id });
  const cap1User = await makeStudentUser("cap1");
  const cap2User = await makeStudentUser("cap2");
  const cap3User = await makeStudentUser("cap3");
  const enroll1 = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCapacityInstant.id, studentUserId: cap1User.id }),
  );
  const enroll2 = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCapacityInstant.id, studentUserId: cap2User.id }),
  );
  check(
    "The first two instant-enrolls into a room-capacity-2 class both succeed",
    enroll1.ok && enroll1.kind === "enrolled" && enroll2.ok && enroll2.kind === "enrolled",
    JSON.stringify([enroll1, enroll2]),
  );
  const enroll3 = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: classCapacityInstant.id, studentUserId: cap3User.id }),
  );
  check(
    "A third instant-enroll is refused as classFull — the ROOM's capacity is the hard cap",
    !enroll3.ok && enroll3.error === "classFull",
    JSON.stringify(enroll3),
  );

  const classCapacityConfirm = await makeClass(centerId, teacher.id, { roomId: roomSmall.id, requiresConfirmation: true });
  const confirmStudents = await Promise.all(
    ["conf1", "conf2", "conf3"].map((tag) => makeStudentUser(tag)),
  );
  const confirmRequests = await Promise.all(
    confirmStudents.map((user) =>
      prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId, classGroupId: classCapacityConfirm.id, studentUserId: user.id })),
    ),
  );
  check(
    "A student may still request a class that will turn out to be full — all three requests are accepted",
    confirmRequests.every((r) => r.ok && r.kind === "pending"),
    JSON.stringify(confirmRequests),
  );
  const confirm1 = await prisma.$transaction((tx) =>
    confirmReservation(
      tx,
      centerId,
      confirmRequests[0].ok && confirmRequests[0].kind === "pending" ? confirmRequests[0].reservationId : "",
      managerId,
    ),
  );
  const confirm2 = await prisma.$transaction((tx) =>
    confirmReservation(
      tx,
      centerId,
      confirmRequests[1].ok && confirmRequests[1].kind === "pending" ? confirmRequests[1].reservationId : "",
      managerId,
    ),
  );
  check(
    "Confirming the first two requests fills the room-capacity-2 class",
    confirm1.ok && confirm2.ok,
    JSON.stringify([confirm1, confirm2]),
  );
  const confirm3 = await prisma.$transaction((tx) =>
    confirmReservation(
      tx,
      centerId,
      confirmRequests[2].ok && confirmRequests[2].kind === "pending" ? confirmRequests[2].reservationId : "",
      managerId,
    ),
  );
  check(
    "Staff cannot approve past the cap — the third confirm is refused as classFull, request or no request",
    !confirm3.ok && confirm3.error === "classFull",
    JSON.stringify(confirm3),
  );

  // Attendance on that same over-subscribed room is never capacity-gated —
  // provable in the same run as the enrolment refusals above.
  const capacitySession = await makeSession(
    centerId,
    classCapacityInstant.id,
    teacher.id,
    roomSmall.id,
    new Date("2026-12-01T00:00:00.000Z"),
    "09:00",
    "10:00",
  );
  const attendanceProfiles = await Promise.all(
    ["walkin1", "walkin2", "walkin3", "walkin4"].map((tag) => makeStudentProfile(centerId, tag)),
  );
  const attendanceWrites = await Promise.all(
    attendanceProfiles.map(({ profile }) =>
      createAttendance(prisma, {
        centerId,
        sessionId: capacitySession.id,
        studentProfileId: profile.id,
        enrollmentId: null,
        isDropIn: true,
        recordedBy: managerId,
      }, { historicalBackfill: true, status: "PRESENT" }),
    ),
  );
  check(
    "4 walk-ins mark PRESENT on a session in a 2-seat room — attendance is never capacity-gated (spec §5.1 'Capacity')",
    attendanceWrites.every((row) => row.attendanceStatus === "PRESENT"),
    JSON.stringify(attendanceWrites.map((r) => r.id)),
  );

  // ── 5. Reschedule: free at the start, busy before the window ends ────────
  const roomShared = await prisma.room.create({ data: scopedData(centerId, { name: "Shared Room" }) });
  const teacherOther = await makeTeacher(centerId, "teacherOther");
  const classFixed = await makeClass(centerId, teacher.id, { roomId: roomShared.id });
  const classToReschedule = await makeClass(centerId, teacherOther.id, { roomId: roomShared.id });
  const rescheduleDate = new Date("2026-12-10T00:00:00.000Z");
  await makeSession(centerId, classFixed.id, teacher.id, roomShared.id, rescheduleDate, "16:30", "17:30");
  const sessionToMoveDeny = await makeSession(
    centerId,
    classToReschedule.id,
    teacherOther.id,
    roomShared.id,
    new Date("2026-12-11T00:00:00.000Z"),
    "09:00",
    "10:00",
  );

  const denyResult = await rescheduleSession(
    prisma,
    centerId,
    sessionToMoveDeny.id,
    { date: rescheduleDate, startTime: "16:00", endTime: "17:00" },
    "DENY",
    "en",
    { now: LIFECYCLE_NOW, confirmConflicts: true },
  );
  check(
    "A target free at 16:00 but with the room busy from 16:30 (inside the 16:00–17:00 window) is refused under DENY",
    !denyResult.ok && denyResult.error === "conflict",
    JSON.stringify(denyResult),
  );

  const sessionToMoveWarn = await makeSession(
    centerId,
    classToReschedule.id,
    teacherOther.id,
    roomShared.id,
    new Date("2026-12-12T00:00:00.000Z"),
    "09:00",
    "10:00",
  );
  const warnResult = await rescheduleSession(
    prisma,
    centerId,
    sessionToMoveWarn.id,
    { date: rescheduleDate, startTime: "16:00", endTime: "17:00" },
    "WARN",
    "en",
    { now: LIFECYCLE_NOW, confirmConflicts: true },
  );
  check(
    "The identical target succeeds under WARN, flagged with the same whole-window conflict",
    warnResult.ok && warnResult.conflicts.length > 0,
    JSON.stringify(warnResult),
  );

  // ── 6. Cancelled session: refused by direct call, roster preserved ───────
  const classCancel = await makeClass(centerId, teacher.id);
  const sessionCancel = await makeSession(
    centerId,
    classCancel.id,
    teacher.id,
    null,
    new Date("2026-12-15T00:00:00.000Z"),
    "10:00",
    "11:00",
  );
  const { profile: cancelProfile1 } = await makeStudentProfile(centerId, "cancel1");
  const { profile: cancelProfile2 } = await makeStudentProfile(centerId, "cancel2");
  const attendeeBeforeCancel = await createAttendance(prisma, {
    centerId,
    sessionId: sessionCancel.id,
    studentProfileId: cancelProfile1.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: managerId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const cancelled = await cancelSession(prisma, centerId, sessionCancel.id, { now: LIFECYCLE_NOW });
  check("cancelSession succeeds", cancelled.ok, JSON.stringify(cancelled));

  let newAttendanceRefused = false;
  let newAttendanceReason: string | null = null;
  try {
    await createAttendance(prisma, {
      centerId,
      sessionId: sessionCancel.id,
      studentProfileId: cancelProfile2.id,
      enrollmentId: null,
      isDropIn: true,
      recordedBy: managerId,
    }, { historicalBackfill: true, status: "PRESENT" });
  } catch (error) {
    if (error instanceof SessionClosedError) {
      newAttendanceRefused = true;
      newAttendanceReason = error.reason;
    }
  }
  check(
    "New attendance on a CANCELLED session is refused by direct call to createAttendance, not just hidden in the UI",
    newAttendanceRefused && newAttendanceReason === "sessionCancelled",
  );

  let correctionRefused = false;
  try {
    await updateAttendanceStatus(prisma, attendeeBeforeCancel, "ABSENT", managerId, { historicalBackfill: true });
  } catch (error) {
    correctionRefused = error instanceof SessionClosedError && error.reason === "sessionCancelled";
  }
  check(
    "Correcting an already-recorded attendee's status on a CANCELLED session is refused too",
    correctionRefused,
  );

  const methodId = await fixtureMethodId(centerId);
  const paymentOnCancelled = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendeeBeforeCancel.id, methodId, managerId, { historicalBackfill: true }),
  );
  check(
    "Recording a payment on a CANCELLED session's attendee is refused by direct call to recordPayment",
    !paymentOnCancelled.ok && paymentOnCancelled.error === "sessionCancelled",
    JSON.stringify(paymentOnCancelled),
  );
  const untouchedAttendee = await prisma.sessionAttendee.findUnique({ where: { id: attendeeBeforeCancel.id } });
  check(
    "The attendee recorded before cancellation is preserved exactly as it was — a cancel never deletes roster history",
    untouchedAttendee?.attendanceStatus === "PRESENT",
  );

  // ── 7. Already-rescheduled session: the same refusal applies to the
  // original slot, while the replacement session is open as normal ────────
  const classResched = await makeClass(centerId, teacher.id);
  const sessionOriginal = await makeSession(
    centerId,
    classResched.id,
    teacher.id,
    null,
    new Date("2026-12-20T00:00:00.000Z"),
    "10:00",
    "11:00",
  );
  const { profile: reschedProfile1 } = await makeStudentProfile(centerId, "resched1");
  const { profile: reschedProfile2 } = await makeStudentProfile(centerId, "resched2");
  const attendeeBeforeReschedule = await createAttendance(prisma, {
    centerId,
    sessionId: sessionOriginal.id,
    studentProfileId: reschedProfile1.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: managerId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const reschedule = await rescheduleSession(
    prisma,
    centerId,
    sessionOriginal.id,
    { date: new Date("2026-12-21T00:00:00.000Z"), startTime: "10:00", endTime: "11:00" },
    "WARN",
    "en",
    { now: LIFECYCLE_NOW, confirmConflicts: true },
  );
  check("rescheduleSession succeeds", reschedule.ok, JSON.stringify(reschedule));

  let reschedAttendanceRefused = false;
  try {
    await createAttendance(prisma, {
      centerId,
      sessionId: sessionOriginal.id,
      studentProfileId: reschedProfile2.id,
      enrollmentId: null,
      isDropIn: true,
      recordedBy: managerId,
    }, { historicalBackfill: true, status: "PRESENT" });
  } catch (error) {
    reschedAttendanceRefused = error instanceof SessionClosedError && error.reason === "sessionRescheduled";
  }
  check(
    "New attendance on the original, now-superseded session is refused as sessionRescheduled",
    reschedAttendanceRefused,
  );

  const methodId2 = await fixtureMethodId(centerId);
  const paymentOnRescheduled = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendeeBeforeReschedule.id, methodId2, managerId, { historicalBackfill: true }),
  );
  check(
    "A payment on the original session's pre-existing attendee is refused as sessionRescheduled",
    !paymentOnRescheduled.ok && paymentOnRescheduled.error === "sessionRescheduled",
    JSON.stringify(paymentOnRescheduled),
  );

  const newSessionId = reschedule.ok ? reschedule.session.id : "";
  const attendanceOnReplacement = await createAttendance(prisma, {
    centerId,
    sessionId: newSessionId,
    studentProfileId: reschedProfile2.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: managerId,
  }, { historicalBackfill: true, status: "PRESENT" });
  check(
    "The replacement session (the reschedule target) accepts attendance normally",
    attendanceOnReplacement.attendanceStatus === "PRESENT",
  );

  // ── 8. Teacher centre-directory onboarding: same machinery, no shortcuts ──
  const wanderingTeacher = await makeStudentUser("wandering");
  check(
    "The onboarding requester holds no Membership anywhere — this is genuinely a zero-centre teacher",
    (await prisma.membership.count({ where: { userId: wanderingTeacher.id } })) === 0,
  );
  const onboardingRequest = await prisma.changeRequest.create({
    data: scopedData(centerId, {
      type: "NEW_CLASS",
      requestedBy: wanderingTeacher.id,
      payload: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00", capacity: 5, lateThresholdMinutes: 5 },
    }),
  });
  check(
    "A zero-centre teacher's onboarding request is a plain PENDING NEW_CLASS ChangeRequest — no parallel table",
    onboardingRequest.status === "PENDING" && onboardingRequest.requestedBy === wanderingTeacher.id,
  );
  const onboardingApproved = await resolveChangeRequest(prisma, centerId, onboardingRequest.id, "APPROVED", managerId);
  check(
    "The centre resolves it through the exact same resolveChangeRequest path any other NEW_CLASS request uses",
    onboardingApproved.ok && onboardingApproved.changeRequest.status === "APPROVED",
    JSON.stringify(onboardingApproved),
  );
  check(
    "Approving it does not create a Membership — staff still add the teacher through the ordinary flow (spec §4.1 item 9's decision record, unchanged by onboarding)",
    (await prisma.membership.count({ where: { userId: wanderingTeacher.id } })) === 0,
  );

  await checkBookingSeats(centerId, teacher.id, managerId);
}

/**
 * F6 — bookings and the seat rule, through the REAL production functions:
 * an enrolment takes a seat in every future session, so it is refused
 * (`sessionFull`, naming the first full date) when a future session is full
 * of CONFIRMED bookings — at instant enrol (`reserveOrEnroll`) and at confirm
 * (`confirmReservation`) — and allowed when a seat is left; and cancelling or
 * rescheduling a session cancels its open bookings in the same transaction
 * (`SESSION_CANCELLED` / `SESSION_RESCHEDULED`), leaving a checked-in one as
 * history. Dated relative to the real clock: the seat rule reads "now".
 */
async function checkBookingSeats(centerId: string, teacherId: string, managerId: string): Promise<void> {
  console.log("\nF6 — bookings take seats; session cancel / reschedule cancels bookings");

  const DAY = 24 * 60 * 60 * 1000;
  const utcDay = (offset: number) => {
    const d = new Date(Date.now() + offset * DAY);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };
  const room = await prisma.room.create({ data: scopedData(centerId, { name: "F6 two-seat room", capacity: 2 }) });
  const bookedUp = await prisma.classGroup.update({
    where: { id: (await makeClass(centerId, teacherId, { roomId: room.id })).id },
    data: { sessionBookingMode: "INSTANT" },
  });
  const soon = await makeSession(centerId, bookedUp.id, teacherId, room.id, utcDay(3), "16:00", "18:00");
  const later = await makeSession(centerId, bookedUp.id, teacherId, room.id, utcDay(10), "16:00", "18:00");
  const confirmBookingRow = async (sessionId: string, tag: string) =>
    prisma.sessionBooking.create({
      data: scopedData(centerId, {
        sessionId,
        studentId: (await makeStudentUser(tag)).id,
        status: "CONFIRMED",
        resolvedAt: new Date(),
      }),
    });

  // One confirmed booking on the later session: 0 enrolled + 1 + 1 = 2 seats — fits.
  await confirmBookingRow(later.id, "f6-seat-1");
  const fits = await prisma.$transaction(async (tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: bookedUp.id, studentUserId: (await makeStudentUser("f6-enrol-1")).id }),
  );
  check("An enrolment that still fits every future session (with its bookings) succeeds", fits.ok && fits.kind === "enrolled");

  // Now the later session has 1 enrolled + 1 booked = 2 of 2: one more enrolment overflows it.
  const refused = await prisma.$transaction(async (tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: bookedUp.id, studentUserId: (await makeStudentUser("f6-enrol-2")).id }),
  );
  check(
    "Instant enrolment is refused when a future session is full of bookings, naming its date (sessionFull)",
    // The earlier session has seats left; the refusal names the later one.
    !refused.ok && refused.error === "sessionFull" && "date" in refused &&
      refused.date.getTime() === later.date.getTime() && refused.date.getTime() !== soon.date.getTime(),
    JSON.stringify(refused),
  );
  check(
    "…and no StudentProfile was made for the refused enrolment",
    (await prisma.studentProfile.count({ where: { centerId, user: { email: "enrollment-check-f6-enrol-2@kayedu.test" } } })) === 0,
  );

  // The same rule at confirm.
  const approvalClass = await makeClass(centerId, teacherId, { roomId: room.id, requiresConfirmation: true });
  const approvalSession = await makeSession(centerId, approvalClass.id, teacherId, room.id, utcDay(4), "09:00", "10:00");
  await confirmBookingRow(approvalSession.id, "f6-seat-2");
  await confirmBookingRow(approvalSession.id, "f6-seat-3");
  const request = await prisma.$transaction(async (tx) =>
    reserveOrEnroll(tx, { centerId, classGroupId: approvalClass.id, studentUserId: (await makeStudentUser("f6-request")).id }),
  );
  const confirm =
    request.ok && request.kind === "pending"
      ? await prisma.$transaction((tx) => confirmReservation(tx, centerId, request.reservationId, managerId))
      : null;
  check(
    "Confirming a reservation is refused when a future session is full of bookings (sessionFull)",
    confirm?.ok === false && confirm.error === "sessionFull",
    JSON.stringify(confirm),
  );

  // Cancelling a session cancels its open bookings — a checked-in one stays.
  const cancelClass = await makeClass(centerId, teacherId);
  const toCancel = await makeSession(centerId, cancelClass.id, teacherId, null, utcDay(5), "12:00", "13:00");
  const pendingOne = await prisma.sessionBooking.create({
    data: scopedData(centerId, { sessionId: toCancel.id, studentId: (await makeStudentUser("f6-cancel-p")).id }),
  });
  const confirmedOne = await confirmBookingRow(toCancel.id, "f6-cancel-c");
  const cancelled = await cancelSession(prisma, centerId, toCancel.id);
  const afterCancel = await prisma.sessionBooking.findMany({ where: { id: { in: [pendingOne.id, confirmedOne.id] } } });
  check(
    "Cancelling a session cancels its pending and confirmed bookings (SESSION_CANCELLED), in the same transaction",
    cancelled.ok &&
      afterCancel.length === 2 &&
      afterCancel.every((row) => row.status === "CANCELLED" && row.cancelReason === "SESSION_CANCELLED" && row.cancelledAt !== null),
    JSON.stringify(afterCancel.map((row) => [row.status, row.cancelReason])),
  );

  // Rescheduling cancels them too (SESSION_RESCHEDULED); the replacement starts with none.
  const moveClass = await makeClass(centerId, teacherId);
  const toMove = await makeSession(centerId, moveClass.id, teacherId, null, utcDay(6), "12:00", "13:00");
  const movedBooking = await confirmBookingRow(toMove.id, "f6-move");
  const moved = await rescheduleSession(
    prisma,
    centerId,
    toMove.id,
    { date: utcDay(7), startTime: "12:00", endTime: "13:00" },
    "WARN",
    "en",
    { confirmConflicts: true },
  );
  const afterMove = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: movedBooking.id } });
  check(
    "Rescheduling a session cancels its bookings (SESSION_RESCHEDULED); the replacement carries none",
    moved.ok &&
      afterMove.status === "CANCELLED" &&
      afterMove.cancelReason === "SESSION_RESCHEDULED" &&
      (await prisma.sessionBooking.count({ where: { sessionId: moved.ok ? moved.session.id : "" } })) === 0,
    JSON.stringify({ moved: moved.ok, status: afterMove.status, reason: afterMove.cancelReason }),
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
      console.error(`\n${failures} enrollment check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll enrollment checks passed.");
  });
