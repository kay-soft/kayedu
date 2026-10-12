/**
 * Teacher portal check — the M7 acceptance gate (docs/03-build-order.md M7
 * "Done when": "a teacher shared by two centers sees a correct combined
 * schedule and earnings, each scoped to that center's own data, with zero
 * cross-center leakage"), joining the shared-teacher no-leak test flagged as
 * outstanding at docs/02-architecture.md §5 since M1.
 *
 * Run with:  npm run check:teacher-portal
 *
 * Exercises the real production functions — `lib/db/teacher-portal.ts` (the
 * module the teacher dashboard/sessions/students pages call),
 * `lib/db/attendance.ts`/`lib/db/payments.ts` (M5), and the tenant-scoping
 * primitives (`lib/db/tenant-scope.ts`) — against two throwaway centers that
 * share one teacher. Needs a reachable database and cleans up after itself.
 */
import { PrismaClient, type BlockScope } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import {
  combineTeacherSummaries,
  studentSessionsWithTeacher,
  teacherCenterSummary,
  teacherSessionListWhere,
  teacherStudentProfileIds,
} from "../lib/db/teacher-portal.ts";
import { can } from "../lib/auth/permissions.ts";
import { startOfUtcDay, weekRangeUtc } from "../lib/scheduling.ts";

const prisma = new PrismaClient();

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

const SLUG_A = "teacher-portal-check-a";
const SLUG_B = "teacher-portal-check-b";
/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER_SCOPE: BlockScope = "TEACHER";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "teacher-portal-check-" } } });
  // Global catalog rows (M13) don't cascade away with the centers above.
  await prisma.catalogSubject.deleteMany({
    where: { nameEn: { startsWith: "Teacher-Portal-Check" } },
  });
  await prisma.catalogGrade.deleteMany({
    where: { nameEn: { startsWith: "Teacher-Portal-Check" } },
  });
}

async function makeStudent(centerId: string, code: string) {
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: code, locale: "en" },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: code, firstName: "S", lastName: code }),
  });
  return { user, profile };
}

async function makeSession(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  priceSnapshot: number,
  date: Date,
  startTime: string,
) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      date,
      startTime,
      endTime: "18:00",
      priceSnapshot,
    }),
  });
}

async function payFor(
  centerId: string,
  sessionId: string,
  studentProfileId: string,
  actorId: string,
) {
  const attendee = await createAttendance(prisma, {
    centerId,
    sessionId,
    studentProfileId,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const methodId = await fixtureMethodId(centerId);
  const result = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendee.id, methodId, actorId, { historicalBackfill: true }),
  );
  if (!result.ok) throw new Error(`recordPayment failed: ${result.error}`);
  return { attendee, payment: result.payment };
}

