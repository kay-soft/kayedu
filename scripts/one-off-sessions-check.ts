/**
 * One-off-sessions check — the R5 acceptance gate (docs/03-build-order.md
 * "R5" "Done when"): staff add an **extra session on a class** and a
 * **one-time session** that belongs to no class.
 *
 * Run with:  npm run check:one-off-sessions
 *
 * Exercises the real production modules by direct call — the writers in
 * `lib/db/class-sessions.ts` (`createManualSession`, `createOneOffSession`,
 * `deleteManualSession`, and the engine paths that must leave a manual
 * session alone), `lib/db/payments.ts` (a one-time session's own cut),
 * `lib/db/sessions.ts` (the invariant, the cut override), the label helper
 * `lib/session-label.ts`, and every history reader a one-time session must
 * render through — against two throwaway centres, with an injected clock in
 * the centre's timezone. Plus a static sweep that no reader dereferences a
 * session's class unguarded. Needs a reachable database; cleans up after
 * itself (fixture centres, users and catalog rows only — never a reset).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { scopedData, scopedFindById } from "../lib/db/tenant-scope.ts";
import { dateKey, dayMarker, zonedDateTimeToUtc } from "../lib/scheduling.ts";
import {
  createClassWithSessions,
  createManualSession,
  createOneOffSession,
  deactivateClass,
  deleteManualSession,
  removeSessionsOnHoliday,
  updateClassWithSessions,
  writeClassSlot,
  type ClassInput,
  type ClassSlot,
  type ManualSessionSlot,
} from "../lib/db/class-sessions.ts";
import {
  cancelSession,
  oneOffSessionShapeError,
  sessionDetailInclude,
  sessionListSelect,
  updateSessionShareOverride,
} from "../lib/db/sessions.ts";
import { linkRooms } from "../lib/db/room-sets.ts";
import { loadSessionOccupancy } from "../lib/db/slot-conflicts.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment, sessionReceiptTotals } from "../lib/db/payments.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { closeSession } from "../lib/db/session-lifecycle.ts";
import { studentPastAttendance, studentUpcomingSessions } from "../lib/db/student-portal.ts";
import { studentSessionsWithTeacher, teacherSessionListWhere } from "../lib/db/teacher-portal.ts";
import { discoverClassesForCenter } from "../lib/db/discover.ts";
import { reserveOrEnroll } from "../lib/db/reservations.ts";
import { resolveSessionRequest } from "../lib/db/approvals.ts";
import { sessionDisplayName, sessionKind, sessionLabelParts } from "../lib/session-label.ts";

const prisma = new PrismaClient();

const SLUG_A = "one-off-sessions-check-a";
const SLUG_B = "one-off-sessions-check-b";
const EMAIL_PREFIX = "one-off-sessions-check-";
const CATALOG_PREFIX = "one-off-sessions-check ";
const TZ = "Africa/Cairo";

/** "Now" for every DB check: Monday 12 Oct 2026, 12:00 in Cairo. */
const NOW = zonedDateTimeToUtc("2026-10-12", 12 * 60, TZ);
/** 00:30 in Cairo on 12 Oct — still 11 Oct in UTC. */
const NOW_EARLY = zonedDateTimeToUtc("2026-10-12", 30, TZ);
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedDateTimeToUtc("2026-10-12", h * 60 + m, TZ);
};
const day = (key: string) => dayMarker(key);

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
  const centers = await prisma.center.findMany({
    where: { slug: { in: [SLUG_A, SLUG_B] } },
    select: { id: true, organizationId: true },
  });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    // AuditLog.centerId has no cascade.
    await prisma.auditLog.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: CATALOG_PREFIX } } });
}

// ── Static assertions (no database) ─────────────────────────────────────────

function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const norm = (file: string) => file.replace(/\\/g, "/");

