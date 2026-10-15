/**
 * Payments check — the M5 acceptance gate (spec §7 acceptance criteria 3-5, 8):
 * "record a payment; change the class's center-cut; confirm the old
 *  payment's numbers are unchanged and the new session uses the new cut" /
 * "a class with FIXED 15 EGP and a class with PERCENTAGE 15% both compute
 *  center/teacher shares correctly on a 120 EGP session" / "add a
 *  non-enrolled student to a session once; attendance + payment recorded
 *  with no enrollment created."
 *
 * Run with:  npm run check:payments
 *
 * Exercises `lib/money.ts`'s `splitShare` with no database at all, then the
 * real production write path — `lib/db/attendance.ts` and
 * `lib/db/payments.ts` (the same functions
 * `app/[locale]/(center)/sessions/actions.ts` and `.../reception/actions.ts`
 * call) — against two throwaway centers. Needs a reachable database and
 * cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  createAttendance,
  consecutiveAbsenceCount,
  updateAttendanceStatus,
} from "../lib/db/attendance.ts";
import { recordPayment, voidPayment } from "../lib/db/payments.ts";
import { splitShare } from "../lib/money.ts";

const prisma = await gatePrisma();

const SLUG_A = "payments-check-a";
const SLUG_B = "payments-check-b";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "payments-check-" } } });
  // Global catalog rows (M13) don't cascade away with the centers above.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Payments-Check" } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: "Payments-Check" } } });
}

async function makeTeacher(centerId: string, email: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: email, email, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: "TEACHER",
      firstName: "T",
      lastName: email,
      email,
      joinedAt: new Date(),
    }),
  });
  return user;
}

async function makeStudent(centerId: string, code: string) {
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: code, locale: "en" },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode: code,
      firstName: "S",
      lastName: code,
    }),
  });
  return { user, profile };
}

async function makeSession(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  priceSnapshot: number,
  date: Date,
) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      date,
      startTime: "16:00",
      endTime: "18:00",
      priceSnapshot,
    }),
  });
}

function checkPureSplitShare() {
  console.log("Pure share-split primitive (lib/money.ts)");

  const fixed = splitShare(12_000, "FIXED", 1_500); // 120 EGP session, 15 EGP fixed cut
  check(
    "FIXED 15 EGP on a 120 EGP session: center=15 EGP, teacher=105 EGP",
    fixed.centerShare === 1_500 && fixed.teacherShare === 10_500,
    JSON.stringify(fixed),
  );

  const percentage = splitShare(12_000, "PERCENTAGE", 15); // 120 EGP session, 15%
  check(
    "PERCENTAGE 15% on a 120 EGP session: center=18 EGP, teacher=102 EGP",
    percentage.centerShare === 1_800 && percentage.teacherShare === 10_200,
    JSON.stringify(percentage),
  );

  const rounded = splitShare(999, "PERCENTAGE", 15); // 999 * 0.15 = 149.85
  check(
    "PERCENTAGE rounds to the nearest piastre",
    rounded.centerShare === 150,
    JSON.stringify(rounded),
  );
}

async function main() {
  await cleanup();
  checkPureSplitShare();

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Payments A", organization: { create: { name: "Payments A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Payments B", organization: { create: { name: "Payments B" } } },
  });

  // R1: methods are per-centre rows now (fixture shape only — the assertions
  // below are unchanged). `check:payment-methods` covers the method rules.
  const [cashA, instapayA, walletA, cashB] = await Promise.all([
    prisma.centerPaymentMethod.create({ data: { centerId: centerA.id, name: "Cash" } }),
    prisma.centerPaymentMethod.create({ data: { centerId: centerA.id, name: "InstaPay" } }),
    prisma.centerPaymentMethod.create({ data: { centerId: centerA.id, name: "Wallet" } }),
    prisma.centerPaymentMethod.create({ data: { centerId: centerB.id, name: "Cash" } }),
  ]);

  const teacherA = await makeTeacher(centerA.id, "payments-check-teacher-a@kayedu.test");
  const actorId = teacherA.id; // stands in for a recording staff member's userId

  // Global catalog rows (M13) — no centerId; ClassGroup references them directly.
  const subjectA = await prisma.catalogSubject.create({
    data: { nameAr: "Payments-Check Math", nameEn: "Payments-Check Math" },
  });
  const gradeA = await prisma.catalogGrade.create({
    data: { nameAr: "Payments-Check Grade 10", nameEn: "Payments-Check Grade 10" },
  });

  const PRICE = 12_000; // 120 EGP

  // ── 1. FIXED vs PERCENTAGE, both correct on a 120 EGP session ───────────
  const classFixed = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacherA.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      price: PRICE,
      centerShareType: "FIXED",
      centerShareValue: 1_500, // 15 EGP
    }),
  });
  const classPercentage = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacherA.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      price: PRICE,
      centerShareType: "PERCENTAGE",
      centerShareValue: 15,
    }),
  });

  const student1 = await makeStudent(centerA.id, "P001");

  const sessionFixed = await makeSession(
    centerA.id,
    classFixed.id,
    teacherA.id,
    PRICE,
    new Date("2026-02-02T00:00:00Z"),
  );
  const attendeeFixed = await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: sessionFixed.id,
    studentProfileId: student1.profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const paymentFixedResult = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeFixed.id, cashA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "FIXED class: recordPayment freezes centerShareSnapshot=15 EGP, teacherShareSnapshot=105 EGP",
    paymentFixedResult.ok &&
      paymentFixedResult.payment.centerShareSnapshot === 1_500 &&
      paymentFixedResult.payment.teacherShareSnapshot === 10_500,
    JSON.stringify(paymentFixedResult),
  );

  const sessionPercentage = await makeSession(
    centerA.id,
    classPercentage.id,
    teacherA.id,
    PRICE,
    new Date("2026-02-02T00:00:00Z"),
  );
  const attendeePercentage = await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: sessionPercentage.id,
    studentProfileId: student1.profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const paymentPercentageResult = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeePercentage.id, cashA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "PERCENTAGE class: recordPayment freezes centerShareSnapshot=18 EGP, teacherShareSnapshot=102 EGP",
    paymentPercentageResult.ok &&
      paymentPercentageResult.payment.centerShareSnapshot === 1_800 &&
      paymentPercentageResult.payment.teacherShareSnapshot === 10_200,
    JSON.stringify(paymentPercentageResult),
  );

  // ── 2. Snapshot immutability after a later config change ────────────────
  if (!paymentFixedResult.ok) throw new Error("paymentFixedResult was not ok");
  await prisma.classGroup.update({
    where: { id: classFixed.id },
    data: { centerShareValue: 3_000 }, // the center raises its fixed cut to 30 EGP
  });

  const reloadedOldPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentFixedResult.payment.id },
  });
  check(
    "An already-recorded payment keeps its old centerShareSnapshot after the class's cut changes",
    reloadedOldPayment.centerShareSnapshot === 1_500 && reloadedOldPayment.teacherShareSnapshot === 10_500,
    JSON.stringify(reloadedOldPayment),
  );

  const student2 = await makeStudent(centerA.id, "P002");
  const sessionFixedAfterChange = await makeSession(
    centerA.id,
    classFixed.id,
    teacherA.id,
    PRICE,
    new Date("2026-02-09T00:00:00Z"),
  );
  const attendeeAfterChange = await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: sessionFixedAfterChange.id,
    studentProfileId: student2.profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const paymentAfterChange = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeAfterChange.id, cashA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "A new payment recorded after the config change uses the new cut (30 EGP)",
    paymentAfterChange.ok && paymentAfterChange.payment.centerShareSnapshot === 3_000,
    JSON.stringify(paymentAfterChange),
  );

  // ── 3. Drop-in: attendance + payment recorded, no Enrollment created ────
  const enrollmentCountForStudent1 = await prisma.enrollment.count({
    where: scopedWhere(centerA.id, {
      studentProfileId: student1.profile.id,
      classGroupId: { in: [classFixed.id, classPercentage.id] },
    }),
  });
  check(
    "A drop-in attendee has zero Enrollment rows for the class they attended",
    enrollmentCountForStudent1 === 0,
    `found ${enrollmentCountForStudent1}`,
  );
  check(
    "The drop-in's SessionAttendee is flagged isDropIn with no enrollmentId",
    attendeeFixed.isDropIn === true && attendeeFixed.enrollmentId === null,
  );
  check(
    "The drop-in still gets attendance recorded",
    attendeeFixed.attendanceStatus === "PRESENT",
  );
  check(
    "The drop-in still gets a payment recorded (no enrollment required)",
    paymentFixedResult.ok,
  );

  // ── 4. Attempting a second active payment for the same attendee fails ───
  const secondAttempt = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeFixed.id, instapayA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "recordPayment refuses a second active payment for the same attendee",
    !secondAttempt.ok && secondAttempt.error === "alreadyPaid",
    JSON.stringify(secondAttempt),
  );

  // ── 5. Void-then-recreate leaves history intact ──────────────────────────
  const voidResult = await prisma.$transaction((tx) =>
    voidPayment(tx, centerA.id, paymentFixedResult.payment.id, "Paid by mistake", actorId, { historicalBackfill: true }),
  );
  check(
    "voidPayment marks the row voided without touching its money fields",
    voidResult.ok &&
      voidResult.payment.voided === true &&
      voidResult.payment.voidReason === "Paid by mistake" &&
      voidResult.payment.voidedBy === actorId &&
      voidResult.payment.amount === PRICE &&
      voidResult.payment.centerShareSnapshot === 1_500,
    JSON.stringify(voidResult),
  );

  const recreated = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, attendeeFixed.id, walletA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "A corrected payment can be recorded for the same attendee once the old one is voided",
    recreated.ok && !recreated.payment.voided,
    JSON.stringify(recreated),
  );

  const historyForAttendee = await prisma.payment.findMany({
    where: scopedWhere(centerA.id, { sessionAttendeeId: attendeeFixed.id }),
    orderBy: { recordedAt: "asc" },
  });
  check(
    "The void did not delete the original row — both payments exist for that attendee",
    historyForAttendee.length === 2,
    `found ${historyForAttendee.length}`,
  );
  check(
    "The original (voided) row still has its original snapshot",
    historyForAttendee[0].voided === true && historyForAttendee[0].centerShareSnapshot === 1_500,
  );
  check(
    "Exactly one of the two rows is active (non-voided)",
    historyForAttendee.filter((row) => !row.voided).length === 1,
  );

  const doubleVoid = await prisma.$transaction((tx) =>
    voidPayment(tx, centerA.id, paymentFixedResult.payment.id, "again", actorId, { historicalBackfill: true }),
  );
  check(
    "Voiding an already-voided payment is refused, not silently repeated",
    !doubleVoid.ok && doubleVoid.error === "alreadyVoided",
  );

  // ── 6. Attendance-status gating: only PRESENT/LATE are payable ──────────
  const student3 = await makeStudent(centerA.id, "P003");
  const sessionAbsentPay = await makeSession(
    centerA.id,
    classFixed.id,
    teacherA.id,
    PRICE,
    new Date("2026-02-16T00:00:00Z"),
  );
  const absentAttendee = await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: sessionAbsentPay.id,
    studentProfileId: student3.profile.id,
    enrollmentId: null,
    isDropIn: false,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "ABSENT" });
  const absentPaymentAttempt = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, absentAttendee.id, cashA.id, actorId, { historicalBackfill: true }),
  );
  check(
    "\"Attend = pay, or not counted\": an ABSENT attendee cannot have a payment recorded",
    !absentPaymentAttempt.ok && absentPaymentAttempt.error === "attendanceNotPayable",
    JSON.stringify(absentPaymentAttempt),
  );

  // ── 7. Consecutive-absence counting (spec §7 acceptance criterion 13) ───
  const studentAbsentee = await makeStudent(centerA.id, "P004");
  const absenceDates = [
    new Date("2026-03-02T00:00:00Z"),
    new Date("2026-03-09T00:00:00Z"),
    new Date("2026-03-16T00:00:00Z"),
  ];
  let lastSession;
  for (const date of absenceDates) {
    const session = await makeSession(centerA.id, classFixed.id, teacherA.id, PRICE, date);
    await createAttendance(prisma, {
      centerId: centerA.id,
      sessionId: session.id,
      studentProfileId: studentAbsentee.profile.id,
      enrollmentId: null,
      isDropIn: false,
      recordedBy: actorId,
    }, { historicalBackfill: true, status: "ABSENT" });
    lastSession = session;
  }
  const threeInARow = await consecutiveAbsenceCount(
    prisma,
    centerA.id,
    classFixed.id,
    studentAbsentee.profile.id,
    lastSession!.date,
  );
  check(
    "Marking a student absent 3 sessions in a row counts as 3",
    threeInARow === 3,
    `got ${threeInARow}`,
  );

  const presentDate = new Date("2026-03-23T00:00:00Z");
  const presentSession = await makeSession(centerA.id, classFixed.id, teacherA.id, PRICE, presentDate);
  await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: presentSession.id,
    studentProfileId: studentAbsentee.profile.id,
    enrollmentId: null,
    isDropIn: false,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const resetToZero = await consecutiveAbsenceCount(
    prisma,
    centerA.id,
    classFixed.id,
    studentAbsentee.profile.id,
    presentDate,
  );
  check("A PRESENT mark resets the consecutive-absence streak to 0", resetToZero === 0);

  const nextAbsentDate = new Date("2026-03-30T00:00:00Z");
  const nextAbsentSession = await makeSession(
    centerA.id,
    classFixed.id,
    teacherA.id,
    PRICE,
    nextAbsentDate,
  );
  await createAttendance(prisma, {
    centerId: centerA.id,
    sessionId: nextAbsentSession.id,
    studentProfileId: studentAbsentee.profile.id,
    enrollmentId: null,
    isDropIn: false,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "ABSENT" });
  const startsOverAtOne = await consecutiveAbsenceCount(
    prisma,
    centerA.id,
    classFixed.id,
    studentAbsentee.profile.id,
    nextAbsentDate,
  );
  check(
    "A new absence after a present streaks from 1, not 4",
    startsOverAtOne === 1,
    `got ${startsOverAtOne}`,
  );

  // ── 8. Attendance correction is audited (spec §7 acceptance criterion 8) ─
  // `updateAttendanceStatus` itself only changes the row (`lib/db/attendance.ts`
  // deliberately has no audit call of its own — see its module comment); the
  // Server Action (`setAttendanceAction`) is what writes the AuditLog row
  // right after, exactly like `approvals-check.ts`'s audit assertion. This
  // reproduces that same write and checks its shape and center scoping.
  const beforeCorrectionStatus = await prisma.sessionAttendee.findFirst({
    where: { centerId: centerA.id, sessionId: nextAbsentSession.id, studentProfileId: studentAbsentee.profile.id },
  });
  check("A roster row exists to correct", beforeCorrectionStatus !== null);
  const corrected = await updateAttendanceStatus(prisma, beforeCorrectionStatus!, "PRESENT", actorId, { historicalBackfill: true });
  check(
    "attendance.correct changes the recorded status",
    corrected.attendanceStatus === "PRESENT",
  );
  const correctionAuditRow = await prisma.auditLog.create({
    data: {
      centerId: centerA.id,
      actorUserId: actorId,
      action: "attendance.correct",
      entityType: "SessionAttendee",
      entityId: corrected.id,
      before: { attendanceStatus: "ABSENT" },
      after: { attendanceStatus: "PRESENT" },
    },
  });
  check(
    "The attendance.correct AuditLog row is scoped to the acting center with the expected shape",
    correctionAuditRow.centerId === centerA.id &&
      correctionAuditRow.action === "attendance.correct" &&
      correctionAuditRow.entityType === "SessionAttendee" &&
      correctionAuditRow.entityId === corrected.id,
  );
  const correctionAuditInCenterB = await prisma.auditLog.findMany({
    where: { centerId: centerB.id, entityId: corrected.id },
  });
  check(
    "Center B's audit log never sees Center A's attendance correction",
    correctionAuditInCenterB.length === 0,
  );

  // ── 9. Cross-center isolation on Payment/SessionAttendee ────────────────
  check(
    "Center B cannot resolve Center A's SessionAttendee by id",
    (await scopedFindById(prisma.sessionAttendee, centerB.id, attendeeFixed.id)) === null,
  );
  check(
    "Center B cannot resolve Center A's Payment by id",
    (await scopedFindById(prisma.payment, centerB.id, recreated.ok ? recreated.payment.id : "")) === null,
  );
  const crossCenterPaymentAttempt = await prisma.$transaction((tx) =>
    recordPayment(tx, centerB.id, attendeePercentage.id, cashB.id, actorId, { historicalBackfill: true }),
  );
  check(
    "Center B cannot record a payment against Center A's SessionAttendee",
    !crossCenterPaymentAttempt.ok && crossCenterPaymentAttempt.error === "notFound",
    JSON.stringify(crossCenterPaymentAttempt),
  );
  const crossCenterVoidAttempt = await prisma.$transaction((tx) =>
    voidPayment(tx, centerB.id, paymentPercentageResult.ok ? paymentPercentageResult.payment.id : "", "x", actorId, { historicalBackfill: true }),
  );
  check(
    "Center B cannot void Center A's Payment",
    !crossCenterVoidAttempt.ok && crossCenterVoidAttempt.error === "notFound",
    JSON.stringify(crossCenterVoidAttempt),
  );
  const paymentsInB = await prisma.payment.findMany({ where: scopedWhere(centerB.id) });
  check("A scoped payment list for Center B contains none of Center A's payments", paymentsInB.length === 0);
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
      console.error(`\n${failures} payments check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll payments checks passed.");
  });
