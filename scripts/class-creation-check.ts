/**
 * Class-creation check — the R6 acceptance gate (docs/03-build-order.md "R6"
 * "Done when"): a class is created with its weekly slots and every session in
 * ONE transaction; a brand-new teacher is created in the SAME transaction;
 * and the shared time parser / picker search read what people type.
 *
 * Run with:  npm run check:class-creation
 *
 * Exercises the real production modules — `lib/db/class-sessions.ts`
 * (`createClassWithSessions`, `createClassWithNewTeacher`,
 * `previewNewClassSessions`), `lib/db/teacher-membership.ts`, the zod schemas,
 * `lib/time-input.ts`, `lib/picker-search.ts`, `lib/phone.ts` — **by direct
 * call** against two throwaway centres, with an injected clock. A forced
 * failure inside the class step is injected through a transaction proxy whose
 * `session.createMany` throws, to prove nothing — class, schedules, sessions,
 * teacher, membership, user, audit rows — survives. Plus static assertions
 * (no native time input, one teacher-creation path). Needs a reachable
 * database; cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { scopedData } from "../lib/db/tenant-scope.ts";
import {
  addDays,
  dateKey,
  dayMarker,
  weeklySlotsError,
  zonedDateTimeToUtc,
} from "../lib/scheduling.ts";
import {
  createClassWithNewTeacher,
  createClassWithSessions,
  previewNewClassSessions,
  type ClassInput,
  type ClassSlot,
  type NewTeacherClassInput,
  type NewTeacherClassPermission,
} from "../lib/db/class-sessions.ts";
import { classSlotsSchema } from "../lib/validation/classes.ts";
import { teacherCreateSchema } from "../lib/validation/people.ts";
import { matchesPicker } from "../lib/picker-search.ts";
import { phoneMatchesQuery, phoneSearchDigits } from "../lib/phone.ts";
import { fromTimeParts, minutesBetween, parseTimeInput, suggestEndTime, timeParts } from "../lib/time-input.ts";
import { toAsciiDigits } from "../lib/digits.ts";

const prisma = await gatePrisma();

const SLUG_A = "class-creation-check-a";
const SLUG_B = "class-creation-check-b";
const EMAIL_PREFIX = "class-creation-check-";
/** Fake numbers — a reserved block no real person has. */
const PHONE_PREFIX = "0109990";
const TZ = "Africa/Cairo";

/** "Now" for every DB check: Monday 12 Oct 2026, 12:00 in Cairo. */
const NOW = zonedDateTimeToUtc("2026-10-12", 12 * 60, TZ);
const START = dayMarker("2026-10-12");
const END = dayMarker("2026-11-08");

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** People created with no email and a phone they could not keep (SEC-2a) — cleaned up by id. */
const extraUserIds: string[] = [];

async function cleanup() {
  const centers = await prisma.center.findMany({
    where: { slug: { in: [SLUG_A, SLUG_B] } },
    select: { id: true, organizationId: true },
  });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    // AuditLog.centerId has no cascade.
    await deleteAuditRows(prisma, { centerId: { in: ids } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({
      where: { id: { in: centers.map((c) => c.organizationId) } },
    });
  }
  await prisma.user.deleteMany({
    where: {
      OR: [{ email: { startsWith: EMAIL_PREFIX } }, { phone: { startsWith: PHONE_PREFIX } }, { id: { in: extraUserIds } }],
    },
  });
}

// ── Static assertions (no database) ─────────────────────────────────────────

function listFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx|js|mjs|json|yml|yaml)$/.test(entry)) out.push(path);
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const norm = (file: string) => file.replaceAll("\\", "/");

