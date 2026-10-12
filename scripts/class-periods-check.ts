/**
 * Class-periods check — the R4 acceptance gate (docs/03-build-order.md "R4"
 * "Done when"): class date ranges and centre term presets replace the
 * rolling-window session generator.
 *
 * Run with:  npm run check:class-periods
 *
 * Exercises the real production modules — `lib/db/class-sessions.ts` (the
 * one engine: materialize, resync, deactivate, reactivate, delete, the
 * holiday prune, the kept-sessions read), `lib/db/terms.ts`, the zod
 * schemas, and the forward-looking readers a deactivated class must vanish
 * from (`lib/db/slot-conflicts.ts`, `lib/db/student-portal.ts`,
 * `lib/db/teacher-portal.ts`, `lib/db/discover.ts`, `lib/db/reservations.ts`,
 * `lib/db/approvals.ts`) — against two throwaway centres, **by direct call**,
 * with an injected clock in the centre's timezone. Plus static assertions
 * that no cron route, `CRON_SECRET`, Vercel cron entry or rolling-window
 * export remains and that every slot-writing data-layer function requires
 * `confirmConflicts`. Needs a reachable database; cleans up after itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  addDays,
  classPeriodError,
  dateKey,
  dayMarker,
  zonedDateTimeToUtc,
} from "../lib/scheduling.ts";
import { classGroupSchema } from "../lib/validation/classes.ts";
import { termSchema } from "../lib/validation/settings.ts";
import {
  classDeleteBlockers,
  createClassWithSessions,
  deactivateClass,
  deleteClass,
  inClassTransaction,
  keptClassSessions,
  materializeClassSessions,
  reactivateClass,
  removeSessionsOnHoliday,
  sessionDisqualifiers,
  updateClassWithSessions,
  writeClassSlot,
  type ClassInput,
  type ClassSlot,
} from "../lib/db/class-sessions.ts";
import { createTerm, deleteTerm, listCenterTerms, setTermActive, updateTerm } from "../lib/db/terms.ts";
import {
  cancelSession,
  rescheduleSession,
  updateSessionRooms,
  updateSessionShareOverride,
} from "../lib/db/sessions.ts";
import { linkRooms } from "../lib/db/room-sets.ts";
import { loadSessionOccupancy } from "../lib/db/slot-conflicts.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { closeSessionIfDayOver } from "../lib/db/session-lifecycle.ts";
import { studentPastAttendance, studentUpcomingSessions } from "../lib/db/student-portal.ts";
import { teacherCenterSummary, teacherSessionListWhere } from "../lib/db/teacher-portal.ts";
import { discoverClassesForCenter } from "../lib/db/discover.ts";
import { confirmReservation, reserveOrEnroll } from "../lib/db/reservations.ts";
import { resolveSessionRequest } from "../lib/db/approvals.ts";
import { revenueTotals } from "../lib/db/analytics.ts";

const prisma = new PrismaClient();

const SLUG_A = "class-periods-check-a";
const SLUG_B = "class-periods-check-b";
const EMAIL_PREFIX = "class-periods-check-";
const TZ = "Africa/Cairo";
const THIS_FILE = "scripts/class-periods-check.ts";

/** "Now" for every DB check: Monday 12 Oct 2026, 12:00 in Cairo. */
const NOW = zonedDateTimeToUtc("2026-10-12", 12 * 60, TZ);
const TODAY = dayMarker("2026-10-12");
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
    await prisma.organization.deleteMany({
      where: { id: { in: centers.map((c) => c.organizationId) } },
    });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

// ── Static assertions (no database) ─────────────────────────────────────────

function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx|js|mjs|json|yml|yaml|sql|example)$/.test(entry)) out.push(path);
  }
  return out;
}

/** The parameter list of `function name(` in `source`, parens balanced. */
function signature(source: string, name: string): string | null {
  const match = new RegExp(`function\\s+${name}\\s*(<[^>]*>)?\\(`).exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
  }
  return source.slice(match.index + match[0].length, i - 1);
}