function staticChecks() {
  console.log("Static assertions (no database needed)");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const sessionModel = schema.slice(schema.indexOf("model Session {"), schema.indexOf("model SessionAttendee {"));
  check("Session.classGroupId is nullable (a one-time session has no class)", /\n\s*classGroupId\s+String\?/.test(sessionModel));
  check(
    "Session carries title, subjectId, gradeId and isManual (default false)",
    /\n\s*title\s+String\?/.test(sessionModel) &&
      /\n\s*subjectId\s+String\?/.test(sessionModel) &&
      /\n\s*gradeId\s+String\?/.test(sessionModel) &&
      /\n\s*isManual\s+Boolean\s+@default\(false\)/.test(sessionModel),
  );
  check(
    "@@unique([classGroupId, date, startTime]) stays (NULLs are distinct in Postgres)",
    sessionModel.includes("@@unique([classGroupId, date, startTime])"),
  );

  const readers = [...listFiles("app"), ...listFiles("lib"), ...listFiles("components")];
  // A session's class is nullable since R5: `session.classGroup.x` (no `?.`)
  // and `.classGroup._count` throw on a one-time session. The only file
  // allowed to read the class off a session is the label helper itself.
  const unguarded: string[] = [];
  for (const file of readers) {
    if (norm(file).endsWith("lib/session-label.ts")) continue;
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (/\bsession\.classGroup\.(?!\?)/.test(line) && !/session\.classGroup \?/.test(line)) {
        unguarded.push(`${norm(file)}:${index + 1}`);
      }
      // `row.classGroup._count` off a session row; a class's own `classGroup._count` is fine.
      if (/\.classGroup\._count\b/.test(line)) unguarded.push(`${norm(file)}:${index + 1}`);
    });
  }
  check("No reader dereferences a session's classGroup unguarded", unguarded.length === 0, unguarded.join(", "));

  const labelOwners = readers.filter((file) => /function sessionDisplayName\b/.test(readFileSync(file, "utf8")));
  check(
    "lib/session-label.ts is the single owner of sessionDisplayName",
    labelOwners.length === 1 && norm(labelOwners[0]).endsWith("lib/session-label.ts"),
    labelOwners.map(norm).join(", "),
  );
  const staleImports = readers.filter((file) =>
    /import\s*\{[^}]*\bsessionDisplayName\b[^}]*\}\s*from\s*"@\/lib\/db\/sessions"/.test(readFileSync(file, "utf8")),
  );
  check("Nobody imports sessionDisplayName from lib/db/sessions any more", staleImports.length === 0, staleImports.join(", "));

  const slotConflicts = readFileSync("lib/db/slot-conflicts.ts", "utf8");
  check(
    "OPEN_CLASS_SESSION keeps one-time sessions (classGroupId: null) on every forward reader",
    /OPEN_CLASS_SESSION = \{\s*OR: \[\{ classGroupId: null \}/.test(slotConflicts),
  );
  const lifecycle = readFileSync("lib/db/session-lifecycle.ts", "utf8");
  check(
    "The closure guard LEFT JOINs the class (a one-time session is never 'missing')",
    !/\n\s*JOIN "ClassGroup"/.test(lifecycle) && lifecycle.includes('LEFT JOIN "ClassGroup"'),
  );

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  check("package.json wires check:one-off-sessions", (pkg.scripts["check:one-off-sessions"] ?? "").includes("scripts/one-off-sessions-check.ts"));
  const ci = existsSync(".github/workflows/ci.yml") ? readFileSync(".github/workflows/ci.yml", "utf8") : "";
  check("CI runs check:one-off-sessions", ci.includes("check:one-off-sessions"));
}

// ── Pure rules ──────────────────────────────────────────────────────────────

function pureChecks() {
  console.log("\nThe one-time-session invariant (pure)");
  const whole = {
    classGroupId: null,
    title: "Revision day",
    teacherId: "t",
    priceSnapshot: 10_000,
    centerShareType: "FIXED" as const,
    centerShareValue: 2_000,
  };
  check("A one-time session with title, teacher, price and both cut fields is whole", oneOffSessionShapeError(whole) === null);
  check("…without a title → titleRequired", oneOffSessionShapeError({ ...whole, title: "  " }) === "titleRequired");
  check("…without a teacher → teacherRequired", oneOffSessionShapeError({ ...whole, teacherId: null }) === "teacherRequired");
  check("…without a price → priceRequired", oneOffSessionShapeError({ ...whole, priceSnapshot: null }) === "priceRequired");
  check("…with only a cut type → cutRequired", oneOffSessionShapeError({ ...whole, centerShareValue: null }) === "cutRequired");
  check("…with only a cut value → cutRequired", oneOffSessionShapeError({ ...whole, centerShareType: null }) === "cutRequired");
  check(
    "A class session needs none of them (the class supplies them)",
    oneOffSessionShapeError({ classGroupId: "c", title: null, teacherId: "t", priceSnapshot: 0, centerShareType: null, centerShareValue: null }) === null,
  );

  const subject = { nameAr: "فيزياء", nameEn: "Physics", selections: [{ displayNameAr: null, displayNameEn: null }] };
  check(
    "sessionDisplayName: one-time → title · subject; class → subject · grade; nothing → —",
    sessionDisplayName("en", { title: "Revision day", subject, classGroup: null }) === "Revision day · Physics" &&
      sessionDisplayName("en", { classGroup: { subject, grade: null } }) === "Physics" &&
      sessionDisplayName("en", { classGroup: null }) === "—",
  );
  check(
    "sessionKind: no class → oneOff; manual class session → extra; engine session → class",
    sessionKind({ classGroupId: null, isManual: true }) === "oneOff" &&
      sessionKind({ classGroupId: "c", isManual: true }) === "extra" &&
      sessionKind({ classGroupId: "c", isManual: false }) === "class",
  );
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function makeCenter(slug: string) {
  const center = await prisma.center.create({
    data: {
      slug,
      name: slug,
      organization: { create: { name: slug } },
      settings: {
        create: { timezone: TZ, scheduleConflictPolicy: "WARN", defaultLateThreshold: 10, defaultShareType: "PERCENTAGE", defaultShareValue: 20 },
      },
    },
  });
  await ensureDefaultPaymentMethods(prisma, center.id);
  return center;
}

async function makeUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "U", lastName: tag, email: `${EMAIL_PREFIX}${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeTeacher(centerId: string, tag: string) {
  const user = await makeUser(tag);
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: "T", lastName: tag, joinedAt: new Date() }),
  });
  return user;
}

let studentSeq = 0;
async function makeStudent(centerId: string, tag: string) {
  const user = await makeUser(tag);
  studentSeq += 1;
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: `OO-${studentSeq}`, firstName: "S", lastName: tag }),
  });
  return { user, profile };
}

async function makeRoom(centerId: string, name: string, capacity = 20) {
  return prisma.room.create({ data: scopedData(centerId, { name, capacity }) });
}

function classInput(teacherId: string, roomId: string, startDate: Date, endDate: Date): ClassInput {
  return {
    teacherId,
    subjectId: null,
    gradeId: null,
    educationSystemId: null,
    roomId,
    extraRoomIds: [],
    price: 12_000,
    centerShareType: "PERCENTAGE",
    centerShareValue: 15,
    lateThresholdMinutes: 10,
    acceptsNewStudents: true,
    requiresConfirmation: false,
    startDate,
    endDate,
  };
}

async function createClass(centerId: string, input: ClassInput, slots: ClassSlot[]) {
  const result = await createClassWithSessions(prisma, centerId, { ...input, slots }, { confirmConflicts: true, now: NOW });
  if (!result.ok) throw new Error(`fixture class refused: ${JSON.stringify(result)}`);
  return result.classGroupId;
}

function slot(teacherId: string, roomId: string, date: string, startTime: string, endTime: string, extraRoomIds: string[] = []): ManualSessionSlot {
  return { teacherId, roomId, extraRoomIds, date: day(date), startTime, endTime };
}

async function method(centerId: string) {
  const [first] = await listActivePaymentMethods(prisma, centerId);
  return first.id;
}

async function checkIn(centerId: string, sessionId: string, studentProfileId: string, now: Date, enrollmentId: string | null = null) {
  return createAttendance(
    prisma,
    { centerId, sessionId, studentProfileId, enrollmentId, isDropIn: enrollmentId === null, recordedBy: "check" },
    { now },
  );
}

async function pay(centerId: string, attendeeId: string, now: Date) {
  const methodId = await method(centerId);
  return prisma.$transaction((tx) => recordPayment(tx, centerId, attendeeId, methodId, "check", { now }));
}

const exists = async (id: string) => (await prisma.session.count({ where: { id } })) === 1;

// ── Database-backed checks ──────────────────────────────────────────────────

async function main() {
  staticChecks();
  pureChecks();

  await cleanup();
  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const A = centerA.id;
  const B = centerB.id;

  const t1 = await makeTeacher(A, "t1");
  const t2 = await makeTeacher(A, "t2");
  const t3 = await makeTeacher(A, "t3");
  const t4 = await makeTeacher(A, "t4");
  const t5 = await makeTeacher(A, "t5");
  const tB = await makeTeacher(B, "tb");
  const [r1, r2, r3, r4, r5, r6] = await Promise.all(["R1", "R2", "R3", "R4", "R5", "R6"].map((name) => makeRoom(A, name)));
  await linkRooms(prisma, A, r5.id, r6.id);
  const rB = await makeRoom(B, "RB");

  // Catalog: a subject + grade A has selected, one only B has, one A keeps inactive.
  const [subjectA, subjectB, subjectOff] = await Promise.all(
    ["physics", "chemistry", "biology"].map((tag) =>
      prisma.catalogSubject.create({ data: { nameAr: tag, nameEn: `${CATALOG_PREFIX}${tag}` } }),
    ),
  );
  const [gradeA, gradeB] = await Promise.all(
    ["g10", "g11"].map((tag) => prisma.catalogGrade.create({ data: { nameAr: tag, nameEn: `${CATALOG_PREFIX}${tag}` } })),
  );
  await prisma.centerCatalogSelection.createMany({
    data: [
      { centerId: A, kind: "SUBJECT", subjectId: subjectA.id, displayNameEn: "A's Physics" },
      { centerId: A, kind: "SUBJECT", subjectId: subjectOff.id, active: false },
      { centerId: A, kind: "GRADE", gradeId: gradeA.id },
      { centerId: B, kind: "SUBJECT", subjectId: subjectB.id },
      { centerId: B, kind: "GRADE", gradeId: gradeB.id },
    ],
  });

  const s1 = await makeStudent(A, "s1");
  const s2 = await makeStudent(A, "s2");
  const s3 = await makeStudent(A, "s3");
  const s4 = await makeStudent(A, "s4");

  const oneOff = (overrides: Partial<Parameters<typeof createOneOffSession>[2]> = {}) => ({
    ...slot(t5.id, r5.id, "2026-10-20", "10:00", "11:00"),
    title: "Exam revision day",
    subjectId: null,
    gradeId: null,
    price: 20_000,
    centerShareType: "FIXED" as const,
    centerShareValue: 5_000,
    ...overrides,
  });

  // ── 1. Both create modes ─────────────────────────────────────────────────
  console.log("\n1. Create — for a class, and one-time");
  const C1 = await createClass(A, classInput(t1.id, r1.id, day("2026-10-12"), day("2026-12-31")), [
    { dayOfWeek: 1, startTime: "16:00", endTime: "18:00" },
    { dayOfWeek: 3, startTime: "16:00", endTime: "18:00" },
  ]);
  const E1 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-10-15", "16:00", "18:00") }, { confirmConflicts: false, now: NOW, actorUserId: t1.id });
  const e1 = E1.ok ? await prisma.session.findUniqueOrThrow({ where: { id: E1.sessionId } }) : null;
  check(
    "For a class: an extra session — isManual, the class's price frozen, no cut of its own",
    e1 !== null && e1.isManual && e1.classGroupId === C1 && e1.priceSnapshot === 12_000 &&
      e1.centerShareType === null && e1.centerShareValue === null && e1.title === null,
    JSON.stringify(E1),
  );
  const E2 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t2.id, r2.id, "2026-10-22", "10:00", "11:00") }, { confirmConflicts: false, now: NOW });
  check(
    "For a class: the teacher may be a substitute",
    E2.ok && (await prisma.session.findUniqueOrThrow({ where: { id: E2.sessionId } })).teacherId === t2.id,
    JSON.stringify(E2),
  );
  check(
    "An extra session writes a session.create audit row with mode extra",
    E1.ok && (await prisma.auditLog.count({ where: { centerId: A, action: "session.create", entityId: E1.sessionId, after: { path: ["mode"], equals: "extra" } } })) === 1,
  );

  const O0 = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r5.id, "2026-10-20", "10:00", "11:00", [r6.id]), subjectId: subjectA.id, gradeId: gradeA.id }), { confirmConflicts: false, now: NOW, actorUserId: t5.id });
  const o0 = O0.ok
    ? await prisma.session.findUniqueOrThrow({ where: { id: O0.sessionId }, include: { extraRooms: true } })
    : null;
  check(
    "One-time: no class, its own title/subject/grade/price/cut, isManual, extra room copied",
    o0 !== null && o0.classGroupId === null && o0.title === "Exam revision day" && o0.subjectId === subjectA.id &&
      o0.gradeId === gradeA.id && o0.priceSnapshot === 20_000 && o0.centerShareType === "FIXED" &&
      o0.centerShareValue === 5_000 && o0.isManual && o0.extraRooms.length === 1 && o0.extraRooms[0].roomId === r6.id,
    JSON.stringify(O0),
  );
  check(
    "One-time: audited as session.create with mode oneOff",
    O0.ok && (await prisma.auditLog.count({ where: { centerId: A, action: "session.create", entityId: O0.sessionId, after: { path: ["mode"], equals: "oneOff" } } })) === 1,
  );
  check(
    "One-time: a title over 80 characters is refused",
    !(await createOneOffSession(prisma, A, oneOff({ title: "x".repeat(81) }), { confirmConflicts: false, now: NOW })).ok,
  );
  const holidayDate = "2026-11-02";
  await prisma.holiday.create({ data: scopedData(A, { date: day(holidayDate), name: "Holiday" }) });
  const onHoliday = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r5.id, holidayDate, "10:00", "11:00")), { confirmConflicts: false, now: NOW });
  check("A holiday does not block a one-time session (the result flags it)", onHoliday.ok && onHoliday.holiday === true, JSON.stringify(onHoliday));

  // The null-classGroup invariant over every one-time row written.
  const oneOffRows = await prisma.session.findMany({ where: { centerId: A, classGroupId: null } });
  check(
    "Every classGroupId-null session satisfies the invariant (title, teacher, price, both cut fields)",
    oneOffRows.length > 0 && oneOffRows.every((row) => oneOffSessionShapeError(row) === null),
  );

  // ── 2. Past dates: injectable now, centre timezone ───────────────────────
  console.log("\n2. No backdating");
  const pastWithNow = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r5.id, "2026-10-11", "10:00", "11:00")), { confirmConflicts: false, now: NOW });
  check("Yesterday (centre time) is refused as pastDate by direct call", !pastWithNow.ok && pastWithNow.error === "pastDate", JSON.stringify(pastWithNow));
  const pastExtra = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-10-08", "10:00", "11:00") }, { confirmConflicts: false, now: NOW });
  check("…for an extra session too", !pastExtra.ok && pastExtra.error === "pastDate", JSON.stringify(pastExtra));
  const earlierToday = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r5.id, "2026-10-12", "09:00", "10:00")), { confirmConflicts: false, now: NOW });
  check("A time earlier today is allowed", earlierToday.ok, JSON.stringify(earlierToday));
  const earlyToday = await createOneOffSession(prisma, A, oneOff(slot(t4.id, r4.id, "2026-10-12", "07:00", "08:00")), { confirmConflicts: false, now: NOW_EARLY });
  const earlyYesterday = await createOneOffSession(prisma, A, oneOff(slot(t4.id, r4.id, "2026-10-11", "23:00", "23:30")), { confirmConflicts: false, now: NOW_EARLY });
  check(
    "The date is the centre's: at 00:30 Cairo (still 11 Oct in UTC) 12 Oct is today and 11 Oct is past",
    earlyToday.ok && !earlyYesterday.ok && earlyYesterday.error === "pastDate",
    JSON.stringify({ earlyToday, earlyYesterday }),
  );

  // ── 3. Conflicts: R3's contract, WARN and DENY ───────────────────────────
  console.log("\n3. Conflict contract");
  const C3 = await createClass(A, classInput(t4.id, r3.id, day("2026-10-12"), day("2026-11-30")), [{ dayOfWeek: 5, startTime: "16:00", endTime: "18:00" }]);
  const before = await prisma.session.count({ where: { centerId: A, classGroupId: null } });
  const clashNoFlag = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r3.id, "2026-10-16", "16:30", "17:30")), { confirmConflicts: false, now: NOW });
  check(
    "WARN without confirmConflicts: refused with the conflict list, nothing written",
    !clashNoFlag.ok && clashNoFlag.error === "conflictsNeedConfirmation" && "conflicts" in clashNoFlag &&
      clashNoFlag.conflicts.some((c) => c.type === "room" && c.roomId === r3.id) &&
      (await prisma.session.count({ where: { centerId: A, classGroupId: null } })) === before,
    JSON.stringify(clashNoFlag),
  );
  const clashFlag = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r3.id, "2026-10-16", "16:30", "17:30"), title: "Clash X" }), { confirmConflicts: true, now: NOW, actorUserId: t5.id });
  check(
    "WARN with confirmConflicts: created, and the confirmation audited",
    clashFlag.ok && clashFlag.conflicts.length > 0 &&
      (await prisma.auditLog.count({ where: { centerId: A, action: "schedule.conflict.confirm", entityId: clashFlag.sessionId } })) === 1,
    JSON.stringify(clashFlag),
  );
  const second = await createOneOffSession(prisma, A, oneOff(slot(t3.id, r3.id, "2026-10-16", "17:00", "17:45")), { confirmConflicts: false, now: NOW });
  check(
    "Two one-time sessions see each other (no null === null blind spot)",
    !second.ok && "conflicts" in second && clashFlag.ok && second.conflicts.some((c) => c.sessionId === clashFlag.sessionId && c.className.startsWith("Clash X")),
    JSON.stringify(second),
  );
  const ownClass = await createManualSession(prisma, A, { classGroupId: C3, ...slot(t4.id, r4.id, "2026-10-23", "17:00", "19:00") }, { confirmConflicts: false, now: NOW });
  check(
    "An extra session is checked against its own class's sessions too (teacher clash)",
    !ownClass.ok && ownClass.error === "conflictsNeedConfirmation" && "conflicts" in ownClass && ownClass.conflicts.some((c) => c.type === "teacher"),
    JSON.stringify(ownClass),
  );
  await prisma.centerSettings.update({ where: { centerId: A }, data: { scheduleConflictPolicy: "DENY" } });
  const denied = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r3.id, "2026-10-23", "16:30", "17:30")), { confirmConflicts: true, now: NOW });
  const deniedExtra = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r3.id, "2026-10-23", "16:30", "17:30") }, { confirmConflicts: true, now: NOW });
  await prisma.centerSettings.update({ where: { centerId: A }, data: { scheduleConflictPolicy: "WARN" } });
  check(
    "DENY: refused whatever the flag, with the list — both modes",
    !denied.ok && denied.error === "conflict" && "conflicts" in denied && denied.conflicts.length > 0 &&
      !deniedExtra.ok && deniedExtra.error === "conflict",
    JSON.stringify({ denied, deniedExtra }),
  );
  const duplicate = await createManualSession(prisma, A, { classGroupId: C3, ...slot(t4.id, r3.id, "2026-10-30", "16:00", "18:00") }, { confirmConflicts: true, now: NOW });
  check("An extra session on a slot the class already holds is refused as duplicateSlot", !duplicate.ok && duplicate.error === "duplicateSlot", JSON.stringify(duplicate));

  // ── 4. Cross-centre ids refused ──────────────────────────────────────────
  console.log("\n4. Cross-centre ids");
  const CB = await createClass(B, classInput(tB.id, rB.id, day("2026-10-12"), day("2026-11-30")), []);
  const crossClass = await createManualSession(prisma, A, { classGroupId: CB, ...slot(t1.id, r1.id, "2026-10-21", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  const crossTeacher = await createOneOffSession(prisma, A, oneOff({ ...slot(tB.id, r5.id, "2026-10-21", "08:00", "09:00") }), { confirmConflicts: true, now: NOW });
  const crossRoom = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, rB.id, "2026-10-21", "08:00", "09:00") }), { confirmConflicts: true, now: NOW });
  const crossSubject = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r5.id, "2026-10-21", "08:00", "09:00"), subjectId: subjectB.id }), { confirmConflicts: true, now: NOW });
  const crossGrade = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r5.id, "2026-10-21", "08:00", "09:00"), gradeId: gradeB.id }), { confirmConflicts: true, now: NOW });
  const inactiveSubject = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r5.id, "2026-10-21", "08:00", "09:00"), subjectId: subjectOff.id }), { confirmConflicts: true, now: NOW });
  check("Another centre's class → classNotFound", !crossClass.ok && crossClass.error === "classNotFound", JSON.stringify(crossClass));
  check("Another centre's teacher → teacherNotFound", !crossTeacher.ok && crossTeacher.error === "teacherNotFound", JSON.stringify(crossTeacher));
  check("Another centre's room → roomNotFound", !crossRoom.ok && crossRoom.error === "roomNotFound", JSON.stringify(crossRoom));
  check("A subject only another centre selected → subjectNotFound", !crossSubject.ok && crossSubject.error === "subjectNotFound", JSON.stringify(crossSubject));
  check("A grade only another centre selected → gradeNotFound", !crossGrade.ok && crossGrade.error === "gradeNotFound", JSON.stringify(crossGrade));
  check("A subject this centre deactivated → subjectNotFound", !inactiveSubject.ok && inactiveSubject.error === "subjectNotFound", JSON.stringify(inactiveSubject));
  const classIn = await prisma.classGroup.update({ where: { id: C3 }, data: { active: false } });
  const inactiveClass = await createManualSession(prisma, A, { classGroupId: C3, ...slot(t4.id, r4.id, "2026-11-04", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  await prisma.classGroup.update({ where: { id: classIn.id }, data: { active: true } });
  check("An inactive class takes no extra session → classNotFound", !inactiveClass.ok && inactiveClass.error === "classNotFound", JSON.stringify(inactiveClass));

  // ── 5. Drop-in attendance, payment with the session's own cut, close ─────
  console.log("\n5. A one-time session's day: attendance, money, close, receipt");
  const O1 = await createOneOffSession(prisma, A, oneOff({ ...slot(t5.id, r5.id, "2026-10-12", "11:55", "13:00"), title: "Saturday clinic", subjectId: subjectA.id }), { confirmConflicts: true, now: NOW });
  if (!O1.ok) throw new Error(`fixture one-off refused: ${JSON.stringify(O1)}`);
  const o1 = O1.sessionId;
  const a1 = await checkIn(A, o1, s1.profile.id, at("12:00"));
  const a2 = await checkIn(A, o1, s2.profile.id, at("12:20"));
  await prisma.centerSettings.update({ where: { centerId: A }, data: { defaultLateThreshold: 30 } });
  const a3 = await checkIn(A, o1, s3.profile.id, at("12:20"));
  await prisma.centerSettings.update({ where: { centerId: A }, data: { defaultLateThreshold: 10 } });
  check(
    "Drop-in check-ins take the centre's default late threshold (no class): 5 min → Present, 25 min → Late, Present again at a 30-min default",
    a1.attendanceStatus === "PRESENT" && a2.attendanceStatus === "LATE" && a3.attendanceStatus === "PRESENT" &&
      [a1, a2, a3].every((row) => row.isDropIn && row.enrollmentId === null),
    JSON.stringify([a1.attendanceStatus, a2.attendanceStatus, a3.attendanceStatus]),
  );
  const p1 = await pay(A, a1.id, at("12:30"));
  check(
    "Payment freezes the session's own cut (FIXED 50 EGP of 200 EGP → 50 / 150)",
    p1.ok && p1.payment.amount === 20_000 && p1.payment.priceSnapshot === 20_000 &&
      p1.payment.centerShareSnapshot === 5_000 && p1.payment.teacherShareSnapshot === 15_000 && p1.payment.teacherId === t5.id,
    JSON.stringify(p1),
  );
  const changed = await updateSessionShareOverride(prisma, A, o1, { centerShareType: "PERCENTAGE", centerShareValue: 50 }, { now: at("12:35") });
  const p3 = await pay(A, a3.id, at("12:40"));
  const p1After = p1.ok ? await prisma.payment.findUniqueOrThrow({ where: { id: p1.payment.id } }) : null;
  check(
    "Changing the session's cut later never moves a recorded payment; the next one freezes the new cut",
    changed.ok && p1After !== null && p1After.centerShareSnapshot === 5_000 && p1After.teacherShareSnapshot === 15_000 &&
      p3.ok && p3.payment.centerShareSnapshot === 10_000 && p3.payment.teacherShareSnapshot === 10_000,
    JSON.stringify({ p1After, p3 }),
  );
  const cleared = await updateSessionShareOverride(prisma, A, o1, null, { now: at("12:45") });
  const o1Cut = await prisma.session.findUniqueOrThrow({ where: { id: o1 } });
  check(
    "A one-time session's cut cannot be cleared (cutRequired) — the invariant holds",
    !cleared.ok && cleared.error === "cutRequired" && o1Cut.centerShareType === "PERCENTAGE" && o1Cut.centerShareValue === 50,
    JSON.stringify(cleared),
  );

  // Missing cut: a row that somehow lost half its cut is refused, not guessed.
  const O2 = await createOneOffSession(prisma, A, oneOff(slot(t3.id, r4.id, "2026-10-12", "12:00", "13:00")), { confirmConflicts: true, now: NOW });
  if (!O2.ok) throw new Error(`fixture one-off refused: ${JSON.stringify(O2)}`);
  await prisma.session.update({ where: { id: O2.sessionId }, data: { centerShareValue: null } });
  const a4 = await checkIn(A, O2.sessionId, s4.profile.id, at("12:05"));
  const missing = await pay(A, a4.id, at("12:10"));
  check(
    "A payment on a one-time session with a missing cut is refused (missingCut), nothing written",
    !missing.ok && missing.error === "missingCut" && (await prisma.payment.count({ where: { sessionId: O2.sessionId } })) === 0,
    JSON.stringify(missing),
  );

  const closed = await closeSession(prisma, A, o1, { closedBy: t5.id, now: at("13:30") });
  const totals = await sessionReceiptTotals(prisma, A, o1);
  check(
    "Closes with no automatic absences (nobody is enrolled in a one-time session)",
    closed.ok && closed.absentCreated === 0,
    JSON.stringify(closed),
  );
  check(
    "Its receipt totals: 400 EGP collected, 150 centre / 250 teacher, 2 present + 1 late",
    totals.collected === 40_000 && totals.centerShare === 15_000 && totals.teacherShare === 25_000 &&
      totals.paidCount === 2 && totals.presentCount === 2 && totals.lateCount === 1 && totals.absentCount === 0,
    JSON.stringify(totals),
  );

  // An extra class session: enrolled students are its roster; auto-absent at close.
  const enrolled = await prisma.enrollment.create({
    data: scopedData(A, { classGroupId: C1, studentProfileId: s4.profile.id, enrolledAt: new Date("2026-10-01T00:00:00.000Z") }),
  });
  const E5 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r2.id, "2026-10-12", "10:00", "11:00") }, { confirmConflicts: true, now: NOW });
  const e5Closed = E5.ok ? await closeSession(prisma, A, E5.sessionId, { closedBy: t1.id, now: NOW }) : null;
  check(
    "An extra class session marks its enrolled no-shows Absent at close",
    e5Closed !== null && e5Closed.ok && e5Closed.absentCreated === 1 &&
      E5.ok && (await prisma.sessionAttendee.count({ where: { sessionId: E5.sessionId, enrollmentId: enrolled.id, attendanceStatus: "ABSENT" } })) === 1,
    JSON.stringify(e5Closed),
  );

  // ── 6. Receipts and history render a one-time session ────────────────────
  console.log("\n6. Receipts and history");
  const detail = await prisma.session.findFirstOrThrow({ where: { centerId: A, id: o1 }, include: sessionDetailInclude(A) });
  check(
    "Receipt/print/detail label: the title and the centre's subject name, kind oneOff",
    sessionDisplayName("en", detail) === "Saturday clinic · A's Physics" && sessionKind(detail) === "oneOff",
    sessionDisplayName("en", detail),
  );
  const listRow = await prisma.session.findFirstOrThrow({ where: { id: o1 }, select: sessionListSelect(A) });
  const extraRow = E1.ok ? await prisma.session.findFirstOrThrow({ where: { id: E1.sessionId }, select: sessionListSelect(A) }) : null;
  check(
    "Sessions list / reception / dashboard row: labelled by title; an extra session reads as extra",
    sessionDisplayName("en", listRow).startsWith("Saturday clinic") && extraRow !== null && sessionKind(extraRow) === "extra",
  );
  const teacherRows = await prisma.session.findMany({
    where: { centerId: A, ...teacherSessionListWhere({ teacherId: t5.id, from: day("2026-10-12"), to: day("2026-10-31") }) },
    select: sessionListSelect(A),
  });
  check("Teacher portal list includes it, labelled by title", teacherRows.some((row) => row.id === o1 && sessionDisplayName("en", row).startsWith("Saturday clinic")));
  const history = await studentPastAttendance(prisma, A, s1.profile.id, day("2026-10-13"));
  const historyRow = history.find((row) => row.sessionId === o1);
  check(
    "Student / parent attendance history renders it (title as the subject line)",
    historyRow !== undefined && sessionLabelParts("en", historyRow.session).subjectName === "Saturday clinic · A's Physics",
    JSON.stringify(historyRow && sessionLabelParts("en", historyRow.session)),
  );
  const withTeacher = await studentSessionsWithTeacher(prisma, A, t5.id, s1.profile.id);
  check("Teacher's student history renders it", withTeacher.some((row) => row.sessionId === o1 && sessionDisplayName("en", row.session).startsWith("Saturday clinic")));
  const occupancy = await loadSessionOccupancy(prisma, A, "en", day("2026-10-12"), day("2026-10-12"));
  check("Conflict lists name a one-time session by its title", occupancy.some((row) => row.sessionId === o1 && row.className.startsWith("Saturday clinic")));

  // ── 7. Discover and reservations never offer a one-time session ──────────
  console.log("\n7. Discover / reservations");
  const discovered = await discoverClassesForCenter(prisma, A);
  const sessionIds = new Set((await prisma.session.findMany({ where: { centerId: A }, select: { id: true } })).map((row) => row.id));
  check("Discover lists classes only — never a session", discovered.length > 0 && discovered.every((row) => !sessionIds.has(row.id)));
  const reserved = await prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId: A, classGroupId: o1, studentUserId: s2.user.id }));
  check("A reservation against a one-time session's id resolves as notFound", !reserved.ok && reserved.error === "notFound", JSON.stringify(reserved));
  const upcoming = await studentUpcomingSessions(prisma, A, s1.profile.id, day("2026-10-12"));
  check("A student's upcoming sessions (from enrolments) never include a one-time session", upcoming.every((row) => row.classGroupId !== null));

  // ── 8. isManual survives the engine — each operation individually ────────
  console.log("\n8. Extra sessions survive the engine");
  const E3 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-12-10", "16:00", "18:00") }, { confirmConflicts: true, now: NOW });
  const E4 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-10-28", "10:00", "11:00") }, { confirmConflicts: true, now: NOW });
  if (!E1.ok || !E3.ok || !E4.ok) throw new Error("fixture extra sessions refused");
  const snapshot = async (id: string) => prisma.session.findUniqueOrThrow({ where: { id }, include: { extraRooms: true } });
  const e1Before = await snapshot(E1.sessionId);

  // (a) class edit: a new teacher.
  const edit = await updateClassWithSessions(prisma, A, C1, classInput(t3.id, r1.id, day("2026-10-12"), day("2026-12-31")), { confirmConflicts: true, now: NOW });
  const e1AfterEdit = await snapshot(E1.sessionId);
  const pristineMoved = await prisma.session.count({ where: { classGroupId: C1, isManual: false, teacherId: t3.id } });
  check(
    "(a) Class edit (new teacher): pristine sessions follow, the extra session keeps its teacher and stays",
    edit.ok && pristineMoved > 0 && e1AfterEdit.teacherId === t1.id && e1AfterEdit.roomId === e1Before.roomId &&
      dateKey(e1AfterEdit.date) === "2026-10-15",
    JSON.stringify(edit.ok ? edit.report && { ...edit.report, kept: edit.report.kept.length } : edit),
  );
  check(
    "…and is not reported as a 'kept' session needing attention",
    edit.ok && !(edit.report?.kept ?? []).some((kept) => [E1.sessionId, E3.sessionId, E4.sessionId].includes(kept.sessionId)),
  );

  // (b) slot move: Monday → Tuesday.
  const monday = await prisma.classSchedule.findFirstOrThrow({ where: { classGroupId: C1, dayOfWeek: 1 } });
  const moved = await writeClassSlot(prisma, A, { kind: "update", scheduleId: monday.id, classGroupId: C1, slot: { dayOfWeek: 2, startTime: "16:00", endTime: "18:00" } }, { confirmConflicts: true, now: NOW });
  check("(b) Slot move: the extra session survives", moved.ok && (await exists(E1.sessionId)) && (await exists(E3.sessionId)), JSON.stringify(moved.ok ? null : moved));

  // (c) end date shortened to before the extra session.
  const shrink = await updateClassWithSessions(prisma, A, C1, classInput(t3.id, r1.id, day("2026-10-12"), day("2026-11-30")), { confirmConflicts: true, now: NOW });
  check(
    "(c) End date shortened past it: the extra session on 10 Dec survives (pristine class sessions after it go)",
    shrink.ok && (shrink.report?.deleted ?? 0) > 0 && (await exists(E3.sessionId)) &&
      (await prisma.session.count({ where: { classGroupId: C1, isManual: false, date: { gt: day("2026-11-30") } } })) === 0,
    JSON.stringify(shrink.ok ? shrink.report && { ...shrink.report, kept: shrink.report.kept.length } : shrink),
  );

  // (d) a holiday added on its date.
  const wedPristine = await prisma.session.findFirst({ where: { classGroupId: C1, isManual: false, date: day("2026-10-28") } });
  const pruned = await prisma.$transaction(async (tx) => {
    await tx.holiday.create({ data: scopedData(A, { date: day("2026-10-28") }) });
    return removeSessionsOnHoliday(tx, A, day("2026-10-28"), NOW);
  });
  check(
    "(d) Holiday added later: the class's pristine session that day goes, the extra session stays (counted as kept)",
    wedPristine !== null && !(await exists(wedPristine.id)) && (await exists(E4.sessionId)) && pruned.kept >= 1,
    JSON.stringify(pruned),
  );
  check(
    "Approving a teacher's NEW_SESSION request creates an isManual session",
    await (async () => {
      const request = await prisma.changeRequest.create({
        data: scopedData(A, { type: "NEW_SESSION", requestedBy: t3.id, payload: { classGroupId: C1, date: "2026-11-05", startTime: "08:00", endTime: "09:00" } }),
      });
      const result = await resolveSessionRequest(prisma, A, request.id, "APPROVED", t3.id, "WARN", "en", { confirmConflicts: true });
      return result.ok && result.session !== null && result.session.isManual;
    })(),
  );

  // ── 9. Deactivate: a manual session follows the normal rule ──────────────
  console.log("\n9. Deactivate");
  const C2 = await createClass(A, classInput(t2.id, r2.id, day("2026-10-12"), day("2026-11-30")), [{ dayOfWeek: 4, startTime: "08:00", endTime: "09:00" }]);
  const M1 = await createManualSession(prisma, A, { classGroupId: C2, ...slot(t2.id, r2.id, "2026-10-19", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  const M2 = await createManualSession(prisma, A, { classGroupId: C2, ...slot(t2.id, r2.id, "2026-10-20", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  const M3 = await createManualSession(prisma, A, { classGroupId: C2, ...slot(t4.id, r2.id, "2026-10-21", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  if (!M1.ok || !M2.ok || !M3.ok) throw new Error("fixture manual sessions refused");
  await createAttendance(prisma, { centerId: A, sessionId: M2.sessionId, studentProfileId: s1.profile.id, enrollmentId: null, isDropIn: true, recordedBy: "check" }, { historicalBackfill: true, status: "PRESENT" });
  const deactivated = await deactivateClass(prisma, A, C2, { now: NOW });
  const m2 = await prisma.session.findUnique({ where: { id: M2.sessionId } });
  const m3 = await prisma.session.findUnique({ where: { id: M3.sessionId } });
  check(
    "Deactivating: an otherwise-pristine manual session is deleted, one with records or a substitute is cancelled",
    deactivated.ok && !(await exists(M1.sessionId)) && m2?.status === "CANCELLED" && m3?.status === "CANCELLED",
    JSON.stringify({ deactivated, m2: m2?.status, m3: m3?.status }),
  );

  // ── 10. Delete: pristine, future, manual only ────────────────────────────
  console.log("\n10. Delete");
  const D1 = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r5.id, "2026-11-10", "10:00", "11:00")), { confirmConflicts: true, now: NOW });
  if (!D1.ok) throw new Error("fixture one-off refused");
  const crossDelete = await deleteManualSession(prisma, B, D1.sessionId, { now: NOW });
  check("Centre B cannot delete Centre A's one-time session (notFound)", !crossDelete.ok && crossDelete.error === "notFound" && (await exists(D1.sessionId)));
  const deleted = await deleteManualSession(prisma, A, D1.sessionId, { now: NOW, actorUserId: t5.id });
  check(
    "A pristine future one-time session is deleted, audited as session.delete",
    deleted.ok && !(await exists(D1.sessionId)) &&
      (await prisma.auditLog.count({ where: { centerId: A, action: "session.delete", entityId: D1.sessionId } })) === 1,
    JSON.stringify(deleted),
  );
  const engineSession = await prisma.session.findFirstOrThrow({ where: { classGroupId: C1, isManual: false, date: { gt: day("2026-10-12") } } });
  const refuse = async (id: string, now: Date = NOW) => deleteManualSession(prisma, A, id, { now });
  const notManual = await refuse(engineSession.id);
  check("An engine-made class session is refused (notManual)", !notManual.ok && notManual.error === "sessionInUse" && notManual.blockers.includes("notManual"));
  const withAttendee = await refuse(M2.sessionId);
  check("A session with an attendee is refused", !withAttendee.ok && withAttendee.error === "sessionInUse" && withAttendee.blockers.includes("attendees"));
  const closedOne = await refuse(o1);
  check(
    "A closed session is never deletable",
    !closedOne.ok && closedOne.error === "sessionInUse" && closedOne.blockers.includes("closed") && (await exists(o1)),
  );
  if (!earlierToday.ok) throw new Error("fixture earlier-today refused");
  const started = await refuse(earlierToday.sessionId);
  check("A session that has already started is refused", !started.ok && started.error === "sessionInUse" && started.blockers.includes("started"));
  const D2 = await createOneOffSession(prisma, A, oneOff(slot(t5.id, r5.id, "2026-11-11", "10:00", "11:00")), { confirmConflicts: true, now: NOW });
  if (!D2.ok) throw new Error("fixture one-off refused");
  await cancelSession(prisma, A, D2.sessionId, { now: NOW });
  const cancelledOne = await refuse(D2.sessionId);
  check("A cancelled session is refused (notScheduled)", !cancelledOne.ok && cancelledOne.error === "sessionInUse" && cancelledOne.blockers.includes("notScheduled"));
  const D3 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-11-12", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  if (!D3.ok) throw new Error("fixture extra refused");
  await updateSessionShareOverride(prisma, A, D3.sessionId, { centerShareType: "FIXED", centerShareValue: 1_000 }, { now: NOW });
  const overridden = await refuse(D3.sessionId);
  check("An extra session with a cut override is refused (shareOverride)", !overridden.ok && overridden.error === "sessionInUse" && overridden.blockers.includes("shareOverride"));
  const E6 = await createManualSession(prisma, A, { classGroupId: C1, ...slot(t1.id, r1.id, "2026-11-13", "08:00", "09:00") }, { confirmConflicts: true, now: NOW });
  const extraDeleted = E6.ok ? await refuse(E6.sessionId) : null;
  check("A pristine future extra session is deleted", extraDeleted !== null && extraDeleted.ok && E6.ok && !(await exists(E6.sessionId)));

  // ── 11. Cross-centre isolation ───────────────────────────────────────────
  console.log("\n11. Cross-centre isolation");
  check("Centre B cannot read Centre A's one-time session by id", (await scopedFindById(prisma.session, B, o1)) === null);
  const crossPay = await prisma.$transaction(async (tx) => {
    const [bMethod] = await listActivePaymentMethods(tx, B);
    return recordPayment(tx, B, a2.id, bMethod.id, "check", { now: at("12:50") });
  });
  check("Centre B cannot record a payment on Centre A's one-time attendee", !crossPay.ok && crossPay.error === "notFound", JSON.stringify(crossPay));
  const crossCut = await updateSessionShareOverride(prisma, B, O2.sessionId, { centerShareType: "FIXED", centerShareValue: 1 }, { now: NOW });
  check("Centre B cannot change Centre A's one-time session's cut", !crossCut.ok && crossCut.error === "notFound");
  const bOccupancy = await loadSessionOccupancy(prisma, B, "en", day("2026-10-12"), day("2026-12-31"));
  check("Centre B's conflict universe holds none of Centre A's sessions", bOccupancy.every((row) => !sessionIds.has(row.sessionId ?? "")));

  await cleanup();
  console.log(failures === 0 ? "\nAll one-off-sessions checks passed." : `\n${failures} one-off-sessions check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await cleanup().catch(() => undefined);
  })
  .finally(() => prisma.$disconnect());
