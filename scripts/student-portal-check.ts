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
  rejectReservation,
  reserveOrEnroll,
} from "../lib/db/reservations.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { generateFamilyCode, hashFamilyCode } from "../lib/db/parents.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import {
  studentActiveEnrollmentClassIds,
  studentBlockedRefsByCenter,
  studentReservationStatusByClass,
} from "../lib/db/student-portal.ts";

const prisma = await gatePrisma();

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
  await invite(u1.id, "01000000001", "ACCEPTED", new Date(Date.now() - 2 * day), "Older");
  await invite(u1.id, "01000000002", "PENDING", new Date(Date.now() - day), "Newer");
  await join(centerA.id, classA.id, u1.id);
  const whole = await profileAt(centerA.id, u1.id);
  check(
    "A new profile takes the account grade and the latest declared parent, and is stamped complete",
    whole?.gradeId === gSeed.id && whole.parentPhone === "01000000002" && whole.parentFirstName === "Newer" &&
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
  await invite(u3.id, "01000000003", "PENDING", new Date());
  await join(centerA.id, classA.id, u3.id);
  const parentOnly = await profileAt(centerA.id, u3.id);
  check("Parent without a grade: seeded, but the one-time form still stands", parentOnly?.gradeId === null && parentOnly.parentPhone === "01000000003" && parentOnly.profileCompletedAt === null);

  // d. a grade this branch does not offer is not seeded (SEC-49).
  const u4 = await user("unoffered", { gradeId: gNotOffered.id });
  await invite(u4.id, "01000000004", "PENDING", new Date());
  await join(centerA.id, classA.id, u4.id);
  const unoffered = await profileAt(centerA.id, u4.id);
  check("A grade the branch does not offer is left empty, so the form stays", unoffered?.gradeId === null && unoffered.profileCompletedAt === null);

  // e. a cancelled invitation declares nobody.
  const u5 = await user("cancelled", { gradeId: gSeed.id });
  await invite(u5.id, "01000000005", "REVOKED", new Date());
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
  check("A second branch seeds from the account as it is now, independently of the first", atB?.gradeId === gOther.id && atB.parentPhone === "01000000002");

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
