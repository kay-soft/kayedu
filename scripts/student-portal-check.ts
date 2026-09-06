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
import { PrismaClient, type BlockScope } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  cancelReservation,
  confirmReservation,
  rejectReservation,
  reserveOrEnroll,
} from "../lib/db/reservations.ts";
import {
  studentActiveEnrollmentClassIds,
  studentBlockedRefsByCenter,
  studentReservationStatusByClass,
} from "../lib/db/student-portal.ts";

const prisma = new PrismaClient();

const SLUG_A = "student-portal-check-a";
const SLUG_B = "student-portal-check-b";
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
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "student-portal-check-" } } });
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
  return prisma.classGroup.create({
    data: scopedData(centerId, {
      teacherId,
      price: 10_000,
      capacity: opts.capacity ?? 0,
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
  const firstRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classReRequest.id, studentUserId: studentX.id }),
  );
  const firstReservationId = firstRequest.ok && firstRequest.kind === "pending" ? firstRequest.reservationId : "";
  const rejected = await rejectReservation(prisma, centerA.id, firstReservationId, teacherA.id);
  check("rejectReservation marks a PENDING request REJECTED", rejected.ok && rejected.reservation.status === "REJECTED");

  const secondRequest = await prisma.$transaction((tx) =>
    reserveOrEnroll(tx, { centerId: centerA.id, classGroupId: classReRequest.id, studentUserId: studentX.id }),
  );
  check(
    "Re-requesting after REJECTED succeeds and reuses the same row (the (classGroupId, studentId) unique constraint)",
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