function staticChecks() {
  console.log("Static assertions");

  const uiFiles = [...listFiles("app"), ...listFiles("components")].filter((file) => /\.(ts|tsx)$/.test(file));
  const nativeTime = uiFiles.filter((file) => /type\s*=\s*["']time["']|type:\s*["']time["']/.test(read(file)));
  check(
    'No native type="time" input remains under app/ or components/',
    nativeTime.length === 0,
    nativeTime.join(", "),
  );
  check(
    "The shared TimePicker and the paired TimeRangeFields exist",
    existsSync("components/ui/time-picker.tsx") && existsSync("components/center/time-range-fields.tsx"),
  );
  const timePickerUsers = uiFiles.filter((file) => /<TimePicker\b|<TimeRangeFields\b/.test(read(file)));
  check(
    "Every start/end form uses it (class rows, New session, Reschedule, schedule builder, teacher requests)",
    [
      "weekly-schedule-rows.tsx",
      "new-session-dialog.tsx",
      "session-lifecycle-actions.tsx",
      "schedule-builder.tsx",
      "teach-at-center-card.tsx",
      "class-request-form.tsx",
      "session-request-form.tsx",
    ].every((name) => timePickerUsers.some((file) => norm(file).endsWith(name))),
    timePickerUsers.join(", "),
  );
  check(
    "There is exactly one time parser (parseTimeInput) — no other module hand-parses a typed time",
    listFiles("lib")
      .concat(uiFiles)
      .filter((file) => !norm(file).endsWith("lib/time-input.ts"))
      .every((file) => !/function\s+parseTimeInput\b/.test(read(file))),
  );

  // The teacher-creation logic lives in one place.
  const appAndLib = [...listFiles("app"), ...listFiles("lib"), ...listFiles("components")].filter((file) =>
    /\.(ts|tsx)$/.test(file),
  );
  const definesTeacherPath = appAndLib.filter((file) => /function\s+addTeacherMembership\b/.test(read(file)));
  check(
    "addTeacherMembership (the teacher-creation logic) is defined in lib/db/teacher-membership.ts only",
    definesTeacherPath.length === 1 && norm(definesTeacherPath[0]).endsWith("lib/db/teacher-membership.ts"),
    definesTeacherPath.join(", "),
  );
  const callsAdd = appAndLib.filter((file) => /\baddTeacherMembership\(/.test(read(file)) && !/function\s+addTeacherMembership/.test(read(file)));
  check(
    "It is called from the class-creation transaction only (the Add teacher path reaches it through createTeacherMembership, in the same module)",
    callsAdd.map(norm).sort().join(",") === ["lib/db/class-sessions.ts"].join(","),
    callsAdd.join(", "),
  );
  const teacherActions = read("app/[locale]/(center)/teachers/actions.ts");
  const classActions = read("app/[locale]/(center)/classes/actions.ts");
  check(
    "createTeacherAction delegates to createTeacherMembership and no longer creates a person or membership itself",
    /createTeacherMembership\(/.test(teacherActions) && !/createPerson\(/.test(teacherActions) && !/teachers\.create\(/.test(teacherActions),
  );
  check(
    "The class actions never create a person or a teacher membership themselves",
    !/createPerson\(/.test(classActions) && !/membership\.create\(/.test(classActions) && !/teachers\.create\(/.test(classActions),
  );
  check(
    "Only lib/db/teacher-membership.ts creates a TEACHER membership (no `role: TEACHER` create elsewhere in app/ or lib/db/)",
    [...listFiles("app"), ...listFiles("lib/db")]
      .filter((file) => /\.(ts|tsx)$/.test(file) && !norm(file).endsWith("lib/db/teacher-membership.ts") && !norm(file).endsWith("prisma/seed.ts"))
      .every((file) => !/membership\.create\([\s\S]{0,200}?role:\s*(?:"TEACHER"|TEACHER)/.test(read(file))),
  );
  check(
    "The New teacher fields are the Add teacher form's own components (NewTeacherFields) — not a fork",
    /NewTeacherFields/.test(read("app/[locale]/(center)/teachers/teacher-form.tsx")) &&
      /NewTeacherFields/.test(read("app/[locale]/(center)/classes/class-form.tsx")) &&
      !/PersonFields|ContactFields/.test(read("app/[locale]/(center)/classes/class-form.tsx")),
  );
  check(
    "The new-teacher fields are validated by the same teacherCreateSchema as the Add teacher form",
    /teacherCreateSchema\.safeParse/.test(classActions) && /teacherCreateSchema\.safeParse/.test(teacherActions),
  );
  const actionStart = classActions.indexOf("export async function createClassWithNewTeacherAction");
  const newTeacherAction = classActions.slice(actionStart, classActions.indexOf("export async function updateClassAction"));
  check(
    "createClassWithNewTeacherAction needs both teacher.manage and class.manage, and is ONE data-layer call (no separate teacher + class writes)",
    /ctxCan\(scope\.ctx, "teacher\.manage"\)/.test(newTeacherAction) &&
      /classScope\(\)/.test(newTeacherAction) &&
      /createClassWithNewTeacher\(/.test(newTeacherAction) &&
      !/createTeacherMembership\(|createClassWithSessions\(/.test(newTeacherAction),
  );
  const engine = read("lib/db/class-sessions.ts");
  const withTeacher = engine.slice(engine.indexOf("export async function createClassWithNewTeacher"));
  check(
    "createClassWithNewTeacher runs the teacher and the class inside one $transaction, teacher first",
    /db\.\$transaction\(/.test(withTeacher) &&
      withTeacher.indexOf("addTeacherMembership(tx") < withTeacher.indexOf("writeClassWithSessions(") &&
      /options\.can\("teacher\.manage"\) \|\| !options\.can\("class\.manage"\)/.test(withTeacher),
  );
  check(
    "No second session-creation implementation: the class-creation path reuses the engine's resyncClassSessions",
    /resyncClassSessions\(/.test(engine.slice(engine.indexOf("async function writeClassWithSessions"), engine.indexOf("export async function createClassWithSessions"))),
  );
  check(
    "package.json and CI run check:class-creation",
    read("package.json").includes('"check:class-creation"') &&
      read(".github/workflows/ci.yml").includes("npm run check:class-creation"),
  );
}

// ── Pure rules ──────────────────────────────────────────────────────────────

function expectTime(input: string, expected: string, options?: Parameters<typeof parseTimeInput>[1]) {
  const result = parseTimeInput(input, options);
  check(
    `parseTimeInput(${JSON.stringify(input)}${options ? `, ${JSON.stringify(options)}` : ""}) → ${expected}`,
    result.ok && result.value === expected,
    JSON.stringify(result),
  );
}

function expectTimeError(input: string, error: "empty" | "invalid" | "outOfRange") {
  const result = parseTimeInput(input);
  check(
    `parseTimeInput(${JSON.stringify(input)}) is refused as ${error}`,
    !result.ok && result.error === error,
    JSON.stringify(result),
  );
}

function pureChecks() {
  console.log("\nTime parser (lib/time-input.ts)");
  // Every accepted shape.
  expectTime("16:30", "16:30");
  expectTime("04:30", "04:30");
  expectTime("4:30", "04:30");
  expectTime("4", "04:00");
  expectTime("4pm", "16:00");
  expectTime("4 PM", "16:00");
  expectTime("4:30 pm", "16:30");
  expectTime("4:30pm", "16:30");
  expectTime("4.30pm", "16:30");
  expectTime("4:30 p.m.", "16:30");
  expectTime("  4PM  ", "16:00");
  expectTime("11am", "11:00");
  expectTime("11pm", "23:00");
  expectTime("1am", "01:00");
  expectTime("13", "13:00");
  expectTime("17:45", "17:45");
  // 12-hour / 24-hour edge cases.
  expectTime("12am", "00:00");
  expectTime("12pm", "12:00");
  expectTime("12:30 am", "00:30");
  expectTime("12:30 pm", "12:30");
  expectTime("12", "12:00");
  expectTime("00:00", "00:00");
  expectTime("0:00", "00:00");
  expectTime("23:59", "23:59");
  expectTime("12:59 AM", "00:59");
  // Arabic-Indic digits and ص / م.
  expectTime("٤:٣٠ م", "16:30");
  expectTime("٤ ص", "04:00");
  expectTime("٤م", "16:00");
  expectTime("١٦:٣٠", "16:30");
  expectTime("٠٠:٠٠", "00:00");
  expectTime("١٢ ص", "00:00");
  expectTime("١٢ م", "12:00");
  expectTime("٤:٣٠ مساءً", "16:30");
  expectTime("٤:٣٠ صباحًا", "04:30");
  expectTime("۴:۳۰ م", "16:30"); // Extended Arabic-Indic (Persian) digits
  // A bare 12-hour-looking hour takes the meridiem of the value being edited.
  expectTime("4", "16:00", { defaultMeridiem: "PM" });
  expectTime("4", "04:00", { defaultMeridiem: "AM" });
  expectTime("4:30", "16:30", { defaultMeridiem: "PM" });
  expectTime("12", "12:00", { defaultMeridiem: "PM" });
  expectTime("12", "00:00", { defaultMeridiem: "AM" });
  expectTime("04:30", "04:30", { defaultMeridiem: "PM" }); // a leading zero is explicitly 24-hour
  expectTime("16", "16:00", { defaultMeridiem: "AM" }); // 13–23 can only be 24-hour
  // Refused, never coerced.
  expectTimeError("", "empty");
  expectTimeError("   ", "empty");
  expectTimeError("abc", "invalid");
  expectTimeError("pm", "invalid");
  expectTimeError("4:5", "invalid");
  expectTimeError("4:30:10", "invalid");
  expectTimeError("4 xm", "invalid");
  expectTimeError("-1", "invalid");
  expectTimeError("4:30 pm am", "invalid");
  expectTimeError("25", "outOfRange");
  expectTimeError("24:00", "outOfRange");
  expectTimeError("12:60", "outOfRange");
  expectTimeError("13pm", "outOfRange");
  expectTimeError("0am", "outOfRange");
  expectTimeError("0pm", "outOfRange");
  expectTimeError("٤:٦٠ م", "outOfRange");
  // Parts and arithmetic.
  const parts = (value: string) => JSON.stringify(timeParts(value));
  check("timeParts(00:00) is 12:00 AM", parts("00:00") === '{"hour12":12,"minute":0,"meridiem":"AM"}', parts("00:00"));
  check("timeParts(12:00) is 12:00 PM", parts("12:00") === '{"hour12":12,"minute":0,"meridiem":"PM"}', parts("12:00"));
  check("timeParts(16:30) is 4:30 PM", parts("16:30") === '{"hour12":4,"minute":30,"meridiem":"PM"}', parts("16:30"));
  check("timeParts(23:59) is 11:59 PM", parts("23:59") === '{"hour12":11,"minute":59,"meridiem":"PM"}', parts("23:59"));
  check("timeParts refuses a non-time", timeParts("4pm") === null && timeParts("24:00") === null);
  check(
    "fromTimeParts round-trips every minute of the day",
    Array.from({ length: 24 * 60 }, (_, minute) => minute).every((minute) => {
      const value = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const p = timeParts(value);
      return p !== null && fromTimeParts(p.hour12, p.minute, p.meridiem) === value;
    }),
  );
  check("A chosen start suggests start + 1 hour by default", suggestEndTime("16:00") === "17:00");
  check("…or start + the previous duration", suggestEndTime("17:00", 90) === "18:30" && minutesBetween("16:00", "18:00") === 120);
  check("…held inside the day (23:30 → 23:59), and nothing after 23:59", suggestEndTime("23:30") === "23:59" && suggestEndTime("23:59") === null);
  check("Arabic digits fold to ASCII", toAsciiDigits("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ab") === "01234567890123456789ab");

  console.log("\nSearchable picker (lib/picker-search.ts, via lib/phone.ts)");
  const people = [
    { label: "Ahmed Salem", phone: "01012345678" },
    { label: "أحمد سالم", phone: "01198765432" },
    { label: "Mona Adel", phone: null },
  ];
  const found = (query: string) => people.filter((p) => matchesPicker(query, p)).map((p) => p.label);
  const only = (query: string, ...expected: string[]) => {
    const got = found(query);
    check(`Picker "${query}" finds ${expected.length === 0 ? "nobody" : expected.join(" + ")}`, got.length === expected.length && expected.every((e) => got.includes(e)), got.join(", "));
  };
  only("", "Ahmed Salem", "أحمد سالم", "Mona Adel");
  only("ahm", "Ahmed Salem");
  only("AHMED", "Ahmed Salem");
  only("sal", "Ahmed Salem");
  only("salem ahmed", "Ahmed Salem");
  only("mona", "Mona Adel");
  only("سالم", "أحمد سالم");
  only("احمد", "أحمد سالم"); // a typed alef without hamza still finds it
  only("0101", "Ahmed Salem");
  only("01012345678", "Ahmed Salem");
  only("+201012345678", "Ahmed Salem");
  only("+20 101 234 5678", "Ahmed Salem");
  only("00201012345678", "Ahmed Salem");
  only("201012345678", "Ahmed Salem");
  only("1012345678", "Ahmed Salem");
  only("5678", "Ahmed Salem");
  only("٠١١٩٨", "أحمد سالم");
  only("+20 119", "أحمد سالم");
  only("ahmed 0101", "Ahmed Salem");
  only("ahmed 0119");
  only("mona 0101");
  only("zzz");
  check(
    "Phone search digits drop +20 / 0020 / 20 before a mobile prefix and nothing else",
    phoneSearchDigits("+20 100 123") === "100123" &&
      phoneSearchDigits("0020100") === "100" &&
      phoneSearchDigits("0100") === "0100" &&
      phoneSearchDigits("2034") === "2034" &&
      phoneSearchDigits("") === "",
  );
  check("A person with no phone never matches a phone query", !phoneMatchesQuery(null, "0100") && !phoneMatchesQuery("", "0100"));

  console.log("\nWeekly rows (lib/scheduling.ts weeklySlotsError + classSlotsSchema)");
  const row = (dayOfWeek: number, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime });
  check("A new class needs at least one row", weeklySlotsError([], { required: true })?.error === "slotsRequired");
  check("…an existing-class write may carry none", weeklySlotsError([], { required: false }) === null);
  check("A reversed range is refused", weeklySlotsError([row(1, "18:00", "16:00")], { required: true })?.error === "invalidTimeRange");
  check("An empty time is refused", weeklySlotsError([row(1, "", "16:00")], { required: true })?.error === "invalidTime");
  check("A weekday outside 0–6 is refused", weeklySlotsError([row(7, "16:00", "17:00")], { required: true })?.error === "invalidDay");
  const overlap = weeklySlotsError([row(6, "16:00", "18:00"), row(6, "17:00", "19:00")], { required: true });
  check("Two overlapping rows on one weekday are refused, naming the second", overlap?.error === "slotOverlap" && overlap.index === 1);
  check("Back-to-back rows on one weekday are fine (half-open)", weeklySlotsError([row(6, "16:00", "17:00"), row(6, "17:00", "18:00")], { required: true }) === null);
  check("The same hours on different weekdays are fine", weeklySlotsError([row(6, "16:00", "18:00"), row(0, "16:00", "18:00")], { required: true }) === null);
  const parseSlots = (value: unknown) => classSlotsSchema.safeParse(value);
  const ok = parseSlots(JSON.stringify([row(1, "16:00", "18:00"), row(3, "16:00", "18:00")]));
  check("The slots schema accepts two valid rows", ok.success && ok.data.length === 2);
  const missing = parseSlots(undefined);
  check("…refuses a missing field as slotsRequired", !missing.success && missing.error.issues[0]?.message === "slotsRequired");
  const empty = parseSlots("[]");
  check("…refuses an empty list as slotsRequired", !empty.success && empty.error.issues[0]?.message === "slotsRequired");
  const overlapping = parseSlots(JSON.stringify([row(1, "16:00", "18:00"), row(1, "17:00", "19:00")]));
  check("…refuses overlapping rows as slotOverlap", !overlapping.success && overlapping.error.issues[0]?.message === "slotOverlap");
  const garbage = parseSlots("not json");
  check("…refuses garbage without throwing", !garbage.success);
  const teacherSchema = teacherCreateSchema.safeParse({ locale: "en", firstName: "A", lastName: "B" });
  check("The new-teacher fields use the Add teacher schema: a name alone is refused (a phone or email is needed)", !teacherSchema.success);
}

// ── Database-backed checks ──────────────────────────────────────────────────

async function makeCenter(slug: string) {
  return prisma.center.create({
    data: {
      slug,
      name: slug,
      organization: { create: { name: slug } },
      settings: { create: { timezone: TZ, scheduleConflictPolicy: "WARN" } },
    },
  });
}

async function makeUser(tag: string, extra: { phone?: string; isPlatformAdmin?: boolean } = {}) {
  return prisma.user.create({
    data: {
      firstName: "U",
      lastName: tag,
      email: `${EMAIL_PREFIX}${tag}@kayedu.test`,
      locale: "en",
      ...(extra.phone ? { phone: extra.phone } : {}),
      ...(extra.isPlatformAdmin ? { isPlatformAdmin: true } : {}),
    },
  });
}

async function makeMember(centerId: string, tag: string, role: "TEACHER" | "OWNER", phone?: string) {
  const user = await makeUser(tag, { phone });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role, firstName: "M", lastName: tag, phone: phone ?? null, joinedAt: new Date() }),
  });
  return user;
}

const makeRoom = (centerId: string, name: string) =>
  prisma.room.create({ data: scopedData(centerId, { name, capacity: 20 }) });

const classFields = (roomId: string): Omit<ClassInput, "teacherId"> => ({
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
  startDate: START,
  endDate: END,
});

const TWO_SLOTS: ClassSlot[] = [
  { dayOfWeek: 1, startTime: "16:00", endTime: "18:00" },
  { dayOfWeek: 3, startTime: "16:00", endTime: "18:00" },
];

/** Every (date, start) the period asks for, computed independently of the engine. */
function expectedSessionKeys(slots: ClassSlot[]): string[] {
  const keys: string[] = [];
  for (let d = START; d.getTime() <= END.getTime(); d = addDays(d, 1)) {
    for (const slot of slots) {
      if (d.getUTCDay() !== slot.dayOfWeek) continue;
      // Today's 16:00 is still ahead at 12:00 Cairo, so it counts.
      keys.push(`${dateKey(d)}|${slot.startTime}`);
    }
  }
  return keys.sort();
}

type Allow = (permission: NewTeacherClassPermission) => boolean;
const allowAll: Allow = () => true;

function teacherDetails(tag: string, phone: string) {
  return { firstName: "New", lastName: tag, email: null, phone, altPhone: null, locale: "en" };
}

function newTeacherInput(
  tag: string,
  phone: string,
  roomId: string,
  slots: ClassSlot[] = TWO_SLOTS,
  linkUserId: string | null = null,
): NewTeacherClassInput {
  return { teacher: teacherDetails(tag, phone), linkUserId, class: classFields(roomId), slots };
}

function withTeacherOptions(actorUserId: string, confirmConflicts = false, can: Allow = allowAll) {
  return { confirmConflicts, actorUserId, now: NOW, locale: "en", can };
}

/** Everything a failed call must leave untouched. */
async function snapshot(centerId: string) {
  const [users, memberships, classes, schedules, sessions, audits] = await Promise.all([
    prisma.user.count(),
    prisma.membership.count({ where: { centerId } }),
    prisma.classGroup.count({ where: { centerId } }),
    prisma.classSchedule.count({ where: { centerId } }),
    prisma.session.count({ where: { centerId } }),
    prisma.auditLog.count({ where: { centerId } }),
  ]);
  return JSON.stringify({ users, memberships, classes, schedules, sessions, audits });
}

/** A property read straight off the real object, functions bound to it (a Prisma client is not proxy-safe). */
function passthrough(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
}

/** A client whose transactions throw when the engine inserts sessions — a forced engine failure. */
function failingEngine(): PrismaClient {
  const wrapTx = (tx: object) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === "session") {
          const session = Reflect.get(target, "session") as object;
          return new Proxy(session, {
            get(sessionTarget, method) {
              if (method === "createMany") {
                return async () => {
                  throw new Error("forced engine failure");
                };
              }
              return passthrough(sessionTarget, method);
            },
          });
        }
        return passthrough(target, prop);
      },
    });
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "$transaction") {
        return (fn: (tx: object) => unknown, options?: unknown) =>
          target.$transaction((tx) => fn(wrapTx(tx)) as Promise<unknown>, options as never);
      }
      return passthrough(target, prop);
    },
  }) as PrismaClient;
}

async function throws(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  staticChecks();
  pureChecks();

  await cleanup();
  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const A = centerA.id;
  const B = centerB.id;
  const actor = await makeUser("actor");
  const roomA1 = await makeRoom(A, "A Room 1");
  const roomA2 = await makeRoom(A, "A Room 2");
  const roomA3 = await makeRoom(A, "A Room 3");
  const roomA4 = await makeRoom(A, "A Room 4");
  const roomB1 = await makeRoom(B, "B Room 1");
  const existingTeacher = await makeMember(A, "teacher-existing", "TEACHER", `${PHONE_PREFIX}0003`);
  const forcedTeacher = await makeMember(A, "teacher-forced", "TEACHER");

  // ── 1. Class + schedule rows + every session, one transaction ─────────────
  console.log("\n1. A class with two weekly rows creates the class, its schedules and all its sessions in one step");
  const wanted = expectedSessionKeys(TWO_SLOTS);
  const created = await createClassWithSessions(
    prisma,
    A,
    { ...classFields(roomA1.id), teacherId: existingTeacher.id, slots: TWO_SLOTS },
    { confirmConflicts: false, actorUserId: actor.id, now: NOW },
  );
  check("createClassWithSessions accepts two rows", created.ok);
  if (created.ok) {
    const schedules = await prisma.classSchedule.findMany({ where: { classGroupId: created.classGroupId } });
    const sessions = await prisma.session.findMany({ where: { classGroupId: created.classGroupId } });
    const keys = sessions.map((s) => `${dateKey(s.date)}|${s.startTime}`).sort();
    check("Two ClassSchedule rows exist", schedules.length === 2);
    check(
      `Every session of the period exists — ${wanted.length} of them, on the right dates`,
      keys.length === wanted.length && keys.every((key, index) => key === wanted[index]),
      `${keys.length} vs ${wanted.length}`,
    );
    check("All of them copy the class's room, teacher and frozen price", sessions.every((s) => s.roomId === roomA1.id && s.teacherId === existingTeacher.id && s.priceSnapshot === 12_000));
    check(
      "One classGroup.create audit row records the class and its sessions",
      (await prisma.auditLog.count({ where: { centerId: A, action: "classGroup.create", entityId: created.classGroupId } })) === 1,
    );
  }

  // ── 2. Forced engine failure rolls everything back ────────────────────────
  console.log("\n2. A forced engine failure rolls back the class, its schedules and its sessions");
  const beforeEngineFailure = await snapshot(A);
  const failedExisting = await throws(() =>
    createClassWithSessions(
      failingEngine(),
      A,
      // A teacher and room nothing else uses, so only the injected failure can stop it.
      { ...classFields(roomA2.id), teacherId: forcedTeacher.id, slots: TWO_SLOTS },
      { confirmConflicts: false, actorUserId: actor.id, now: NOW },
    ),
  );
  check("The failure surfaces as an error", failedExisting);
  check("No class, schedule, session or audit row was left behind", (await snapshot(A)) === beforeEngineFailure);

  // ── 3. New teacher + class: atomic ────────────────────────────────────────
  console.log("\n3. A new teacher and the class are created together — or not at all");
  const beforeForced = await snapshot(A);
  const phoneForced = `${PHONE_PREFIX}1001`;
  const forced = await throws(() =>
    createClassWithNewTeacher(failingEngine(), A, newTeacherInput("forced", phoneForced, roomA2.id), withTeacherOptions(actor.id)),
  );
  check("A forced failure in the class step surfaces as an error", forced);
  check(
    "…and leaves ZERO User, Membership, class, schedule, session or audit rows from that call",
    (await snapshot(A)) === beforeForced && (await prisma.user.count({ where: { phone: phoneForced } })) === 0,
  );

  const phoneNew = `${PHONE_PREFIX}1002`;
  const beforeSuccess = await snapshot(A);
  const made = await createClassWithNewTeacher(prisma, A, newTeacherInput("fresh", phoneNew, roomA2.id), withTeacherOptions(actor.id));
  check("Success creates both", made.ok && made.teacherOutcome === "created");
  if (made.ok) {
    const user = await prisma.user.findUnique({ where: { id: made.teacherUserId } });
    const membership = await prisma.membership.findFirst({ where: { centerId: A, userId: made.teacherUserId, role: "TEACHER" } });
    const klass = await prisma.classGroup.findFirst({ where: { id: made.classGroupId, centerId: A } });
    const sessions = await prisma.session.count({ where: { classGroupId: made.classGroupId } });
    check("The new User is global and seeded with the typed phone", user?.phone === phoneNew && user?.firstName === "New");
    check("The teacher's centre record owns the local name and phone", membership?.firstName === "New" && membership?.lastName === "fresh" && membership?.phone === phoneNew && membership?.active === true);
    check("The class belongs to that teacher, in this centre", klass?.teacherId === made.teacherUserId && klass?.centerId === A);
    check("All the class's sessions exist, taught by the new teacher", sessions === wanted.length && (await prisma.session.count({ where: { classGroupId: made.classGroupId, teacherId: made.teacherUserId } })) === sessions);
    const afterSuccess = JSON.parse(await snapshot(A)) as Record<string, number>;
    const before = JSON.parse(beforeSuccess) as Record<string, number>;
    check(
      "Exactly one User, one Membership and one class were added",
      afterSuccess.users === before.users + 1 && afterSuccess.memberships === before.memberships + 1 && afterSuccess.classes === before.classes + 1 && afterSuccess.schedules === before.schedules + 2,
    );
    check(
      "Audit rows exist for BOTH entities (membership.create and classGroup.create)",
      (await prisma.auditLog.count({ where: { centerId: A, action: "membership.create", entityId: membership?.id ?? "-" } })) === 1 &&
        (await prisma.auditLog.count({ where: { centerId: A, action: "classGroup.create", entityId: made.classGroupId } })) === 1,
    );
    const teacherAudit = await prisma.auditLog.findFirst({ where: { centerId: A, action: "membership.create", entityId: membership?.id ?? "-" } });
    check("The teacher audit row records where it came from (class.create)", JSON.stringify(teacherAudit?.after).includes("class.create"));
  }

  // ── 4. A phone is not an identity key (SEC-2a, SEC-02 / D-02) ───────────────
  // Was: "A duplicate phone links, never creates" — the match came back and
  // "Use this person" linked Centre A to whoever held the phone. That was
  // SEC-02: no phone is verified, so a phone alone may never attach a record.
  console.log("\n4. A phone held by someone elsewhere is never a link — the new teacher is a new person");
  const otherCentrePerson = await makeMember(B, "teacher-elsewhere", "TEACHER", `${PHONE_PREFIX}0002`);
  const beforeMatch = await snapshot(A);
  const forcedLink = await createClassWithNewTeacher(
    prisma,
    A,
    newTeacherInput("dup", `${PHONE_PREFIX}0002`, roomA3.id, TWO_SLOTS, otherCentrePerson.id),
    withTeacherOptions(actor.id),
  );
  check(
    "Posting 'Use this person' for the phone's holder is refused (matchGone) and nothing is written",
    !forcedLink.ok && forcedLink.part === "teacher" && forcedLink.error === "matchGone" && (await snapshot(A)) === beforeMatch,
    JSON.stringify(forcedLink),
  );
  const createdNew = await createClassWithNewTeacher(prisma, A, newTeacherInput("dup", `${PHONE_PREFIX}0002`, roomA3.id), withTeacherOptions(actor.id));
  check(
    "Without a link it creates a NEW person — never the phone's holder",
    createdNew.ok && createdNew.teacherOutcome === "created" && createdNew.teacherUserId !== otherCentrePerson.id,
    JSON.stringify(createdNew),
  );
  if (createdNew.ok) {
    extraUserIds.push(createdNew.teacherUserId);
    const newPerson = await prisma.user.findUnique({ where: { id: createdNew.teacherUserId } });
    check("The new person does not take the held phone onto their global User", newPerson?.phone === null);
  }
  check("The phone's holder is still a teacher at Centre B only", (await prisma.membership.count({ where: { userId: otherCentrePerson.id, role: "TEACHER" } })) === 1);

  // ── 5. Already a teacher here → selectable instead ─────────────────────────
  console.log("\n5. Someone who already teaches here is not recreated");
  const beforeAlready = await snapshot(A);
  const already = await createClassWithNewTeacher(
    prisma,
    A,
    newTeacherInput("again", `${PHONE_PREFIX}0003`, roomA4.id, TWO_SLOTS, existingTeacher.id),
    withTeacherOptions(actor.id),
  );
  check(
    "Refused as alreadyTeacher, carrying who they are (so the form can select them instead)",
    !already.ok && already.part === "teacher" && already.error === "alreadyTeacher" && already.match?.userId === existingTeacher.id,
    JSON.stringify(already),
  );
  check("Nothing is written — no duplicate teacher, membership, class or session", (await snapshot(A)) === beforeAlready);

  // ── 6. A privileged / other-role phone is refused ─────────────────────────
  console.log("\n6. A staff or platform-admin phone is refused");
  const owner = await makeMember(A, "owner", "OWNER", `${PHONE_PREFIX}0004`);
  const admin = await makeUser("platform-admin", { phone: `${PHONE_PREFIX}0005`, isPlatformAdmin: true });
  const beforePrivileged = await snapshot(A);
  const staffTry = await createClassWithNewTeacher(prisma, A, newTeacherInput("boss", `${PHONE_PREFIX}0004`, roomA4.id, TWO_SLOTS, owner.id), withTeacherOptions(actor.id));
  check("An owner/manager/receptionist at this centre is refused (staffMember)", !staffTry.ok && staffTry.part === "teacher" && staffTry.error === "staffMember", JSON.stringify(staffTry));
  const staffNoLink = await createClassWithNewTeacher(prisma, A, newTeacherInput("boss", `${PHONE_PREFIX}0004`, roomA4.id), withTeacherOptions(actor.id));
  check("…refused up front, before the match is even offered", !staffNoLink.ok && staffNoLink.part === "teacher" && staffNoLink.error === "staffMember");
  const adminTry = await createClassWithNewTeacher(prisma, A, newTeacherInput("root", `${PHONE_PREFIX}0005`, roomA4.id, TWO_SLOTS, admin.id), withTeacherOptions(actor.id));
  check("A platform administrator is refused (privilegedPerson)", !adminTry.ok && adminTry.part === "teacher" && adminTry.error === "privilegedPerson", JSON.stringify(adminTry));
  check("Nothing was written by any of them", (await snapshot(A)) === beforePrivileged);

  // ── 7. Both matrix permissions ────────────────────────────────────────────
  console.log("\n7. Both teacher.manage and class.manage are required, by direct call");
  const beforePerm = await snapshot(A);
  const noTeacher = await createClassWithNewTeacher(prisma, A, newTeacherInput("perm1", `${PHONE_PREFIX}2001`, roomA4.id), withTeacherOptions(actor.id, false, (p) => p !== "teacher.manage"));
  const noClass = await createClassWithNewTeacher(prisma, A, newTeacherInput("perm2", `${PHONE_PREFIX}2002`, roomA4.id), withTeacherOptions(actor.id, false, (p) => p !== "class.manage"));
  const noneAllowed = await createClassWithNewTeacher(prisma, A, newTeacherInput("perm3", `${PHONE_PREFIX}2003`, roomA4.id), withTeacherOptions(actor.id, false, () => false));
  check("Without teacher.manage it is refused", !noTeacher.ok && noTeacher.part === "permission");
  check("Without class.manage it is refused", !noClass.ok && noClass.part === "permission");
  check("Without either it is refused", !noneAllowed.ok && noneAllowed.part === "permission");
  check("None of them wrote anything", (await snapshot(A)) === beforePerm);

  // ── 8. Conflicts: DENY refuses, WARN needs the confirmation ───────────────
  console.log("\n8. Conflicts keep R3/R4's contract — DENY refuses everything, WARN refuses until confirmed");
  const clash: ClassSlot[] = [{ dayOfWeek: 1, startTime: "17:00", endTime: "19:00" }];
  const preview = await previewNewClassSessions(prisma, A, { teacherId: null, roomId: roomA1.id, extraRoomIds: [], startDate: START, endDate: END, slots: clash }, { now: NOW, locale: "en" });
  check("The live preview lists the clash with Room 1's Monday classes (new teacher: rooms only)", preview.conflicts.length > 0 && preview.conflicts.every((c) => c.type === "room"), `${preview.conflicts.length}`);
  const previewClear = await previewNewClassSessions(prisma, A, { teacherId: null, roomId: roomA1.id, extraRoomIds: [], startDate: START, endDate: END, slots: [{ dayOfWeek: 2, startTime: "17:00", endTime: "19:00" }] }, { now: NOW, locale: "en" });
  check("…and nothing for a free slot", previewClear.conflicts.length === 0);
  const previewTeacher = await previewNewClassSessions(prisma, A, { teacherId: existingTeacher.id, roomId: roomA4.id, extraRoomIds: [], startDate: START, endDate: END, slots: clash }, { now: NOW, locale: "en" });
  check("…and flags an existing teacher who is already teaching then", previewTeacher.conflicts.some((c) => c.type === "teacher"));
  const previewIncomplete = await previewNewClassSessions(prisma, A, { teacherId: null, roomId: null, extraRoomIds: [], startDate: START, endDate: END, slots: clash }, { now: NOW, locale: "en" });
  check("…and previews nothing while a required part (the room) is missing", previewIncomplete.conflicts.length === 0 && previewIncomplete.created === 0);

  await prisma.centerSettings.update({ where: { centerId: A }, data: { scheduleConflictPolicy: "DENY" } });
  const beforeDeny = await snapshot(A);
  const denied = await createClassWithNewTeacher(prisma, A, newTeacherInput("deny", `${PHONE_PREFIX}3001`, roomA1.id, clash), withTeacherOptions(actor.id, true));
  check(
    "DENY refuses even a confirmed request, with the conflict list",
    !denied.ok && denied.part === "class" && denied.error === "conflict" && "conflicts" in denied && denied.conflicts.length > 0,
    JSON.stringify(denied).slice(0, 200),
  );
  check("…and NOTHING is written — no teacher, membership, user, class, session or audit row", (await snapshot(A)) === beforeDeny && (await prisma.user.count({ where: { phone: `${PHONE_PREFIX}3001` } })) === 0);

  await prisma.centerSettings.update({ where: { centerId: A }, data: { scheduleConflictPolicy: "WARN" } });
  const beforeWarn = await snapshot(A);
  const unconfirmed = await createClassWithNewTeacher(prisma, A, newTeacherInput("warn", `${PHONE_PREFIX}3002`, roomA1.id, clash), withTeacherOptions(actor.id, false));
  check(
    "WARN without confirmConflicts refuses WITH the list",
    !unconfirmed.ok && unconfirmed.part === "class" && unconfirmed.error === "conflictsNeedConfirmation" && "conflicts" in unconfirmed && unconfirmed.conflicts.length > 0,
    JSON.stringify(unconfirmed).slice(0, 200),
  );
  check("…and the teacher was not created either", (await snapshot(A)) === beforeWarn && (await prisma.user.count({ where: { phone: `${PHONE_PREFIX}3002` } })) === 0);
  const confirmed = await createClassWithNewTeacher(prisma, A, newTeacherInput("warn", `${PHONE_PREFIX}3002`, roomA1.id, clash), withTeacherOptions(actor.id, true));
  check("With confirmConflicts it saves the teacher and the class", confirmed.ok);
  if (confirmed.ok) {
    check(
      "…and audits the confirmed conflicts in the same write",
      (await prisma.auditLog.count({ where: { centerId: A, action: "schedule.conflict.confirm", entityId: confirmed.classGroupId } })) === 1,
    );
  }

  // ── 9. Overlapping rows are rejected ──────────────────────────────────────
  console.log("\n9. Overlapping and missing rows are rejected by the data layer");
  const overlapRows: ClassSlot[] = [
    { dayOfWeek: 6, startTime: "16:00", endTime: "18:00" },
    { dayOfWeek: 6, startTime: "17:00", endTime: "19:00" },
  ];
  const beforeOverlap = await snapshot(A);
  const overlapExisting = await createClassWithSessions(prisma, A, { ...classFields(roomA4.id), teacherId: existingTeacher.id, slots: overlapRows }, { confirmConflicts: true, actorUserId: actor.id, now: NOW });
  check("createClassWithSessions refuses overlapping rows (slotOverlap)", !overlapExisting.ok && overlapExisting.error === "slotOverlap");
  const overlapNew = await createClassWithNewTeacher(prisma, A, newTeacherInput("overlap", `${PHONE_PREFIX}4001`, roomA4.id, overlapRows), withTeacherOptions(actor.id, true));
  check("createClassWithNewTeacher refuses them too, before creating anyone", !overlapNew.ok && overlapNew.part === "class" && overlapNew.error === "slotOverlap");
  const noRows = await createClassWithNewTeacher(prisma, A, newTeacherInput("norows", `${PHONE_PREFIX}4002`, roomA4.id, []), withTeacherOptions(actor.id, true));
  check("A new class needs at least one row (slotsRequired)", !noRows.ok && noRows.part === "class" && noRows.error === "slotsRequired");
  check("Nothing was written by any of them", (await snapshot(A)) === beforeOverlap);

  // ── 10. Cross-centre isolation ────────────────────────────────────────────
  console.log("\n10. Cross-centre isolation");
  const beforeCross = await snapshot(A);
  const foreignRoom = await createClassWithNewTeacher(prisma, A, newTeacherInput("cross", `${PHONE_PREFIX}5001`, roomB1.id), withTeacherOptions(actor.id, true));
  check("Centre A cannot build a class on Centre B's room", !foreignRoom.ok && foreignRoom.part === "class" && foreignRoom.error === "roomNotFound", JSON.stringify(foreignRoom));
  check("…and nothing is written (no teacher for a class that cannot exist)", (await snapshot(A)) === beforeCross);
  if (made.ok) {
    check(
      "Centre B sees none of Centre A's new class, sessions or teacher membership",
      (await prisma.classGroup.count({ where: { id: made.classGroupId, centerId: B } })) === 0 &&
        (await prisma.session.count({ where: { classGroupId: made.classGroupId, centerId: B } })) === 0 &&
        (await prisma.membership.count({ where: { userId: made.teacherUserId, centerId: B } })) === 0,
    );
  }
  const previewCross = await previewNewClassSessions(prisma, B, { teacherId: null, roomId: roomA1.id, extraRoomIds: [], startDate: START, endDate: END, slots: clash }, { now: NOW, locale: "en" });
  check("Centre B's preview cannot use Centre A's room (nothing to check)", previewCross.conflicts.length === 0 && previewCross.created === 0);
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
      console.error(`\n${failures} class-creation check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll class-creation checks passed.");
  });