async function main() {
  await cleanup();

  // The seeded baseline a fresh center's TEACHER matrix rows carry
  // (docs/03-build-order.md M12's backfill) — passed explicitly here so this
  // stays a database-free resolution-logic check, the matrix's own DB-backed
  // behavior is `check:permissions`'s job.
  const TEACHER_BASELINE_GRANTS = {
    "analytics.own.view": true,
    "changeRequest.create": true,
    "student.block": true,
  } as const;

  console.log("Permission map (no database needed)");
  check(
    "TEACHER cannot view center.profit.view — M7 must not widen this",
    !can("TEACHER", "center.profit.view"),
  );
  check(
    "TEACHER's profit-view ceiling holds even against a stray grant (M12)",
    !can("TEACHER", "center.profit.view", { "center.profit.view": true }),
  );
  check(
    "TEACHER cannot view analytics.center.view — center-wide analytics stays center-staff only",
    !can("TEACHER", "analytics.center.view"),
  );
  check(
    "TEACHER keeps its baseline: analytics.own.view, changeRequest.create, student.block",
    can("TEACHER", "analytics.own.view", TEACHER_BASELINE_GRANTS) &&
      can("TEACHER", "changeRequest.create", TEACHER_BASELINE_GRANTS) &&
      can("TEACHER", "student.block", TEACHER_BASELINE_GRANTS),
  );

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Teacher Portal A", organization: { create: { name: "Teacher Portal A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Teacher Portal B", organization: { create: { name: "Teacher Portal B" } } },
  });

  // One teacher, shared by both centers — the flagship scenario.
  const teacher = await prisma.user.create({
    data: { firstName: "T", lastName: "Shared", email: "teacher-portal-check-teacher@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerA.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "Shared", joinedAt: new Date() }),
  });
  await prisma.membership.create({
    data: scopedData(centerB.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "Shared", joinedAt: new Date() }),
  });

  // Global catalog rows (M13) — no centerId; ClassGroup references them directly.
  const subjectA = await prisma.catalogSubject.create({
    data: { nameAr: "Teacher-Portal-Check Math", nameEn: "Teacher-Portal-Check Math" },
  });
  const gradeA = await prisma.catalogGrade.create({
    data: { nameAr: "Teacher-Portal-Check Grade 10", nameEn: "Teacher-Portal-Check Grade 10" },
  });
  const subjectB = await prisma.catalogSubject.create({
    data: { nameAr: "Teacher-Portal-Check Physics", nameEn: "Teacher-Portal-Check Physics" },
  });

  const classA = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      teacherId: teacher.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      price: 10_000, // 100 EGP
      centerShareType: "FIXED",
      centerShareValue: 1_000, // 10 EGP
    }),
  });
  const classB = await prisma.classGroup.create({
    data: scopedData(centerB.id, {
      teacherId: teacher.id,
      subjectId: subjectB.id,
      price: 20_000, // 200 EGP
      centerShareType: "PERCENTAGE",
      centerShareValue: 25,
    }),
  });

  const studentA1 = await makeStudent(centerA.id, "TPA001");
  const studentA2 = await makeStudent(centerA.id, "TPA002");
  const studentB1 = await makeStudent(centerB.id, "TPB001");
  const studentB2 = await makeStudent(centerB.id, "TPB002");

  const today = startOfUtcDay(new Date());
  const week = weekRangeUtc(new Date());

  // Center A: two sessions today, one paid attendee each.
  const sessionA1 = await makeSession(centerA.id, classA.id, teacher.id, 10_000, today, "10:00");
  const sessionA2 = await makeSession(centerA.id, classA.id, teacher.id, 10_000, today, "14:00");
  const { payment: paymentA1 } = await payFor(centerA.id, sessionA1.id, studentA1.profile.id, teacher.id);
  const { payment: paymentA2 } = await payFor(centerA.id, sessionA2.id, studentA2.profile.id, teacher.id);

  // Center B: one session today, one paid attendee — deliberately different
  // money shape (percentage cut) so a mixed-up split would be caught too.
  const sessionB1 = await makeSession(centerB.id, classB.id, teacher.id, 20_000, today, "11:00");
  const { payment: paymentB1 } = await payFor(centerB.id, sessionB1.id, studentB1.profile.id, teacher.id);
  await createAttendance(prisma, {
    centerId: centerB.id,
    sessionId: sessionB1.id,
    studentProfileId: studentB2.profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: teacher.id,
  }, { historicalBackfill: true, status: "ABSENT" });

  // ── 1. Per-center session queries never cross ────────────────────────────
  const sessionsA = await prisma.session.findMany({
    where: scopedWhere(centerA.id, teacherSessionListWhere({ teacherId: teacher.id, from: today, to: week.end })),
  });
  const sessionsB = await prisma.session.findMany({
    where: scopedWhere(centerB.id, teacherSessionListWhere({ teacherId: teacher.id, from: today, to: week.end })),
  });
  check(
    "Center A's teacher session query returns exactly A's 2 sessions",
    sessionsA.length === 2 && sessionsA.every((s) => s.centerId === centerA.id),
    JSON.stringify(sessionsA.map((s) => s.id)),
  );
  check(
    "Center B's teacher session query returns exactly B's 1 session — none of A's",
    sessionsB.length === 1 && sessionsB[0].centerId === centerB.id,
    JSON.stringify(sessionsB.map((s) => s.id)),
  );

  const gradeFiltered = await prisma.session.findMany({
    where: scopedWhere(
      centerA.id,
      teacherSessionListWhere({ teacherId: teacher.id, from: today, to: week.end, gradeId: gradeA.id }),
    ),
  });
  check("Grade filter narrows Center A's session list correctly", gradeFiltered.length === 2);

  const studentFiltered = await prisma.session.findMany({
    where: scopedWhere(
      centerA.id,
      teacherSessionListWhere({ teacherId: teacher.id, from: today, to: week.end, studentQuery: "TPA001" }),
    ),
  });
  check(
    "Student search narrows to the one session studentA1 attended",
    studentFiltered.length === 1 && studentFiltered[0].id === sessionA1.id,
    JSON.stringify(studentFiltered.map((s) => s.id)),
  );

  // ── 2. Per-center dashboard summaries, and their union ───────────────────
  const summaryA = await teacherCenterSummary(prisma, centerA.id, teacher.id, today, week, {
    from: week.start,
    to: week.end,
  });
  const summaryB = await teacherCenterSummary(prisma, centerB.id, teacher.id, today, week, {
    from: week.start,
    to: week.end,
  });
  check(
    "Center A's summary sees exactly its own 2 sessions today and 2 payments — nothing from B",
    summaryA.sessionsToday === 2 &&
      summaryA.earnings.paymentCount === 2 &&
      summaryA.earnings.teacherShare === paymentA1.teacherShareSnapshot + paymentA2.teacherShareSnapshot,
    JSON.stringify(summaryA),
  );
  check(
    "Center B's summary sees exactly its own 1 session today and 1 payment — nothing from A",
    summaryB.sessionsToday === 1 &&
      summaryB.earnings.paymentCount === 1 &&
      summaryB.earnings.teacherShare === paymentB1.teacherShareSnapshot,
    JSON.stringify(summaryB),
  );

  const combined = combineTeacherSummaries([summaryA, summaryB]);
  check(
    "The combined dashboard total is exactly the union of both centers' independently-scoped summaries",
    combined.centerCount === 2 &&
      combined.sessionsToday === summaryA.sessionsToday + summaryB.sessionsToday &&
      combined.teacherShare === summaryA.earnings.teacherShare + summaryB.earnings.teacherShare,
    JSON.stringify(combined),
  );

  // ── 3. Student rosters and per-student history never cross ──────────────
  const rosterA = await teacherStudentProfileIds(prisma, centerA.id, teacher.id);
  const rosterB = await teacherStudentProfileIds(prisma, centerB.id, teacher.id);
  check(
    "Center A's teacher roster is exactly studentA1 + studentA2 — never B's students",
    rosterA.length === 2 &&
      rosterA.includes(studentA1.profile.id) &&
      rosterA.includes(studentA2.profile.id),
    JSON.stringify(rosterA),
  );
  check(
    "Center B's teacher roster is exactly studentB1 + studentB2 — never A's students",
    rosterB.length === 2 &&
      rosterB.includes(studentB1.profile.id) &&
      rosterB.includes(studentB2.profile.id),
    JSON.stringify(rosterB),
  );

  const historyA1 = await studentSessionsWithTeacher(prisma, centerA.id, teacher.id, studentA1.profile.id);
  check(
    "studentA1's history with this teacher is exactly their 1 session at Center A",
    historyA1.length === 1 && historyA1[0].session.id === sessionA1.id,
    JSON.stringify(historyA1.map((row) => row.session.id)),
  );

  // A center-B lookup of a center-A student id must resolve to nothing.
  const crossCenterStudentLookup = await scopedFindById(
    prisma.studentProfile,
    centerB.id,
    studentA1.profile.id,
  );
  check(
    "Center B cannot resolve Center A's StudentProfile by id",
    crossCenterStudentLookup === null,
  );

  // ── 4. Cross-center-by-ID isolation on the money/session rows themselves ─
  check(
    "Center B cannot resolve Center A's Session by id",
    (await scopedFindById(prisma.session, centerB.id, sessionA1.id)) === null,
  );
  check(
    "Center A cannot resolve Center B's Session by id",
    (await scopedFindById(prisma.session, centerA.id, sessionB1.id)) === null,
  );
  check(
    "Center B cannot resolve Center A's Payment by id",
    (await scopedFindById(prisma.payment, centerB.id, paymentA1.id)) === null,
  );

  // ── 5. StudentBlock scope TEACHER stays per-center (regression, M3) ──────
  const block = await prisma.studentBlock.create({
    data: scopedData(centerA.id, {
      scope: TEACHER_SCOPE,
      refId: teacher.id,
      blockedUserId: studentA1.user.id,
    }),
  });
  const blockedAtA =
    (await prisma.studentBlock.count({
      where: scopedWhere(centerA.id, { scope: TEACHER_SCOPE, refId: teacher.id, blockedUserId: studentA1.user.id }),
    })) > 0;
  const blockedAtB =
    (await prisma.studentBlock.count({
      where: scopedWhere(centerB.id, { scope: TEACHER_SCOPE, refId: teacher.id, blockedUserId: studentA1.user.id }),
    })) > 0;
  check(
    "A block at Center A blocks the student there",
    blockedAtA,
  );
  check(
    "The same shared teacher blocking a student at Center A has NOT blocked them at Center B",
    !blockedAtB,
  );
  check(
    "Center B cannot resolve Center A's StudentBlock by id",
    (await scopedFindById(prisma.studentBlock, centerB.id, block.id)) === null,
  );

  // ── 6. ChangeRequest write path is centerId-isolated (M7) ────────────────
  const requestA = await prisma.changeRequest.create({
    data: scopedData(centerA.id, {
      type: "NEW_CLASS",
      requestedBy: teacher.id,
      payload: { subjectId: subjectA.id, dayOfWeek: 1, startTime: "16:00", endTime: "18:00" },
      status: "PENDING",
    }),
  });
  check(
    "Center B cannot resolve Center A's ChangeRequest by id",
    (await scopedFindById(prisma.changeRequest, centerB.id, requestA.id)) === null,
  );
  const listA = await prisma.changeRequest.findMany({
    where: scopedWhere(centerA.id, { requestedBy: teacher.id }),
  });
  const listB = await prisma.changeRequest.findMany({
    where: scopedWhere(centerB.id, { requestedBy: teacher.id }),
  });
  check(
    "The same teacher's ChangeRequest list at Center A is not visible from Center B's scope",
    listA.length === 1 && listB.length === 0,
    JSON.stringify({ listA: listA.length, listB: listB.length }),
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
      console.error(`\n${failures} teacher-portal check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll teacher-portal checks passed.");
  });
