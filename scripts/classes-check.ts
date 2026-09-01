/**
 * Classes check — the M4 acceptance gate:
 * "a class with two weekly slots generates correct future sessions; a
 *  room/teacher double-book is prevented or warned per rule; enrolling past
 *  capacity is blocked."
 *
 * Run with:  npm run check:classes
 *
 * Exercises the pure scheduling primitives (`lib/scheduling.ts`) with no
 * database at all, then the real database-backed pieces — `classGroupSchema`
 * / `classScheduleSchema` (the same zod schemas the Server Actions parse
 * with), the tenant-scoping primitives, and `generateSessions` (the actual
 * production generator, `lib/db/sessions.ts`) — against two throwaway
 * centers. Capacity, duplicate-enrollment and the `StudentBlock` (scope
 * CLASS) check are exercised the same way `config-check.ts`/`people-check.ts`
 * exercise their Server Actions' logic: directly, through the same
 * primitives, since a Server Action itself needs a request context this
 * script does not have.
 *
 * It needs a reachable database and cleans up after itself.
 */
import {
  PrismaClient,
  type BlockScope,
  type EnrollmentStatus,
  type Role,
} from "@prisma/client";
import {
  scopedData,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import {
  addDays,
  findScheduleConflicts,
  findSessionConflicts,
  generateOccurrenceDates,
  isValidTimeRange,
  startOfUtcDay,
  timeRangesOverlap,
  type ExistingScheduleSlot,
} from "../lib/scheduling.ts";
import {
  classGroupSchema,
  classScheduleSchema,
} from "../lib/validation/classes.ts";
import { generateSessions } from "../lib/db/sessions.ts";

const prisma = new PrismaClient();

const TEACHER_ROLE: Role = "TEACHER";
const CLASS_SCOPE: BlockScope = "CLASS";
const ACTIVE: EnrollmentStatus = "ACTIVE";
const EXISTING_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];