function staticChecks() {
  console.log("Static assertions");

  const codeFiles = [
    ...["app", "lib", "components", "scripts", "prisma", "supabase", ".github"].flatMap((dir) => listFiles(dir)),
    "package.json",
    "proxy.ts",
    ".env.example",
  ]
    .filter((file) => existsSync(file))
    .filter((file) => file.replaceAll("\\", "/") !== THIS_FILE && !file.includes("migrations"));

  check("No cron route remains (app/api/cron)", !existsSync("app/api/cron"));
  const cronSecret = codeFiles.filter((file) => readFileSync(file, "utf8").includes("CRON_SECRET"));
  check("No code or config references CRON_SECRET", cronSecret.length === 0, cronSecret.join(", "));
  const vercelCron = ["vercel.json", "vercel.ts"].filter(
    (file) => existsSync(file) && /crons/.test(readFileSync(file, "utf8")),
  );
  check("No vercel.json / vercel.ts cron entry exists", vercelCron.length === 0, vercelCron.join(", "));

  const rolling = codeFiles.filter((file) =>
    /\bgenerateSessions\b|\bGENERATION_WINDOW_DAYS\b|\bgenerateSessionsAction\b/.test(readFileSync(file, "utf8")),
  );
  check(
    "No rolling-window generator export or caller remains (generateSessions, GENERATION_WINDOW_DAYS)",
    rolling.length === 0,
    rolling.join(", "),
  );
  check(
    "lib/db/class-sessions.ts is the one module that creates a class's sessions (no other createMany of Session in lib/db)",
    listFiles("lib/db")
      .filter((file) => !file.endsWith("class-sessions.ts"))
      .every((file) => !/session\.createMany\(/.test(readFileSync(file, "utf8"))),
  );

  // confirmConflicts is required on every slot-writing data-layer function.
  const libDb = listFiles("lib/db").map((file) => [file, readFileSync(file, "utf8")] as const);
  check(
    "No data-layer type declares confirmConflicts optional",
    libDb.every(([, text]) => !/confirmConflicts\?\s*:/.test(text)),
  );
  check(
    "No data-layer function defaults a missing confirmConflicts (no `confirmConflicts ??`)",
    libDb.every(([, text]) => !/confirmConflicts\s*\?\?/.test(text)),
  );
  const writers: [string, string][] = [
    ["lib/db/sessions.ts", "rescheduleSession"],
    ["lib/db/sessions.ts", "updateSessionRooms"],
    ["lib/db/approvals.ts", "resolveSessionRequest"],
    ["lib/db/class-sessions.ts", "createClassWithSessions"],
    ["lib/db/class-sessions.ts", "updateClassWithSessions"],
    ["lib/db/class-sessions.ts", "writeClassSlot"],
    ["lib/db/class-sessions.ts", "reactivateClass"],
    ["lib/db/class-sessions.ts", "materializeClassSessions"],
    ["lib/db/class-sessions.ts", "resyncClassSessions"],
  ];
  const sessionsSource = readFileSync("lib/db/sessions.ts", "utf8");
  const engineSource = readFileSync("lib/db/class-sessions.ts", "utf8");
  check(
    "ConflictConfirmation and ClassSessionsOptions both declare `confirmConflicts: boolean` (required)",
    /export type ConflictConfirmation = \{\s*confirmConflicts: boolean;/.test(sessionsSource) &&
      /export type ClassSessionsOptions = \{\s*confirmConflicts: boolean;/.test(engineSource),
  );
  const loose = writers.filter(([file, name]) => {
    const params = signature(readFileSync(file, "utf8"), name);
    if (params === null) return true;
    const requires = /ConflictConfirmation|ClassSessionsOptions|confirmConflicts: boolean/.test(params);
    const lastParam = params.trim().replace(/,$/, "").split("\n").at(-1) ?? "";
    return !requires || /=\s*\{\s*\}\s*$/.test(lastParam.trim());
  });
  check(
    `Every slot-writing data-layer function requires confirmConflicts (${writers.length} functions)`,
    loose.length === 0,
    loose.map(([file, name]) => `${file} → ${name}`).join("; "),
  );

  // Terms are a tenant table like any other; classes copy dates, never link.
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const classGroupModel = schema.slice(
    schema.indexOf("model ClassGroup {"),
    schema.indexOf("}", schema.indexOf("model ClassGroup {")),
  );
  check(
    "ClassGroup has startDate/endDate and NO term reference (dates are copied, not linked)",
    /^\s*startDate\s+DateTime\s*$/m.test(classGroupModel) &&
      /^\s*endDate\s+DateTime\s*$/m.test(classGroupModel) &&
      !/term/i.test(classGroupModel.replace(/\/\/.*$/gm, "")),
  );
  check("CenterTerm is exposed through lib/db/scoped.ts", /terms:\s*\{/.test(readFileSync("lib/db/scoped.ts", "utf8")));
  check(
    "CenterTerm is in the RLS backstop list (supabase/m10-rls-and-storage.sql)",
    /'CenterTerm'/.test(readFileSync("supabase/m10-rls-and-storage.sql", "utf8")),
  );
  const settingsActions = readFileSync("app/[locale]/(center)/settings/actions.ts", "utf8");
  check(
    "Every term change is audited (create/update/activate/deactivate/delete)",
    ["term.create", "term.update", "term.activate", "term.deactivate", "term.delete"].every((action) =>
      settingsActions.includes(`"${action}"`),
    ),
  );

  // Forward-looking readers that live behind `@/` imports (not runnable
  // here) — asserted on their source.
  const scopedSource = readFileSync("lib/db/scoped.ts", "utf8");
  const listForDay = scopedSource.slice(scopedSource.indexOf("listForDay:"), scopedSource.indexOf("updateDescription:"));
  check("Today's lists (listForDay) exclude a deactivated class's open sessions", listForDay.includes("OPEN_CLASS_SESSION"));
  const pending = scopedSource.slice(scopedSource.indexOf("listPending:"), scopedSource.indexOf("findById: (id: string) => scopedFindById(prisma.reservation"));
  check(
    "Both approvals queues (listPending, listPendingForTeacher) list active classes only",
    (pending.match(/active: true/g) ?? []).length >= 2,
  );
  const classActions = readFileSync("app/[locale]/(center)/classes/actions.ts", "utf8");
  check(
    "Staff enrolment refuses a deactivated class (classInactive)",
    /if \(!classGroup\.active\) return \{ error: "classInactive" \}/.test(classActions),
  );
  check(
    "package.json and CI run check:class-periods",
    readFileSync("package.json", "utf8").includes('"check:class-periods"') &&
      readFileSync(".github/workflows/ci.yml", "utf8").includes("npm run check:class-periods"),
  );
}

// ── Pure rules ──────────────────────────────────────────────────────────────

function pureChecks() {
  console.log("\nPure period and pristine rules");
  const d = day("2026-10-09");
  check("A one-day period (end = start) is valid", classPeriodError(d, d) === null);
  check("A period of exactly 400 days is valid", classPeriodError(d, addDays(d, 400)) === null);
  check("401 days is refused as periodTooLong", classPeriodError(d, addDays(d, 401)) === "periodTooLong");
  check("An end before the start is refused as endBeforeStart", classPeriodError(d, addDays(d, -1)) === "endBeforeStart");

  const base = {
    locale: "en",
    teacherId: "t",
    price: "120",
    centerShareType: "PERCENTAGE",
    shareValue: "15",
    roomId: "r",
    lateThresholdMinutes: "10",
  };
  const ok = classGroupSchema.safeParse({ ...base, startDate: "2026-10-09", endDate: "2027-04-01" });
  check(
    "The class schema parses a period into UTC-midnight day markers",
    ok.success && dateKey(ok.data.startDate) === "2026-10-09" && ok.data.endDate.getUTCHours() === 0,
  );
  const issue = (input: Record<string, string>) => {
    const result = classGroupSchema.safeParse(input);
    return result.success ? null : result.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join(",");
  };
  check("The class schema requires startDate and endDate", issue(base)?.includes("startDate:required") === true && issue(base)?.includes("endDate:required") === true, String(issue(base)));
  check(
    "The class schema refuses an end before the start (on endDate)",
    issue({ ...base, startDate: "2026-10-09", endDate: "2026-10-08" }) === "endDate:endBeforeStart",
  );
  check(
    "The class schema refuses a span over 400 days (on endDate)",
    issue({ ...base, startDate: "2026-10-09", endDate: "2027-11-14" }) === "endDate:periodTooLong",
  );
  check("The class schema refuses an impossible date", issue({ ...base, startDate: "2026-02-30", endDate: "2026-10-08" })?.includes("startDate:invalidDate") === true);
  check(
    "The term schema applies the same period rule",
    !termSchema.safeParse({ locale: "en", name: "T", startDate: "2026-10-09", endDate: "2026-10-01" }).success &&
      termSchema.safeParse({ locale: "en", name: "T", startDate: "2026-10-09", endDate: "2026-10-09" }).success,
  );

  // Each disqualifier, individually, on an otherwise pristine session.
  const pristine = {
    status: "SCHEDULED" as const,
    closedAt: null as Date | null,
    teacherId: "t1",
    centerShareType: null as "FIXED" | "PERCENTAGE" | null,
    centerShareValue: null as number | null,
    description: null as string | null,
    rescheduledToId: null as string | null,
    rescheduledFrom: null as { id: string } | null,
    _count: { attendees: 0, payments: 0, settlements: 0, ratings: 0 },
  };
  const baseline = { teacherId: "t1", roomIds: ["r1", "r2"] };
  const only = (patch: Partial<typeof pristine>, rooms = ["r1", "r2"]) =>
    sessionDisqualifiers({ ...pristine, ...patch }, rooms, baseline).join(",");
  check("A session matching the class, with nothing on it, is pristine", only({}) === "");
  check("CANCELLED → notScheduled", only({ status: "CANCELLED" as never }) === "notScheduled");
  check("closedAt → closed", only({ closedAt: new Date() }) === "closed");
  check("an attendee → attendees", only({ _count: { ...pristine._count, attendees: 1 } }) === "attendees");
  check("a payment → payments", only({ _count: { ...pristine._count, payments: 1 } }) === "payments");
  check("a settlement → settlement", only({ _count: { ...pristine._count, settlements: 1 } }) === "settlement");
  check("a rating → ratings", only({ _count: { ...pristine._count, ratings: 1 } }) === "ratings");
  check("a per-session share override → shareOverride", only({ centerShareType: "FIXED", centerShareValue: 500 }) === "shareOverride");
  check("a description → description", only({ description: "Bring the past paper" }) === "description");
  check("rescheduled to → rescheduled", only({ rescheduledToId: "x" }) === "rescheduled");
  check("rescheduled from → rescheduled", only({ rescheduledFrom: { id: "x" } }) === "rescheduled");
  check("another teacher → teacherChanged", only({ teacherId: "t2" }) === "teacherChanged");
  check("another room set → roomsChanged", only({}, ["r1"]) === "roomsChanged");
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function makeCenter(slug: string) {
  const center = await prisma.center.create({
    data: {
      slug,
      name: slug,
      organization: { create: { name: slug } },
      settings: { create: { timezone: TZ, scheduleConflictPolicy: "WARN" } },
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
    data: scopedData(centerId, { userId: user.id, studentCode: `CP-${studentSeq}`, firstName: "S", lastName: tag }),
  });
  return { user, profile };
}

async function makeRoom(centerId: string, name: string, capacity = 20) {
  return prisma.room.create({ data: scopedData(centerId, { name, capacity }) });
}

function classInput(teacherId: string, roomId: string, startDate: Date, endDate: Date, extraRoomIds: string[] = []): ClassInput {
  return {
    teacherId,
    subjectId: null,
    gradeId: null,
    educationSystemId: null,
    roomId,
    extraRoomIds,
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

async function createClass(
  centerId: string,
  input: ClassInput,
  slots: ClassSlot[],
  confirmConflicts = false,
  actorUserId?: string,
) {
  const result = await createClassWithSessions(prisma, centerId, { ...input, slots }, { confirmConflicts, actorUserId, now: NOW });
  if (!result.ok) throw new Error(`fixture class refused: ${JSON.stringify(result)}`);
  return result;
}

const sessionsOf = (classGroupId: string) =>
  prisma.session.findMany({
    where: { classGroupId },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    include: { extraRooms: true, _count: { select: { attendees: true } } },
  });

/** Every (date, start) a period asks for, computed independently of the engine. */
function expectedKeys(
  from: string,
  to: string,
  slots: ClassSlot[],
  holidays: Set<string>,
  startedToday: (slot: ClassSlot) => boolean = () => false,
): string[] {
  const keys: string[] = [];
  for (let d = day(from); d.getTime() <= day(to).getTime(); d = addDays(d, 1)) {
    const key = dateKey(d);
    if (holidays.has(key)) continue;
    for (const slot of slots) {
      if (d.getUTCDay() !== slot.dayOfWeek) continue;
      if (key === "2026-10-12" && startedToday(slot)) continue;
      keys.push(`${key}|${slot.startTime}`);
    }
  }
  return keys.sort();
}

const keysOf = (rows: { date: Date; startTime: string }[]) =>
  rows.map((row) => `${dateKey(row.date)}|${row.startTime}`).sort();

async function setPolicy(centerId: string, scheduleConflictPolicy: "WARN" | "DENY") {
  await prisma.centerSettings.update({ where: { centerId }, data: { scheduleConflictPolicy } });
}

async function attend(centerId: string, sessionId: string, studentProfileId: string, recordedBy: string) {
  return createAttendance(
    prisma,
    { centerId, sessionId, studentProfileId, enrollmentId: null, isDropIn: true, recordedBy },
    { historicalBackfill: true, status: "PRESENT" },
  );
}

async function pay(centerId: string, attendeeId: string, recordedBy: string) {
  const [method] = await listActivePaymentMethods(prisma, centerId);
  const result = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendeeId, method.id, recordedBy, { historicalBackfill: true }),
  );
  if (!result.ok) throw new Error(`fixture payment refused: ${JSON.stringify(result)}`);
}

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
  const staff = await makeUser("staff");

  // ── 1. Range generation ─────────────────────────────────────────────────
  console.log("\n1. Range generation");
  const r1 = await makeRoom(A, "R1", 20);
  const r2 = await makeRoom(A, "R2", 10);
  await linkRooms(prisma, A, r1.id, r2.id);
  const t1 = await makeTeacher(A, "t1");
  const holidays = new Set(["2026-10-14", "2026-12-21"]);
  for (const key of holidays) await prisma.holiday.create({ data: scopedData(A, { date: day(key) }) });

  const twoSlots: ClassSlot[] = [
    { dayOfWeek: 1, startTime: "16:00", endTime: "18:00" },
    { dayOfWeek: 3, startTime: "10:00", endTime: "11:00" },
  ];
  const classP = await createClass(A, classInput(t1.id, r1.id, day("2026-10-09"), day("2027-04-01"), [r2.id]), twoSlots);
  const pSessions = await sessionsOf(classP.classGroupId);
  const expectedP = expectedKeys("2026-10-12", "2027-04-01", twoSlots, holidays);
  check(
    "A 9 Oct 2026 – 1 Apr 2027 class with two weekly slots creates exactly the matching dates from today",
    JSON.stringify(keysOf(pSessions)) === JSON.stringify(expectedP) && classP.report.created === expectedP.length,
    `created ${classP.report.created}, expected ${expectedP.length}`,
  );
  check("…none of them in the past (nothing before today, 12 Oct)", pSessions.every((s) => dateKey(s.date) >= "2026-10-12"));
  check("…and none on a holiday (14 Oct, 21 Dec)", pSessions.every((s) => !holidays.has(dateKey(s.date))));
  check(
    "…every session carries the class's room set (R1 + extra R2) and its price",
    pSessions.every((s) => s.roomId === r1.id && s.extraRooms.length === 1 && s.extraRooms[0].roomId === r2.id && s.priceSnapshot === 12_000),
  );
  const rerun = await inClassTransaction(prisma, (tx) =>
    materializeClassSessions(tx, A, classP.classGroupId, { from: NOW, confirmConflicts: false }),
  );
  check(
    "Re-running the engine with nothing changed creates and deletes nothing (idempotent)",
    "created" in rerun && rerun.created === 0 && rerun.deleted === 0 && rerun.updated === 0 &&
      (await prisma.session.count({ where: { classGroupId: classP.classGroupId } })) === pSessions.length,
    JSON.stringify(rerun),
  );

  const t2 = await makeTeacher(A, "t2");
  const r3 = await makeRoom(A, "R3");
  const morning: ClassSlot[] = [{ dayOfWeek: 1, startTime: "09:00", endTime: "10:00" }];
  const classQ = await createClass(A, classInput(t2.id, r3.id, day("2026-10-12"), day("2026-11-30")), morning);
  const qSessions = await sessionsOf(classQ.classGroupId);
  check(
    "A slot whose start already passed today (09:00, now 12:00 Cairo) is not created — the first is next week",
    qSessions.length > 0 && dateKey(qSessions[0].date) === "2026-10-19" &&
      JSON.stringify(keysOf(qSessions)) === JSON.stringify(expectedKeys("2026-10-12", "2026-11-30", morning, holidays, () => true)),
    keysOf(qSessions).slice(0, 2).join(" "),
  );

  // ── 2. Period refusals by direct call ───────────────────────────────────
  console.log("\n2. Period refusals");
  const classCount = () => prisma.classGroup.count({ where: { centerId: A } });
  const before = await classCount();
  const backwards = await createClassWithSessions(
    prisma,
    A,
    { ...classInput(t2.id, r3.id, day("2026-11-01"), day("2026-10-31")), slots: morning },
    { confirmConflicts: true, now: NOW },
  );
  const tooLong = await createClassWithSessions(
    prisma,
    A,
    { ...classInput(t2.id, r3.id, day("2026-10-12"), addDays(day("2026-10-12"), 401)), slots: morning },
    { confirmConflicts: true, now: NOW },
  );
  check(
    "createClassWithSessions refuses end < start (endBeforeStart) and a 401-day span (periodTooLong), writing nothing",
    !backwards.ok && backwards.error === "endBeforeStart" && !tooLong.ok && tooLong.error === "periodTooLong" && (await classCount()) === before,
    JSON.stringify({ backwards, tooLong }),
  );
  const editBackwards = await updateClassWithSessions(
    prisma,
    A,
    classQ.classGroupId,
    classInput(t2.id, r3.id, day("2026-12-01"), day("2026-11-01")),
    { confirmConflicts: true, now: NOW },
  );
  check("updateClassWithSessions refuses end < start too", !editBackwards.ok && editBackwards.error === "endBeforeStart");

  // ── 3. Terms: CRUD, names, overlap, isolation, copied not linked ────────
  console.log("\n3. Terms");
  const sem1 = await createTerm(prisma, A, { name: "Semester 1", startDate: day("2026-09-01"), endDate: day("2027-01-31") });
  const dupLower = await createTerm(prisma, A, { name: "semester 1", startDate: day("2026-09-01"), endDate: day("2027-01-31") });
  const fullYear = await createTerm(prisma, A, { name: "Full year", startDate: day("2026-09-01"), endDate: day("2027-06-30") });
  const badTerm = await createTerm(prisma, A, { name: "Bad", startDate: day("2027-01-31"), endDate: day("2026-09-01") });
  check("A term is created", sem1.ok);
  check("A case-insensitive duplicate name is refused (\"semester 1\")", !dupLower.ok && dupLower.error === "duplicateName");
  check("Overlapping terms are allowed (\"Full year\" spans \"Semester 1\")", fullYear.ok);
  check("A term ending before it starts is refused", !badTerm.ok && badTerm.error === "endBeforeStart");
  if (!sem1.ok || !fullYear.ok) throw new Error("term fixtures failed");
  const renameClash = await updateTerm(prisma, A, fullYear.term.id, { name: "SEMESTER 1", startDate: day("2026-09-01"), endDate: day("2027-06-30") });
  const recase = await updateTerm(prisma, A, sem1.term.id, { name: "SEMESTER 1", startDate: day("2026-09-01"), endDate: day("2027-01-31") });
  check("Renaming onto another term's name (any case) is refused", !renameClash.ok && renameClash.error === "duplicateName");
  check("A term may change the case of its own name", recase.ok && recase.term.name === "SEMESTER 1");
  await setTermActive(prisma, A, fullYear.term.id, false);
  const activeTerms = await listCenterTerms(prisma, A, { activeOnly: true });
  check("A deactivated term is not offered (activeOnly)", activeTerms.length === 1 && activeTerms[0].id === sem1.term.id);
  await setTermActive(prisma, A, fullYear.term.id, true);

  const bTerm = await createTerm(prisma, B, { name: "Semester 1", startDate: day("2026-09-01"), endDate: day("2027-01-31") });
  check("Another centre may use the same term name (unique per centre)", bTerm.ok);
  check("Centre B's term list never includes Centre A's", (await listCenterTerms(prisma, B)).every((term) => term.centerId === B));
  const crossUpdate = await updateTerm(prisma, B, sem1.term.id, { name: "Hijacked", startDate: day("2026-09-01"), endDate: day("2027-01-31") });
  const crossTermDelete = await deleteTerm(prisma, B, sem1.term.id);
  const crossToggle = await setTermActive(prisma, B, sem1.term.id, false);
  check(
    "Centre B cannot update, toggle or delete Centre A's term by id",
    !crossUpdate.ok && !crossTermDelete.ok && !crossToggle.ok &&
      (await prisma.centerTerm.findUnique({ where: { id: sem1.term.id } }))?.name === "SEMESTER 1",
  );
  check("Centre B cannot read Centre A's term by id", (await scopedFindById(prisma.centerTerm, B, sem1.term.id)) === null);

  // A class picks Semester 1 — its dates are copied onto the class.
  const t3 = await makeTeacher(A, "t3");
  const r4 = await makeRoom(A, "R4");
  const tuesday: ClassSlot[] = [{ dayOfWeek: 2, startTime: "14:00", endTime: "15:00" }];
  const fromTerm = await createClass(A, classInput(t3.id, r4.id, sem1.term.startDate, sem1.term.endDate), tuesday);
  const termSessions = await prisma.session.count({ where: { classGroupId: fromTerm.classGroupId } });
  await updateTerm(prisma, A, sem1.term.id, { name: "Autumn", startDate: day("2026-10-01"), endDate: day("2026-12-31") });
  const afterRedate = await prisma.classGroup.findUniqueOrThrow({ where: { id: fromTerm.classGroupId } });
  check(
    "Renaming and redating the term later moves no class (dates were copied)",
    dateKey(afterRedate.startDate) === "2026-09-01" && dateKey(afterRedate.endDate) === "2027-01-31" &&
      (await prisma.session.count({ where: { classGroupId: fromTerm.classGroupId } })) === termSessions,
  );
  const deleted = await deleteTerm(prisma, A, sem1.term.id);
  const afterTermDelete = await prisma.classGroup.findUnique({ where: { id: fromTerm.classGroupId } });
  check(
    "Deleting the term is a hard delete and leaves the class and its sessions as they were",
    deleted.ok && (await prisma.centerTerm.count({ where: { id: sem1.term.id } })) === 0 &&
      afterTermDelete !== null && dateKey(afterTermDelete.endDate) === "2027-01-31" &&
      (await prisma.session.count({ where: { classGroupId: fromTerm.classGroupId } })) === termSessions,
  );

  // ── 4. Whole-range conflicts: one atomic decision ───────────────────────
  console.log("\n4. Whole-range conflict contract");
  const t4 = await makeTeacher(A, "t4");
  const t5 = await makeTeacher(A, "t5");
  const r5 = await makeRoom(A, "R5");
  const tueEvening: ClassSlot[] = [{ dayOfWeek: 2, startTime: "16:00", endTime: "18:00" }];
  await createClass(A, classInput(t4.id, r5.id, day("2026-10-12"), day("2026-12-31")), tueEvening);
  const clashing: ClassSlot[] = [{ dayOfWeek: 2, startTime: "17:00", endTime: "18:00" }];
  const clashInput = classInput(t5.id, r5.id, day("2026-11-01"), day("2027-02-28"));
  const overlapDates = expectedKeys("2026-11-01", "2026-12-31", clashing, holidays).length;
  const t5Classes = () => prisma.classGroup.count({ where: { centerId: A, teacherId: t5.id } });
  const t5Sessions = () => prisma.session.count({ where: { centerId: A, teacherId: t5.id } });

  const warnNoFlag = await createClassWithSessions(prisma, A, { ...clashInput, slots: clashing }, { confirmConflicts: false, now: NOW });
  check(
    "WARN without confirmConflicts: refused with the FULL list (one room clash per overlapping Tuesday), nothing written",
    !warnNoFlag.ok && warnNoFlag.error === "conflictsNeedConfirmation" && "conflicts" in warnNoFlag &&
      warnNoFlag.conflicts.length === overlapDates && warnNoFlag.conflicts.every((c) => c.type === "room" && c.roomId === r5.id) &&
      (await t5Classes()) === 0 && (await t5Sessions()) === 0 &&
      (await prisma.classSchedule.count({ where: { centerId: A, classGroup: { teacherId: t5.id } } })) === 0,
    JSON.stringify({ error: !warnNoFlag.ok ? warnNoFlag.error : null, conflicts: "conflicts" in warnNoFlag ? warnNoFlag.conflicts.length : 0, overlapDates }),
  );
  await setPolicy(A, "DENY");
  const denyFlag = await createClassWithSessions(prisma, A, { ...clashInput, slots: clashing }, { confirmConflicts: true, now: NOW });
  await setPolicy(A, "WARN");
  check(
    "DENY even with confirmConflicts: refused with the list, nothing written",
    !denyFlag.ok && denyFlag.error === "conflict" && "conflicts" in denyFlag && denyFlag.conflicts.length === overlapDates &&
      (await t5Classes()) === 0 && (await t5Sessions()) === 0,
  );
  const warnFlag = await createClassWithSessions(prisma, A, { ...clashInput, slots: clashing }, { confirmConflicts: true, actorUserId: staff.id, now: NOW });
  const confirmedAudit = warnFlag.ok
    ? await prisma.auditLog.findMany({ where: { centerId: A, action: "schedule.conflict.confirm", entityId: warnFlag.classGroupId } })
    : [];
  check(
    "WARN with confirmConflicts: everything is created — every date of the period, the clashing ones included",
    warnFlag.ok && (await t5Sessions()) === expectedKeys("2026-11-01", "2027-02-28", clashing, holidays).length,
  );
  check(
    "…and ONE audit row lists every confirmed conflict, attributed to the actor",
    confirmedAudit.length === 1 && confirmedAudit[0].actorUserId === staff.id &&
      ((confirmedAudit[0].after as { conflicts: unknown[] }).conflicts.length === overlapDates),
    JSON.stringify(confirmedAudit.map((row) => (row.after as { conflicts: unknown[] }).conflicts.length)),
  );

  // ── 5. Resync: pristine vs non-pristine, each disqualifier ──────────────
  console.log("\n5. Resync");
  const t6 = await makeTeacher(A, "t6");
  const t6b = await makeTeacher(A, "t6b");
  const r6 = await makeRoom(A, "R6");
  const r6b = await makeRoom(A, "R6b");
  const student = await makeStudent(A, "s1");
  const tueMorning: ClassSlot[] = [{ dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }];
  const classZ = await createClass(A, classInput(t6.id, r6.id, day("2026-10-12"), day("2026-12-29")), tueMorning);
  const z = (await sessionsOf(classZ.classGroupId)).map((s) => s.id);
  check("Fixture: 12 Tuesday sessions", z.length === 12, String(z.length));
  // One disqualifier per session (s3 carries a payment, which needs an attendee).
  await cancelSession(prisma, A, z[0], { now: NOW });
  await prisma.session.update({ where: { id: z[1] }, data: { closedAt: NOW } });
  await attend(A, z[2], student.profile.id, staff.id);
  const paid = await attend(A, z[3], student.profile.id, staff.id);
  await pay(A, paid.id, staff.id);
  await prisma.settlement.create({ data: scopedData(A, { teacherId: t6.id, sessionId: z[4], totalAmount: 0, createdBy: staff.id }) });
  await prisma.sessionRating.create({ data: { studentUserId: student.user.id, sessionId: z[5], teacherId: t6.id, score: 5 } });
  await updateSessionShareOverride(prisma, A, z[6], { centerShareType: "FIXED", centerShareValue: 1_000 }, { now: NOW });
  await prisma.session.update({ where: { id: z[7] }, data: { description: "Bring the past paper" } });
  const moved = await rescheduleSession(prisma, A, z[8], { date: day("2026-12-03"), startTime: "10:00", endTime: "11:00" }, "WARN", "en", { now: NOW, confirmConflicts: false });
  await prisma.session.update({ where: { id: z[9] }, data: { teacherId: t6b.id } });
  await updateSessionRooms(prisma, A, z[10], { roomId: r6b.id, extraRoomIds: [] }, "WARN", "en", { now: NOW, confirmConflicts: false });
  const expectReasons: Record<number, string> = {
    1: "closed", 2: "attendees", 3: "payments", 4: "settlement", 5: "ratings",
    6: "shareOverride", 7: "description", 8: "rescheduled", 9: "teacherChanged", 10: "roomsChanged",
  };
  const zSchedule = await prisma.classSchedule.findFirstOrThrow({ where: { classGroupId: classZ.classGroupId } });
  const before5 = await prisma.session.findMany({ where: { id: { in: z } }, select: { id: true, date: true, startTime: true, teacherId: true, roomId: true, status: true } });
  const toWednesday = await writeClassSlot(
    prisma,
    A,
    { kind: "update", scheduleId: zSchedule.id, classGroupId: classZ.classGroupId, slot: { dayOfWeek: 3, startTime: "10:00", endTime: "11:00" } },
    { confirmConflicts: false, now: NOW },
  );
  const wednesdays = expectedKeys("2026-10-12", "2026-12-29", [{ dayOfWeek: 3, startTime: "10:00", endTime: "11:00" }], holidays);
  const after5 = await prisma.session.findMany({ where: { id: { in: z } }, select: { id: true, date: true, startTime: true, teacherId: true, roomId: true, status: true } });
  check(
    "Moving the slot Tue → Wed deletes only the pristine Tuesday session and creates every Wednesday",
    toWednesday.ok && toWednesday.report?.deleted === 1 && toWednesday.report?.created === wednesdays.length &&
      !after5.some((s) => s.id === z[11]),
    JSON.stringify(toWednesday.ok ? toWednesday.report && { ...toWednesday.report, kept: toWednesday.report.kept.length } : toWednesday),
  );
  check(
    "Every non-pristine session is left exactly as it was (date, time, teacher, room, status)",
    z.slice(0, 11).every((id) => {
      const a = before5.find((s) => s.id === id);
      const b = after5.find((s) => s.id === id);
      return a && b && JSON.stringify(a) === JSON.stringify(b);
    }),
  );
  const keptIds = new Map((toWednesday.ok ? toWednesday.report?.kept ?? [] : []).map((k) => [k.sessionId, k.reasons]));
  for (const [index, reason] of Object.entries(expectReasons)) {
    check(`…and reported as kept, with its reason: ${reason}`, keptIds.get(z[Number(index)])?.includes(reason as never) === true, JSON.stringify(keptIds.get(z[Number(index)])));
  }
  check(
    "The reschedule's replacement (Thu 3 Dec) is kept and reported too; the cancelled one is left alone, not reported",
    moved.ok && keptIds.has(moved.session.id) && !keptIds.has(z[0]) && after5.find((s) => s.id === z[0])?.status === "CANCELLED",
  );
  check(
    "The class page's kept list (keptClassSessions) reads the same set",
    JSON.stringify([...keptIds.keys()].sort()) ===
      JSON.stringify((await keptClassSessions(prisma, A, classZ.classGroupId, NOW)).map((k) => k.sessionId).sort()),
  );
  const zRerun = await inClassTransaction(prisma, (tx) =>
    materializeClassSessions(tx, A, classZ.classGroupId, { from: NOW, confirmConflicts: false }),
  );
  check(
    "A re-run with no change creates and deletes nothing",
    "created" in zRerun && zRerun.created === 0 && zRerun.deleted === 0 && zRerun.updated === 0,
    JSON.stringify("created" in zRerun ? { ...zRerun, kept: zRerun.kept.length } : zRerun),
  );

  // Teacher and room change: pristine sessions follow, the rest stay.
  const t7 = await makeTeacher(A, "t7");
  const t8 = await makeTeacher(A, "t8");
  const r7 = await makeRoom(A, "R7");
  const r8 = await makeRoom(A, "R8");
  const r8x = await makeRoom(A, "R8x");
  await linkRooms(prisma, A, r8.id, r8x.id);
  const thursday: ClassSlot[] = [{ dayOfWeek: 4, startTime: "12:00", endTime: "13:00" }];
  const wInput = classInput(t7.id, r7.id, day("2026-10-12"), day("2026-12-31"));
  const classW = await createClass(A, wInput, thursday);
  const w = (await sessionsOf(classW.classGroupId)).map((s) => s.id);
  await attend(A, w[w.length - 1], student.profile.id, staff.id);
  const reTeacher = await updateClassWithSessions(
    prisma,
    A,
    classW.classGroupId,
    { ...wInput, teacherId: t8.id, roomId: r8.id, extraRoomIds: [r8x.id] },
    { confirmConflicts: false, now: NOW },
  );
  const wAfter = await sessionsOf(classW.classGroupId);
  check(
    "A new teacher and room set move every pristine future session onto them (extra room copied)",
    reTeacher.ok && reTeacher.report?.updated === w.length - 1 &&
      wAfter.filter((s) => s.id !== w[w.length - 1]).every((s) => s.teacherId === t8.id && s.roomId === r8.id && s.extraRooms.length === 1 && s.extraRooms[0].roomId === r8x.id),
    JSON.stringify(reTeacher.ok ? reTeacher.report && { ...reTeacher.report, kept: reTeacher.report.kept.length } : reTeacher),
  );
  check(
    "…the session with an attendee keeps its old teacher and room and is reported as kept",
    wAfter.some((s) => s.id === w[w.length - 1] && s.teacherId === t7.id && s.roomId === r7.id) &&
      reTeacher.ok && reTeacher.report?.kept.some((k) => k.sessionId === w[w.length - 1]) === true,
  );

  // endDate shrink / extend.
  const shrinkInput = { ...wInput, teacherId: t8.id, roomId: r8.id, extraRoomIds: [r8x.id], endDate: day("2026-12-10") };
  const pristineAfterShrink = expectedKeys("2026-12-11", "2026-12-31", thursday, holidays).length - 1;
  const shrink = await updateClassWithSessions(prisma, A, classW.classGroupId, shrinkInput, { confirmConflicts: false, now: NOW });
  const wShrunk = await sessionsOf(classW.classGroupId);
  check(
    "Shortening the end date removes only the pristine sessions after it",
    shrink.ok && shrink.report?.deleted === pristineAfterShrink &&
      wShrunk.filter((s) => dateKey(s.date) > "2026-12-10").map((s) => s.id).join() === w[w.length - 1],
    JSON.stringify(shrink.ok ? shrink.report && { ...shrink.report, kept: shrink.report.kept.length } : shrink),
  );
  const extend = await updateClassWithSessions(prisma, A, classW.classGroupId, { ...shrinkInput, endDate: day("2027-01-21") }, { confirmConflicts: false, now: NOW });
  check(
    "Extending the end date adds the missing sessions (the kept one's date is not doubled)",
    extend.ok && extend.report?.created === expectedKeys("2026-12-11", "2027-01-21", thursday, holidays).length - 1 && extend.report?.deleted === 0,
    JSON.stringify(extend.ok ? extend.report && { ...extend.report, kept: extend.report.kept.length } : extend),
  );

  // Holiday added after sessions exist.
  const holidayDate = "2026-11-05";
  const wOnHoliday = await prisma.session.findMany({ where: { classGroupId: classW.classGroupId, date: day(holidayDate) } });
  const zWed = await prisma.session.findFirstOrThrow({ where: { classGroupId: classZ.classGroupId, date: day("2026-11-04") } });
  await attend(A, zWed.id, student.profile.id, staff.id);
  const pruned = await prisma.$transaction(async (tx) => {
    await tx.holiday.create({ data: scopedData(A, { date: day("2026-11-04") }) });
    return removeSessionsOnHoliday(tx, A, day("2026-11-04"), NOW);
  });
  const prunedW = await prisma.$transaction(async (tx) => {
    await tx.holiday.create({ data: scopedData(A, { date: day(holidayDate) }) });
    return removeSessionsOnHoliday(tx, A, day(holidayDate), NOW);
  });
  check(
    "A holiday added later removes that day's pristine sessions and keeps (counts) ones with records",
    wOnHoliday.length === 1 && prunedW.deleted === 1 && pruned.kept >= 1 &&
      (await prisma.session.count({ where: { id: zWed.id } })) === 1,
    JSON.stringify({ pruned, prunedW }),
  );

  // ── 6. Deactivate (delete vs cancel vs untouched), forward readers ──────
  console.log("\n6. Deactivate");
  const t9 = await makeTeacher(A, "t9");
  const r9 = await makeRoom(A, "R9");
  const monday: ClassSlot[] = [{ dayOfWeek: 1, startTime: "13:00", endTime: "14:00" }];
  const dInput = classInput(t9.id, r9.id, day("2026-10-05"), day("2026-12-28"));
  const classD = await createClass(A, dInput, monday);
  const D = classD.classGroupId;
  const enrolled = await makeStudent(A, "s2");
  await prisma.enrollment.create({ data: scopedData(A, { classGroupId: D, studentProfileId: enrolled.profile.id, status: "ACTIVE" }) });
  // A past session with history (closed), and one that started earlier today.
  const past = await prisma.session.create({
    data: scopedData(A, { classGroupId: D, teacherId: t9.id, roomId: r9.id, date: day("2026-10-05"), startTime: "13:00", endTime: "14:00", priceSnapshot: 12_000 }),
  });
  const pastAttendee = await attend(A, past.id, enrolled.profile.id, staff.id);
  await pay(A, pastAttendee.id, staff.id);
  await closeSessionIfDayOver(prisma, A, past.id, NOW);
  const startedToday = await prisma.session.create({
    data: scopedData(A, { classGroupId: D, teacherId: t9.id, roomId: r9.id, date: TODAY, startTime: "08:00", endTime: "09:00", priceSnapshot: 12_000 }),
  });
  const dFuture = (await sessionsOf(D)).filter((s) => s.id !== past.id && s.id !== startedToday.id);
  await attend(A, dFuture[2].id, enrolled.profile.id, staff.id);
  const deact = await deactivateClass(prisma, A, D, { actorUserId: staff.id, now: NOW });
  const dAfter = await sessionsOf(D);
  check(
    "Deactivate deletes the pristine future sessions and CANCELS the one with records",
    deact.ok && deact.deleted === dFuture.length - 1 && deact.cancelled === 1 &&
      dAfter.find((s) => s.id === dFuture[2].id)?.status === "CANCELLED" && dAfter.find((s) => s.id === dFuture[2].id)?._count.attendees === 1,
    JSON.stringify(deact),
  );
  check(
    "…sessions that already started or closed are untouched",
    dAfter.find((s) => s.id === startedToday.id)?.status === "SCHEDULED" && dAfter.find((s) => s.id === past.id)?.closedAt !== null,
  );
  check(
    "…enrolments stay ACTIVE and the deactivation is audited",
    (await prisma.enrollment.findFirst({ where: { classGroupId: D } }))?.status === "ACTIVE" &&
      (await prisma.auditLog.count({ where: { centerId: A, action: "classGroup.deactivate", entityId: D } })) === 1,
  );

  // Forward-looking readers, each by direct call.
  const occupancy = await loadSessionOccupancy(prisma, A, "en", TODAY, day("2026-12-31"));
  check("Conflict occupancy holds no open session of the deactivated class", !occupancy.some((o) => o.classGroupId === D));
  const studentUpcoming = await studentUpcomingSessions(prisma, A, enrolled.profile.id, TODAY);
  check("The student's upcoming sessions exclude it", !studentUpcoming.some((s) => s.classGroupId === D));
  const teacherList = await prisma.session.findMany({
    where: scopedWhere(A, teacherSessionListWhere({ teacherId: t9.id, from: TODAY, to: day("2026-12-31") })),
  });
  check("The teacher's upcoming session list excludes it", teacherList.length === 0, String(teacherList.length));
  const summary = await teacherCenterSummary(prisma, A, t9.id, TODAY, { start: TODAY, end: addDays(TODAY, 6) }, { from: TODAY, to: TODAY });
  check("The teacher's today/this-week counts exclude it", summary.sessionsToday === 0 && summary.sessionsThisWeek === 0, JSON.stringify(summary));
  check("Student Discover excludes it", !(await discoverClassesForCenter(prisma, A)).some((c) => c.id === D));
  const otherStudent = await makeStudent(A, "s3");
  const reserve = await prisma.$transaction((tx) => reserveOrEnroll(tx, { centerId: A, classGroupId: D, studentUserId: otherStudent.user.id }));
  check("Reserving or enrolling into it is refused", !reserve.ok && reserve.error === "notFound");
  const pendingRow = await prisma.reservation.create({ data: scopedData(A, { classGroupId: D, studentId: otherStudent.user.id, status: "PENDING" }) });
  const confirmPending = await prisma.$transaction((tx) => confirmReservation(tx, A, pendingRow.id, staff.id));
  check("Approving a pending request for it is refused (both approvals queues)", !confirmPending.ok && confirmPending.error === "notFound");
  const newSession = await prisma.changeRequest.create({
    data: scopedData(A, { type: "NEW_SESSION", requestedBy: t9.id, payload: { classGroupId: D, date: "2026-11-10", startTime: "15:00", endTime: "16:00", note: null }, status: "PENDING" }),
  });
  const approveNew = await resolveSessionRequest(prisma, A, newSession.id, "APPROVED", staff.id, "WARN", "en", { confirmConflicts: true });
  check("A NEW_SESSION request for it is refused (classNotFound)", !approveNew.ok && approveNew.error === "classNotFound");
  // History stays readable.
  const revenue = await revenueTotals(prisma, A, { from: day("2026-10-05"), to: day("2026-10-05") }, t9.id);
  check("Analytics still counts its past (closed) session's payment", revenue.paymentCount === 1 && revenue.collected === 12_000, JSON.stringify(revenue));
  const history = await studentPastAttendance(prisma, A, enrolled.profile.id, TODAY);
  check("The student's attendance history still shows it", history.some((row) => row.sessionId === past.id));
  check("The closed past session still occupies its room in occupancy (it happened)", (await loadSessionOccupancy(prisma, A, "en", day("2026-10-05"), day("2026-10-05"))).some((o) => o.sessionId === past.id));

  // ── 7. Reactivate ───────────────────────────────────────────────────────
  console.log("\n7. Reactivate");
  const t10 = await makeTeacher(A, "t10");
  const ended = await createClass(A, classInput(t10.id, r9.id, day("2026-09-01"), day("2026-10-12")), [{ dayOfWeek: 6, startTime: "10:00", endTime: "11:00" }]);
  await prisma.classGroup.update({ where: { id: ended.classGroupId }, data: { endDate: day("2026-10-10") } });
  await deactivateClass(prisma, A, ended.classGroupId, { now: NOW });
  const reactEnded = await reactivateClass(prisma, A, ended.classGroupId, { confirmConflicts: true, now: NOW });
  check("Reactivating a class whose end date has passed is refused (periodEnded)", !reactEnded.ok && reactEnded.error === "periodEnded");

  const t11 = await makeTeacher(A, "t11");
  await createClass(A, classInput(t11.id, r9.id, day("2026-10-12"), day("2026-11-30")), [{ dayOfWeek: 1, startTime: "13:30", endTime: "14:30" }]);
  const reactNoFlag = await reactivateClass(prisma, A, D, { confirmConflicts: false, now: NOW });
  check(
    "Reactivating into a now-taken room without the flag is refused with the list; the class stays inactive, nothing created",
    !reactNoFlag.ok && "conflicts" in reactNoFlag && reactNoFlag.conflicts.length > 0 &&
      (await prisma.classGroup.findUniqueOrThrow({ where: { id: D } })).active === false &&
      (await prisma.session.count({ where: { classGroupId: D, status: "SCHEDULED", date: { gt: TODAY } } })) === 0,
  );
  const react = await reactivateClass(prisma, A, D, { confirmConflicts: true, actorUserId: staff.id, now: NOW });
  check(
    "With the flag it reactivates and regenerates its sessions from today through the end date (the cancelled date stays cancelled)",
    react.ok && react.report.created === dFuture.length - 1 &&
      (await prisma.classGroup.findUniqueOrThrow({ where: { id: D } })).active === true,
    JSON.stringify(react.ok ? { ...react.report, kept: react.report.kept.length, conflicts: react.report.conflicts.length } : react),
  );

  // ── 8. Delete: each blocker by direct call ──────────────────────────────
  console.log("\n8. Delete");
  const r10 = await makeRoom(A, "R10");
  let slotHour = 6;
  const blank = async () => {
    const teacher = await makeTeacher(A, `blank${slotHour}`);
    const start = `${String(slotHour).padStart(2, "0")}:00`;
    const end = `${String(slotHour).padStart(2, "0")}:30`;
    slotHour += 1;
    const made = await createClass(A, classInput(teacher.id, r10.id, day("2026-10-12"), day("2026-11-30")), [{ dayOfWeek: 5, startTime: start, endTime: end }]);
    const sessions = await sessionsOf(made.classGroupId);
    return { id: made.classGroupId, teacherId: teacher.id, sessions };
  };
  const deletable = await blank();
  const del = await deleteClass(prisma, A, deletable.id, { actorUserId: staff.id, now: NOW });
  check(
    "A class that never ran is deleted — its pristine sessions and slots with it — and audited",
    del.ok && (await prisma.classGroup.count({ where: { id: deletable.id } })) === 0 &&
      (await prisma.session.count({ where: { classGroupId: deletable.id } })) === 0 &&
      (await prisma.classSchedule.count({ where: { classGroupId: deletable.id } })) === 0 &&
      (await prisma.auditLog.count({ where: { action: "classGroup.delete", entityId: deletable.id } })) === 1,
  );
  const blocked = async (label: string, key: keyof Awaited<ReturnType<typeof classDeleteBlockers>>, arrange: (c: Awaited<ReturnType<typeof blank>>) => Promise<unknown>) => {
    const c = await blank();
    await arrange(c);
    const result = await deleteClass(prisma, A, c.id, { now: NOW });
    check(
      `Delete is refused by direct call when ${label}`,
      !result.ok && result.error === "classInUse" && result.blockers[key] > 0 && (await prisma.classGroup.count({ where: { id: c.id } })) === 1,
      JSON.stringify(result),
    );
  };
  await blocked("a session has started", "started", (c) =>
    prisma.session.create({ data: scopedData(A, { classGroupId: c.id, teacherId: c.teacherId, roomId: r10.id, date: day("2026-10-09"), startTime: "06:00", endTime: "06:30", priceSnapshot: 0 }) }),
  );
  await blocked("a session has attendees", "attendees", (c) => attend(A, c.sessions[0].id, student.profile.id, staff.id));
  await blocked("a session has payments", "payments", async (c) => pay(A, (await attend(A, c.sessions[0].id, student.profile.id, staff.id)).id, staff.id));
  await blocked("a session has a settlement", "settlements", (c) =>
    prisma.settlement.create({ data: scopedData(A, { teacherId: c.teacherId, sessionId: c.sessions[0].id, totalAmount: 0, createdBy: staff.id }) }),
  );
  await blocked("a session has ratings", "ratings", (c) =>
    prisma.sessionRating.create({ data: { studentUserId: student.user.id, sessionId: c.sessions[0].id, teacherId: c.teacherId, score: 4 } }),
  );
  await blocked("a session was rescheduled", "rescheduled", (c) =>
    rescheduleSession(prisma, A, c.sessions[0].id, { date: day("2026-12-08"), startTime: "06:00", endTime: "06:30" }, "WARN", "en", { now: NOW, confirmConflicts: true }),
  );
  await blocked("it has enrolments", "enrollments", (c) =>
    prisma.enrollment.create({ data: scopedData(A, { classGroupId: c.id, studentProfileId: student.profile.id, status: "REMOVED" }) }),
  );
  await blocked("it has reservations", "reservations", (c) =>
    prisma.reservation.create({ data: scopedData(A, { classGroupId: c.id, studentId: student.user.id, status: "REJECTED" }) }),
  );

  // ── 9. Cross-centre isolation ───────────────────────────────────────────
  console.log("\n9. Cross-centre isolation");
  const crossDelete = await deleteClass(prisma, B, classZ.classGroupId, { now: NOW });
  const crossDeactivate = await deactivateClass(prisma, B, classZ.classGroupId, { now: NOW });
  const crossUpdateClass = await updateClassWithSessions(prisma, B, classZ.classGroupId, classInput(t6.id, r6.id, day("2026-10-12"), day("2026-12-29")), { confirmConflicts: true, now: NOW });
  const crossSlot = await writeClassSlot(prisma, B, { kind: "add", classGroupId: classZ.classGroupId, slot: { dayOfWeek: 5, startTime: "10:00", endTime: "11:00" } }, { confirmConflicts: true, now: NOW });
  check(
    "Centre B cannot delete, deactivate, edit or add a slot to Centre A's class",
    !crossDelete.ok && crossDelete.error === "notFound" && !crossDeactivate.ok && !crossUpdateClass.ok && !crossSlot.ok &&
      (await prisma.classGroup.findUniqueOrThrow({ where: { id: classZ.classGroupId } })).active === true,
  );
  check("Centre B reads no kept sessions of Centre A's class", (await keptClassSessions(prisma, B, classZ.classGroupId, NOW)).length === 0);
}

main()
  .catch((error) => {
    failures += 1;
    console.error(error);
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("cleanup failed:", error));
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} class-periods check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll class-periods checks passed.");
  });