const SLUG_A = "classes-check-a";
const SLUG_B = "classes-check-b";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function parse<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: Record<string, string>,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined) {
    throw new Error(`${label} failed validation: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** Drops the `locale` field a parsed schema carries — Prisma doesn't know it. */
function withoutLocale<T extends { locale: string }>(value: T): Omit<T, "locale"> {
  const copy: Record<string, unknown> = { ...value };
  delete copy.locale;
  return copy as Omit<T, "locale">;
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({
    where: { email: { startsWith: "classes-check-" } },
  });
}

// ── Pure primitives (no database) ──────────────────────────────────────────

function checkPurePrimitives() {
  console.log("Pure scheduling primitives");

  check(
    "Overlapping ranges detected",
    timeRangesOverlap("16:00", "18:00", "17:00", "19:00"),
  );
  check(
    "Adjacent ranges (back-to-back) do not overlap",
    !timeRangesOverlap("16:00", "17:00", "17:00", "18:00"),
  );
  check(
    "Disjoint ranges do not overlap",
    !timeRangesOverlap("10:00", "11:00", "16:00", "17:00"),
  );

  check("A valid range (start < end) is accepted", isValidTimeRange("16:00", "18:00"));
  check("A zero-length range is rejected", !isValidTimeRange("16:00", "16:00"));
  check("An inverted range is rejected", !isValidTimeRange("18:00", "16:00"));

  const existing: ExistingScheduleSlot[] = [
    {
      classGroupId: "other-class",
      className: "Math · Grade 10",
      dayOfWeek: 1,
      startTime: "16:00",
      endTime: "18:00",
      teacherId: "teacher-1",
      roomId: "room-1",
    },
  ];

  const teacherConflict = findScheduleConflicts(
    { dayOfWeek: 1, startTime: "17:00", endTime: "19:00", teacherId: "teacher-1", roomId: "room-2" },
    existing,
  );
  check(
    "Same teacher, overlapping time, same day → teacher conflict",
    teacherConflict.length === 1 && teacherConflict[0].type === "teacher",
    JSON.stringify(teacherConflict),
  );

  const roomConflict = findScheduleConflicts(
    { dayOfWeek: 1, startTime: "17:00", endTime: "19:00", teacherId: "teacher-2", roomId: "room-1" },
    existing,
  );
  check(
    "Different teacher, same room, overlapping time → room conflict",
    roomConflict.length === 1 && roomConflict[0].type === "room",
    JSON.stringify(roomConflict),
  );

  const noConflictDifferentDay = findScheduleConflicts(
    { dayOfWeek: 2, startTime: "17:00", endTime: "19:00", teacherId: "teacher-1", roomId: "room-1" },
    existing,
  );
  check(
    "Same teacher/room but a different day → no conflict",
    noConflictDifferentDay.length === 0,
  );

  const windowStart = startOfUtcDay(new Date("2026-01-04T00:00:00Z")); // a Sunday
  const windowEnd = addDays(windowStart, 41); // 42-day window
  const mondays = generateOccurrenceDates({ dayOfWeek: 1 }, windowStart, windowEnd, new Set());
  check(
    "A 42-day window contains exactly 6 Mondays",
    mondays.length === 6,
    `got ${mondays.length}`,
  );

  const holidayKey = mondays[1].toISOString().slice(0, 10);
  const withHoliday = generateOccurrenceDates(
    { dayOfWeek: 1 },
    windowStart,
    windowEnd,
    new Set([holidayKey]),
  );
  check(
    "A holiday date is skipped by the generator",
    withHoliday.length === 5,
    `got ${withHoliday.length}`,
  );

  const sessionConflict = findSessionConflicts(
    {
      classGroupId: "class-b",
      teacherId: "teacher-1",
      roomId: "room-2",
      date: mondays[0],
      startTime: "17:00",
      endTime: "19:00",
    },
    [
      {
        classGroupId: "class-a",
        className: "Physics · Grade 11",
        teacherId: "teacher-1",
        roomId: "room-1",
        date: mondays[0],
        startTime: "16:00",
        endTime: "18:00",
      },
    ],
  );
  check(
    "Session-level conflict detection mirrors schedule-level detection",
    sessionConflict.length === 1 && sessionConflict[0].type === "teacher",
  );

  check(
    "The class schema rejects a percentage above 100",
    !classGroupSchema.safeParse({
      locale: "en",
      teacherId: "t",
      price: "120",
      centerShareType: "PERCENTAGE",
      shareValue: "150",
      capacity: "0",
      lateThresholdMinutes: "10",
    }).success,
  );
  check(
    "The class schema rejects a negative capacity",
    !classGroupSchema.safeParse({
      locale: "en",
      teacherId: "t",
      price: "120",
      centerShareType: "FIXED",
      shareValue: "15",
      capacity: "-1",
      lateThresholdMinutes: "10",
    }).success,
  );
  check(
    "The schedule schema rejects an end time before the start time",
    !classScheduleSchema.safeParse({
      locale: "en",
      classGroupId: "c",
      dayOfWeek: "1",
      startTime: "18:00",
      endTime: "16:00",
    }).success,
  );
  check(
    "The schedule schema rejects an out-of-range day",
    !classScheduleSchema.safeParse({
      locale: "en",
      classGroupId: "c",
      dayOfWeek: "7",
      startTime: "16:00",
      endTime: "18:00",
    }).success,
  );
}

// ── Database-backed fixtures ────────────────────────────────────────────────

async function makeTeacher(centerId: string, email: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: email, email, locale: "en" },
  });
  const membership = await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: TEACHER_ROLE,
      firstName: "T",
      lastName: email,
      email,
      joinedAt: new Date(),
    }),
  });
  return { user, membership };
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

/** The same select `db.classSchedules.listForConflictCheck` uses. */
async function conflictCheckSlots(
  centerId: string,
  excludeClassGroupId: string,
): Promise<ExistingScheduleSlot[]> {
  const rows = await prisma.classSchedule.findMany({
    where: scopedWhere(centerId, { classGroupId: { not: excludeClassGroupId } }),
    select: {
      classGroupId: true,
      dayOfWeek: true,
      startTime: true,
      endTime: true,
      classGroup: {
        select: {
          teacherId: true,
          roomId: true,
          subject: { select: { name: true } },
          grade: { select: { name: true } },
        },
      },
    },
  });
  return rows.map((row) => ({
    classGroupId: row.classGroupId,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    teacherId: row.classGroup.teacherId,
    roomId: row.classGroup.roomId,
    className:
      [row.classGroup.subject?.name, row.classGroup.grade?.name]
        .filter(Boolean)
        .join(" · ") || "—",
  }));
}

async function main() {
  await cleanup();
  checkPurePrimitives();

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({ data: { slug: SLUG_A, name: "Classes A" } });
  const centerB = await prisma.center.create({ data: { slug: SLUG_B, name: "Classes B" } });

  const teacherA = await makeTeacher(centerA.id, "classes-check-teacher-a@kayedu.test");
  const roomA1 = await prisma.room.create({ data: scopedData(centerA.id, { name: "Room 1" }) });
  const roomA2 = await prisma.room.create({ data: scopedData(centerA.id, { name: "Room 2" }) });
  const subjectA = await prisma.subject.create({ data: scopedData(centerA.id, { name: "Math" }) });
  const gradeA = await prisma.grade.create({ data: scopedData(centerA.id, { name: "Grade 10" }) });

  // ── 1. Two classes generate correct sessions across two weekly slots ─────
  const classGroupInput = parse(
    classGroupSchema,
    {
      locale: "en",
      teacherId: teacherA.user.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      roomId: roomA1.id,
      price: "120",
      centerShareType: "PERCENTAGE",
      shareValue: "15",
      capacity: "1",
      attendanceRequired: "on",
      lateThresholdMinutes: "10",
      acceptsNewStudents: "on",
      requiresConfirmation: "",
    },
    "classGroup",
  );
  const classA = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      teacherId: classGroupInput.teacherId,
      subjectId: classGroupInput.subjectId,
      gradeId: classGroupInput.gradeId,
      roomId: classGroupInput.roomId,
      price: classGroupInput.price,
      centerShareType: classGroupInput.centerShareType,
      centerShareValue: classGroupInput.centerShareValue,
      capacity: classGroupInput.capacity,
      lateThresholdMinutes: classGroupInput.lateThresholdMinutes,
      acceptsNewStudents: classGroupInput.acceptsNewStudents,
      requiresConfirmation: classGroupInput.requiresConfirmation,
    }),
  });

  const scheduleMon = parse(
    classScheduleSchema,
    { locale: "en", classGroupId: classA.id, dayOfWeek: "1", startTime: "16:00", endTime: "18:00" },
    "schedule-mon",
  );
  const scheduleWed = parse(
    classScheduleSchema,
    { locale: "en", classGroupId: classA.id, dayOfWeek: "3", startTime: "16:00", endTime: "18:00" },
    "schedule-wed",
  );
  await prisma.classSchedule.createMany({
    data: [
      scopedData(centerA.id, withoutLocale(scheduleMon)),
      scopedData(centerA.id, withoutLocale(scheduleWed)),
    ],
  });

  const firstRun = await generateSessions(prisma, centerA.id, "WARN", classA.id);
  check(
    "A class with two weekly slots generates 12 sessions over a 6-week window",
    firstRun.created === 12,
    `got ${firstRun.created}`,
  );

  const sessionRows = await prisma.session.findMany({
    where: scopedWhere(centerA.id, { classGroupId: classA.id }),
  });
  check(
    "Every generated session snapshots the class's price at generation time",
    sessionRows.every((row) => row.priceSnapshot === classA.price),
  );

  // ── 2. Idempotent regeneration ───────────────────────────────────────────
  const secondRun = await generateSessions(prisma, centerA.id, "WARN", classA.id);
  check(
    "Regenerating the same window a second time creates zero new sessions",
    secondRun.created === 0,
    `got ${secondRun.created}`,
  );

  // ── 3. Holiday calendar ───────────────────────────────────────────────────
  // `generateSessions` always windows from *today* — recompute the real
  // Monday occurrences for that same window, rather than reusing the earlier
  // pure-primitive fixture's arbitrary January window.
  const today = startOfUtcDay(new Date());
  const realWindowEnd = addDays(today, 41);
  const realMondays = generateOccurrenceDates(
    { dayOfWeek: 1 },
    today,
    realWindowEnd,
    new Set(),
  );
  const secondMonday = realMondays[1];

  await prisma.classSchedule.deleteMany({ where: scopedWhere(centerA.id, { classGroupId: classA.id }) });
  await prisma.session.deleteMany({ where: scopedWhere(centerA.id, { classGroupId: classA.id }) });
  await prisma.holiday.create({
    data: scopedData(centerA.id, { date: secondMonday, name: "Test holiday" }),
  });
  await prisma.classSchedule.create({ data: scopedData(centerA.id, withoutLocale(scheduleMon)) });
  const withHolidayRun = await generateSessions(prisma, centerA.id, "WARN", classA.id);
  check(
    "A date on the holiday calendar is skipped by the generator",
    withHolidayRun.created === realMondays.length - 1,
    `got ${withHolidayRun.created}, expected ${realMondays.length - 1} of ${realMondays.length} Mondays`,
  );
  await prisma.holiday.deleteMany({ where: scopedWhere(centerA.id) });
  await prisma.session.deleteMany({ where: scopedWhere(centerA.id, { classGroupId: classA.id }) });

  // ── 4. Schedule-save-time conflict detection ─────────────────────────────
  const classB = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      teacherId: teacherA.user.id, // same teacher as classA
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      roomId: roomA2.id, // different room
      price: 10_000,
    }),
  });
  const candidateOverlapSameTeacher = { dayOfWeek: 1, startTime: "17:00", endTime: "19:00" };
  const conflictsForB = findScheduleConflicts(
    { ...candidateOverlapSameTeacher, teacherId: teacherA.user.id, roomId: roomA2.id },
    await conflictCheckSlots(centerA.id, classB.id),
  );
  check(
    "A second class sharing the same teacher, overlapping time, is flagged as a teacher conflict",
    conflictsForB.some((c) => c.type === "teacher" && c.classGroupId === classA.id),
    JSON.stringify(conflictsForB),
  );

  const teacherC = await makeTeacher(centerA.id, "classes-check-teacher-c@kayedu.test");
  const classC = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      teacherId: teacherC.user.id, // different teacher
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      roomId: roomA1.id, // same room as classA
      price: 10_000,
    }),
  });
  const conflictsForC = findScheduleConflicts(
    { dayOfWeek: 1, startTime: "17:00", endTime: "19:00", teacherId: teacherC.user.id, roomId: roomA1.id },
    await conflictCheckSlots(centerA.id, classC.id),
  );
  check(
    "A third class, different teacher but the same room and an overlapping time, is a room conflict",
    conflictsForC.some((c) => c.type === "room" && c.classGroupId === classA.id),
    JSON.stringify(conflictsForC),
  );

  // ── 5. Generation-time conflicts + DENY policy ───────────────────────────
  // classA's own sessions must actually exist in the database for the
  // conflict check below to have something to collide with.
  const classARegen = await generateSessions(prisma, centerA.id, "WARN", classA.id);
  check(
    "classA's sessions regenerate cleanly with no conflicts of their own",
    classARegen.created === 6 && classARegen.conflicts.length === 0,
    JSON.stringify(classARegen),
  );

  await prisma.classSchedule.create({
    data: scopedData(centerA.id, {
      classGroupId: classB.id,
      dayOfWeek: 1,
      startTime: "17:00",
      endTime: "19:00",
    }),
  });
  const warnRun = await generateSessions(prisma, centerA.id, "WARN", classB.id);
  check(
    "Under WARN, a conflicting session is still created and reported",
    warnRun.created === 6 && warnRun.conflicts.length > 0,
    JSON.stringify(warnRun),
  );

  await prisma.session.deleteMany({ where: scopedWhere(centerA.id, { classGroupId: classB.id }) });
  const denyRun = await generateSessions(prisma, centerA.id, "DENY", classB.id);
  check(
    "Under DENY, the conflicting occurrence is skipped but still reported",
    denyRun.created === 0 && denyRun.conflicts.length > 0,
    JSON.stringify(denyRun),
  );

  // ── 6. Capacity + duplicate enrollment + StudentBlock (scope CLASS) ─────
  const student1 = await makeStudent(centerA.id, "9001");
  const student2 = await makeStudent(centerA.id, "9002");

  const enrollment1 = await prisma.enrollment.create({
    data: scopedData(centerA.id, {
      classGroupId: classA.id,
      studentProfileId: student1.profile.id,
      status: ACTIVE,
    }),
  });
  check("The first enrollment into a capacity-1 class succeeds", Boolean(enrollment1));

  const activeCount = await prisma.enrollment.count({
    where: scopedWhere(centerA.id, { classGroupId: classA.id, status: ACTIVE }),
  });
  check(
    "A class at capacity blocks a second enrollment (capacity check)",
    activeCount >= classA.capacity,
    `active=${activeCount} capacity=${classA.capacity}`,
  );

  const duplicate = await prisma.enrollment.findFirst({
    where: scopedWhere(centerA.id, {
      classGroupId: classA.id,
      studentProfileId: student1.profile.id,
      status: { in: EXISTING_STATUSES },
    }),
  });
  check("Duplicate enrollment for the same student/class is detected", Boolean(duplicate));

  const classBlock = await prisma.studentBlock.create({
    data: scopedData(centerA.id, {
      scope: CLASS_SCOPE,
      refId: classA.id,
      blockedUserId: student2.user.id,
      reason: "test",
    }),
  });
  const isBlocked = await prisma.studentBlock.count({
    where: scopedWhere(centerA.id, {
      scope: CLASS_SCOPE,
      refId: classA.id,
      blockedUserId: student2.user.id,
    }),
  });
  check(
    "A student blocked from a class (scope CLASS) is detected before enrolling",
    isBlocked > 0 && Boolean(classBlock),
  );
  const otherClassBlock = await prisma.studentBlock.count({
    where: scopedWhere(centerA.id, {
      scope: CLASS_SCOPE,
      refId: classB.id,
      blockedUserId: student2.user.id,
    }),
  });
  check(
    "The same block does not apply to a different class",
    otherClassBlock === 0,
  );

  // ── 7. Cross-center isolation ────────────────────────────────────────────
  check(
    "Center B cannot read Center A's ClassGroup by id",
    (await scopedFindById(prisma.classGroup, centerB.id, classA.id)) === null,
  );
  const scheduleRow = await prisma.classSchedule.findFirst({
    where: { classGroupId: classA.id },
  });
  check(
    "Center B cannot read Center A's ClassSchedule by id",
    scheduleRow !== null &&
      (await scopedFindById(prisma.classSchedule, centerB.id, scheduleRow.id)) === null,
  );
  check(
    "Center B cannot read Center A's Enrollment by id",
    (await scopedFindById(prisma.enrollment, centerB.id, enrollment1.id)) === null,
  );
  const classesInB = await prisma.classGroup.findMany({ where: scopedWhere(centerB.id) });
  check("A scoped class list for Center B contains none of Center A's classes", classesInB.length === 0);
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
      console.error(`\n${failures} classes check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll classes checks passed.");
  });
