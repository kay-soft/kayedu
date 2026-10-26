/**
 * Reception check — the R7 acceptance gate (docs/03-build-order.md "R7"):
 * the reception desk's session-first check-in, teacher names in every picker,
 * End session from a card, and a scanner that reads what a card encodes.
 *
 * Run with:  npm run check:reception
 *
 * Exercises the real production modules by direct call — the one parser
 * (`lib/id-card.ts`), the reception reads (`lib/db/reception.ts`), the shared
 * block rule and check-in helpers (`lib/db/attendance.ts`,
 * `lib/db/payments.ts`) and the close (`lib/db/session-lifecycle.ts`) —
 * against two throwaway centres whose student codes collide on purpose (both
 * start at 1001), with an injected clock in the centre's timezone. Plus a
 * static sweep of the page, the actions and the shared type-ahead. Needs a
 * reachable database; cleans up after itself (fixture centres and users only
 * — never a reset).
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { can, DEFAULT_ROLE_GRANTS, type PermissionGrants } from "../lib/auth/permissions.ts";
import {
  createAttendance,
  isStudentBlockedFromSession,
  SessionClosedError,
} from "../lib/db/attendance.ts";
import {
  createClassWithSessions,
  createOneOffSession,
  deactivateClass,
  type ClassInput,
  type ClassSlot,
} from "../lib/db/class-sessions.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../lib/db/payment-methods.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  loadReceptionSessions,
  openSessionsForStudent,
  recentCheckIns,
  resolveStudentInput,
  studentSessionState,
  validateReceptionSession,
  type ReceptionSessionCard,
} from "../lib/db/reception.ts";
import { closeSession } from "../lib/db/session-lifecycle.ts";
import { cancelSession } from "../lib/db/sessions.ts";
import { claimStudentCode } from "../lib/db/students.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import {
  centerIdsMatch,
  cleanScannedText,
  parseScannedStudentInput,
  parseStudentQrPayload,
  studentQrPayload,
} from "../lib/id-card.ts";
import { splitShare } from "../lib/money.ts";
import { dayMarker, todayInTimezone, zonedDateTimeToUtc } from "../lib/scheduling.ts";

const prisma = await gatePrisma();

const SLUG_A = "reception-check-a";
const SLUG_B = "reception-check-b";
const EMAIL_PREFIX = "reception-check-";
const TZ = "Africa/Cairo";

/** Monday 12 Oct 2026. Classes are created at 07:00 (before every slot below), checked at 12:00. */
const NOW_CREATE = zonedDateTimeToUtc("2026-10-12", 7 * 60, TZ);
const NOW = zonedDateTimeToUtc("2026-10-12", 12 * 60, TZ);
/** 00:30 Cairo on 12 Oct — still 11 Oct in UTC. */
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
    await deleteAuditRows(prisma, { centerId: { in: ids } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
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
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const norm = (file: string) => file.replace(/\\/g, "/");
const read = (file: string) => readFileSync(file, "utf8");

function staticChecks() {
  console.log("Static assertions (no database needed)");
  const receptionDir = "app/[locale]/(center)/reception";
  const receptionFiles = listFiles(receptionDir);
  const receptionSource = receptionFiles.map(read).join("\n");
  const page = read(`${receptionDir}/page.tsx`);
  const actions = read(`${receptionDir}/actions.ts`);
  const cards = read(`${receptionDir}/session-cards.tsx`);
  const endButton = read("app/[locale]/(center)/sessions/[id]/end-session-button.tsx");

  // One closing, one receipt.
  check(
    "The reception cards end a session with R2's EndSessionButton…",
    /import \{ EndSessionButton \} from "@\/app\/\[locale\]\/\(center\)\/sessions\/\[id\]\/end-session-button"/.test(cards) &&
      cards.includes("<EndSessionButton"),
  );
  check(
    "…which submits R2's endSessionAction (the reception desk has no close of its own)",
    /import \{ endSessionAction \} from "@\/app\/\[locale\]\/\(center\)\/sessions\/actions"/.test(endButton) &&
      endButton.includes("await endSessionAction("),
  );
  check(
    "Nothing under reception/ closes a session or writes a session row itself",
    !/\bcloseSession\(|\bcloseLockedSession\(|session\.update(Many)?\(|closedAt:\s*(new|now)/.test(receptionSource),
  );
  check(
    "The reception page renders R2's SessionReceipt (fed by loadSessionReceiptView) — no second receipt",
    /import \{ SessionReceipt \} from "@\/app\/\[locale\]\/\(center\)\/sessions\/\[id\]\/session-receipt"/.test(page) &&
      page.includes("loadSessionReceiptView(") &&
      page.includes("<SessionReceipt") &&
      !/function SessionReceipt\b|sessionReceiptTotals\(/.test(receptionSource),
  );
  check(
    "The receipt's Print is R2's staff print route",
    page.includes("ROUTES.centerSessionPrint(receiptCard.id)"),
  );
  check(
    "endSessionAction still re-checks session.close server-side (R2) and the card hides End without it",
    /export async function endSessionAction[\s\S]*?ctxCan\(ctx, "session\.close"\)/.test(
      read("app/[locale]/(center)/sessions/actions.ts"),
    ) && page.includes('end: ctxCan(ctx, "session.close")'),
  );

  // One parser.
  const appFiles = [...listFiles("app"), ...listFiles("lib"), ...listFiles("components")];
  const mentionsPayload = appFiles.filter((file) => /KAYEDU\|/.test(read(file)));
  check(
    "Only lib/id-card.ts knows the QR payload format",
    mentionsPayload.length === 1 && norm(mentionsPayload[0]).endsWith("lib/id-card.ts"),
    mentionsPayload.map(norm).join(", "),
  );
  const splitters = appFiles.filter(
    (file) => !norm(file).endsWith("lib/id-card.ts") && /\.split\(\s*["']\|["']\s*\)/.test(read(file)),
  );
  check("Nobody else splits a scanned string on '|'", splitters.length === 0, splitters.map(norm).join(", "));
  const parserUsers = appFiles
    .filter((file) =>
      /import\s*(type\s*)?\{[^}]*\b(parseStudentQrPayload|parseScannedStudentInput)\b[^}]*\}\s*from/.test(read(file)),
    )
    .map(norm)
    .filter((file) => !file.endsWith("lib/id-card.ts"));
  check(
    "The parsers are called only by the reception page and lib/db/reception.ts",
    parserUsers.length === 2 &&
      parserUsers.some((file) => file.endsWith("reception/page.tsx")) &&
      parserUsers.some((file) => file.endsWith("lib/db/reception.ts")),
    parserUsers.join(", "),
  );

  // Money and rules stay where they were.
  check(
    "The reception actions record money only through lib/db/payments.ts (no lib/money, no inline split)",
    actions.includes('from "@/lib/db/payments"') &&
      actions.includes("recordPayment(tx, centerId, attendee.id, paymentMethodId, ctx.user.id)") &&
      !/lib\/money|splitShare|centerShare\s*[=:+*\-/]|teacherShare\s*[=:+*\-/]/.test(
        actions.replace(/centerShareSnapshot|teacherShareSnapshot/g, ""),
      ),
  );
  check(
    "The reception check-in refuses a blocked student (shared rule) and re-validates the session",
    actions.includes("isStudentBlockedFromSession(prisma, centerId, session, student.userId)") &&
      actions.includes("validateReceptionSession(prisma"),
  );
  check(
    "The session-mode resolvers are read-only (no attendance or payment write)",
    !/export async function resolveReception\w+[\s\S]*?(createAttendance|recordPayment|\.create\()/.test(
      actions.slice(actions.indexOf("export async function resolveReceptionInputAction"), actions.indexOf("export async function checkInAction")),
    ),
  );
  check(
    "Sessions' own add-attendee actions use the same block rule (one implementation)",
    read("app/[locale]/(center)/sessions/actions.ts").includes("isStudentBlockedFromSession(prisma, ctx.center.id, session, student.userId)") &&
      !/function isBlockedFromSession\b/.test(read("app/[locale]/(center)/sessions/actions.ts")),
  );

  // Scanner contract in the shared type-ahead.
  const typeAhead = read("components/center/type-ahead-search.tsx");
  check(
    "A submit reads the input element's own value, not React state or a debounced copy",
    /const submitted = inputRef\.current\?\.value \?\? query;/.test(typeAhead) &&
      /onSubmitValue\(submitted\)/.test(typeAhead),
  );
  check(
    "A submit cancels the pending debounce and any in-flight search",
    /function cancelPending\(\)[\s\S]*?clearTimeout\(timerRef\.current\)[\s\S]*?requestId\.current \+= 1/.test(typeAhead) &&
      /function onSubmit\([\s\S]*?cancelPending\(\)/.test(typeAhead),
  );
  check(
    "Enter selects a suggestion only after arrow-key highlight — hover never arms it, typing clears it",
    !/onMouseEnter=\{\(\) => setActiveIndex/.test(typeAhead) &&
      /onChange=\{\(event\) => \{[\s\S]*?setActiveIndex\(-1\)/.test(typeAhead) &&
      /event\.key === "Enter" && activeIndex >= 0/.test(typeAhead),
  );
  check(
    "Without session mode the search stays a plain GET form (no JavaScript needed to scan)",
    /if \(onSubmitValue\) \{\s*event\.preventDefault\(\);/.test(typeAhead),
  );

  // T2 — the type-ahead keeps a pick picked, and the desk can be cleared.
  check(
    "A pick records the text it was made for, and the search effect stands down for exactly that text",
    /function select\([\s\S]*?settledQuery\.current = inputRef\.current\?\.value \?\? query;/.test(typeAhead) &&
      /if \(settledQuery\.current === query\) return;/.test(typeAhead),
  );
  check(
    "Refocus and a late search result cannot reopen the panel for settled text; typing is what lets it open again",
    /onFocus=\{\(\) => \{\s*if \(results\.length > 0 && settledQuery\.current !== query\) setOpen\(true\);/.test(typeAhead) &&
      /requestId\.current !== id \|\| settledQuery\.current === query/.test(typeAhead) &&
      /onChange=\{\(event\) => \{\s*settledQuery\.current = null;/.test(typeAhead),
  );
  check(
    "Text handed over by the URL on load counts as settled (no dropdown on arrival)",
    /useRef<string \| null>\(value \? value : null\)/.test(typeAhead),
  );
  check(
    "onClear adds a clear (X) control and Escape-with-no-list-open calls it; the scanner submit path is untouched",
    /event\.key === "Escape" && onClear && !\(open && results\.length > 0\)/.test(typeAhead) &&
      typeAhead.includes("onClick={clearSelection}"),
  );
  const receptionSearch = read(`${receptionDir}/reception-search.tsx`);
  check(
    "Plain mode: the desk's clear returns to the bare desk, and the field is the shared type-ahead with no onSubmitValue (plain GET form)",
    receptionSearch.includes("router.push(ROUTES.centerReception)") &&
      receptionSearch.includes("onClear={hasSelection ? clearDesk : undefined}") &&
      !receptionSearch.includes("onSubmitValue") &&
      page.includes("<ReceptionSearch") &&
      page.includes("hasSelection={selectedStudent !== null}"),
  );
  const sessionMode = read(`${receptionDir}/session-check-in.tsx`);
  check(
    "Session mode: clear drops the panel and any answer in flight without leaving the session (no navigation)",
    sessionMode.includes("onClear={") &&
      /const clearDesk = useCallback\(\(\) => \{\s*latest\.current \+= 1;\s*setPanel\(\{ kind: "idle" \}\);/.test(sessionMode) &&
      !/router\.|useRouter|ROUTES\./.test(sessionMode),
  );

  // T2 — the session page is confirm-then-write through reception's own function.
  const sessionDir = "app/[locale]/(center)/sessions/[id]";
  const panelSource = read("components/center/check-in-confirm-panel.tsx");
  const provider = read(`${sessionDir}/session-check-in-provider.tsx`);
  const roster = read(`${sessionDir}/session-roster.tsx`);
  const addPanel = read(`${sessionDir}/add-attendee-panel.tsx`);
  const addSearch = read(`${sessionDir}/add-attendee-search.tsx`);
  const sessionActions = read("app/[locale]/(center)/sessions/actions.ts");
  check(
    "One confirm panel, one write: checkInAction is called by the shared panel and by nothing else in the UI",
    panelSource.includes('import { checkInAction } from "@/app/[locale]/(center)/reception/actions"') &&
      panelSource.includes("await checkInAction(") &&
      [...listFiles("app"), ...listFiles("components")]
        .filter((file) => /\.tsx$/.test(file) && !norm(file).endsWith("components/center/check-in-confirm-panel.tsx"))
        .filter((file) => /checkInAction/.test(read(file)) && !/(checkin-form|\/reception\/actions)/.test(norm(file)))
        .length === 0,
  );
  check(
    "Reception's session mode and the session page both render CheckInConfirmPanel (no second panel)",
    sessionMode.includes("<CheckInConfirmPanel") && provider.includes("<CheckInConfirmPanel"),
  );
  check(
    "The roster's Check in button, the add-attendee pick and a candidate row only open the panel — no form, no action import",
    roster.includes("requestCheckIn({") &&
      !/checkInRosterAction|addExistingAttendeeAction/.test(roster + addPanel + addSearch + provider) &&
      !/checkInAction/.test(roster + addPanel + addSearch) &&
      addSearch.includes("onSelect={pick}") &&
      addPanel.includes("requestCheckIn({"),
  );
  check(
    "The old attendance-only paths are gone: no checkInRosterAction / addExistingAttendeeAction, no unconfirmed write on the session page",
    !/export async function (checkInRosterAction|addExistingAttendeeAction)/.test(sessionActions),
  );
  check(
    "Cancelling stores nothing: the provider holds the pick in React state only (no storage, no cookie, no action)",
    !/localStorage|sessionStorage|document\.cookie|"use server"/.test(provider + panelSource),
  );

  // Wiring.
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  check("package.json wires check:reception", (pkg.scripts["check:reception"] ?? "").includes("scripts/reception-check.ts"));
  const ci = existsSync(".github/workflows/ci.yml") ? read(".github/workflows/ci.yml") : "";
  check("CI runs check:reception", ci.includes("check:reception"));
}

// ── The parser (pure) ───────────────────────────────────────────────────────

function parserChecks() {
  console.log("\nThe scan parser (pure) — one parser, lib/id-card.ts");
  const center = "9f1c7a52-3d0e-4b8a-8a47-1c2b3d4e5f60";
  const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const payload = studentQrPayload(center, "1001");

  const read1 = parseScannedStudentInput(payload);
  check(
    "The full payload parses to its centre and code",
    read1.kind === "payload" && read1.centerId === center && read1.studentCode === "1001",
  );
  check(
    "parseStudentQrPayload (the strict reader) agrees",
    JSON.stringify(parseStudentQrPayload(payload)) === JSON.stringify({ centerId: center, studentCode: "1001" }),
  );
  check(
    "A bare numeric code is a code, not a payload — and the strict reader still refuses it",
    JSON.stringify(parseScannedStudentInput("1001")) === JSON.stringify({ kind: "code", studentCode: "1001" }) &&
      parseStudentQrPayload("1001") === null,
  );
  check(
    "Whitespace, CR/LF/TAB and a trailing Enter are noise (the scanner's suffix)",
    JSON.stringify(parseScannedStudentInput(`  1001\r\n`)) === JSON.stringify({ kind: "code", studentCode: "1001" }) &&
      parseStudentQrPayload(`${payload}\r`)?.studentCode === "1001" &&
      parseStudentQrPayload(`\t${payload}\t\n`)?.centerId === center,
  );
  check(
    "A scanner prefix/suffix (AIM id ']Q1', STX/ETX, a custom tag) is noise",
    parseStudentQrPayload(`]Q1${payload}`)?.studentCode === "1001" &&
      parseStudentQrPayload(`\u0002${payload}\u0003`)?.studentCode === "1001" &&
      parseStudentQrPayload(`##${payload}\r\n`)?.studentCode === "1001" &&
      parseStudentQrPayload(`${payload};\r`)?.studentCode === "1001",
  );
  check(
    "Invisible characters (zero-width, bidi marks, BOM) are stripped",
    parseStudentQrPayload(`﻿‏${payload}​`)?.studentCode === "1001" &&
      cleanScannedText("‪10​01‬") === "1001",
  );
  check(
    "Arabic-Indic and Persian digits are folded (lib/digits.ts)",
    JSON.stringify(parseScannedStudentInput("١٠٠١")) === JSON.stringify({ kind: "code", studentCode: "1001" }) &&
      JSON.stringify(parseScannedStudentInput("۱۰۰۱")) === JSON.stringify({ kind: "code", studentCode: "1001" }) &&
      parseStudentQrPayload(`KAYEDU|${center}|١٠٠١`)?.studentCode === "1001",
  );
  check(
    "Full-width characters are folded (ＫＡＹＥＤＵ｜…｜１００１)",
    parseStudentQrPayload(`ＫＡＹＥＤＵ｜${center}｜１００１`)?.studentCode === "1001" &&
      JSON.stringify(parseScannedStudentInput("１００１")) === JSON.stringify({ kind: "code", studentCode: "1001" }),
  );
  check(
    "The prefix and the centre id are case-insensitive",
    parseStudentQrPayload(`kayedu|${center.toUpperCase()}|1001`)?.studentCode === "1001" &&
      centerIdsMatch(center.toUpperCase(), center) &&
      !centerIdsMatch(other, center),
  );
  const foreign = parseScannedStudentInput(studentQrPayload(other, "1001"));
  check(
    "Another centre's payload still parses, with ITS centre id — so the caller can refuse it",
    foreign.kind === "payload" && !centerIdsMatch(foreign.centerId, center),
  );
  check(
    "Garbage is never a student reference",
    parseScannedStudentInput("").kind === "empty" &&
      parseScannedStudentInput("  \r\n").kind === "empty" &&
      parseScannedStudentInput("KAYEDU|only").kind === "text" &&
      parseScannedStudentInput(`KAYEDU|${center}|`).kind === "text" &&
      parseScannedStudentInput("hello world").kind === "text" &&
      parseStudentQrPayload("hello|world|1") === null &&
      parseStudentQrPayload("KAYEDU|a b|1001") === null,
  );
  check(
    "A name or phone fragment is searched as text (digits with letters, a phone with a plus)",
    JSON.stringify(parseScannedStudentInput("Mona  Hassan")) === JSON.stringify({ kind: "text", text: "Mona Hassan" }) &&
      parseScannedStudentInput("+20 101 234 5678").kind === "text",
  );

  // Keyboard layout: what a scanner sends under an Arabic layout.
  const garbled = "نشغثيع|ثحخ-خثخ|1001";
  check(
    "Arabic keyboard layout: a payload whose letters arrived as Arabic letters is reported unreadable (never guessed)",
    parseScannedStudentInput(garbled).kind === "unreadable" && parseStudentQrPayload(garbled) === null,
  );
  check(
    "Arabic keyboard layout: a digits-only scan survives (ASCII or Arabic-Indic digits)",
    parseScannedStudentInput("1001\n").kind === "code" && parseScannedStudentInput("١٠٠١\n").kind === "code",
  );

  // A handheld burst: every character as its own keystroke, then Enter.
  let typed = "";
  for (const char of `${payload}\r`) typed += char;
  check(
    "A handheld burst (fast characters + Enter) resolves to the right reference",
    (() => {
      const result = parseScannedStudentInput(typed);
      return result.kind === "payload" && result.centerId === center && result.studentCode === "1001";
    })(),
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

async function makeUser(tag: string, first = "Global", last = tag) {
  return prisma.user.create({
    data: { firstName: first, lastName: last, email: `${EMAIL_PREFIX}${tag}@kayedu.test`, locale: "en" },
  });
}

/** A teacher whose centre-local name is NOT the global one. */
async function makeTeacher(centerId: string, tag: string, localFirst: string, localLast: string) {
  const user = await makeUser(tag);
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role: "TEACHER", firstName: localFirst, lastName: localLast, joinedAt: new Date() }),
  });
  return user;
}

async function makeStudent(centerId: string, tag: string, first: string, last: string, active = true) {
  const user = await makeUser(tag);
  const studentCode = await prisma.$transaction((tx) => claimStudentCode(tx, centerId));
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode, firstName: first, lastName: last, active }),
  });
  return { user, profile };
}

async function makeRoom(centerId: string, name: string) {
  return prisma.room.create({ data: scopedData(centerId, { name, capacity: 30 }) });
}

function classInput(teacherId: string, roomId: string): ClassInput {
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
    startDate: day("2026-10-12"),
    endDate: day("2026-10-31"),
  };
}

async function createClass(centerId: string, teacherId: string, roomId: string, slots: ClassSlot[]) {
  const result = await createClassWithSessions(
    prisma,
    centerId,
    { ...classInput(teacherId, roomId), slots },
    { confirmConflicts: true, now: NOW_CREATE },
  );
  if (!result.ok) throw new Error(`fixture class refused: ${JSON.stringify(result)}`);
  return result.classGroupId;
}

/** The (single) session of a class on a date. */
async function sessionOf(classGroupId: string, date: string) {
  return prisma.session.findFirstOrThrow({ where: { classGroupId, date: day(date) } });
}

async function enroll(centerId: string, studentProfileId: string, classGroupId: string) {
  // Enrolled before the session day: an absence is only written for someone enrolled by then (R2).
  await prisma.enrollment.create({
    data: scopedData(centerId, { studentProfileId, classGroupId, status: "ACTIVE", enrolledAt: day("2026-10-01") }),
  });
}

async function methodId(centerId: string) {
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
  const id = await methodId(centerId);
  return prisma.$transaction((tx) => recordPayment(tx, centerId, attendeeId, id, "check", { now }));
}

function grantsFor(role: keyof typeof DEFAULT_ROLE_GRANTS): PermissionGrants {
  return Object.fromEntries(DEFAULT_ROLE_GRANTS[role].map((action) => [action, true]));
}

const ALL: { checkIn: boolean; end: boolean } = { checkIn: true, end: true };

// ── Database-backed checks ──────────────────────────────────────────────────

async function main() {
  staticChecks();
  parserChecks();

  await cleanup();
  console.log("\nDatabase-backed checks");

  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const A = centerA.id;
  const B = centerB.id;

  // Teachers carry a centre-local name that differs from the global one.
  const t1 = await makeTeacher(A, "t1", "Hala", "Teacher-One");
  const t2 = await makeTeacher(A, "t2", "Omar", "Teacher-Two");
  const t3 = await makeTeacher(A, "t3", "Nour", "Teacher-Three");
  const t4 = await makeTeacher(A, "t4", "Sara", "Teacher-Four");
  const t5 = await makeTeacher(A, "t5", "Karim", "Teacher-Five");
  const tB = await makeTeacher(B, "tb", "Bassem", "Teacher-B");
  const rooms = await Promise.all(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"].map((name) => makeRoom(A, name)));
  const roomB = await makeRoom(B, "RB");

  // Classes (created at 07:00, before every slot, so today's sessions exist).
  const C1 = await createClass(A, t1.id, rooms[0].id, [
    { dayOfWeek: 1, startTime: "11:00", endTime: "12:00" },
    { dayOfWeek: 3, startTime: "11:00", endTime: "12:00" },
  ]);
  const C2 = await createClass(A, t2.id, rooms[1].id, [{ dayOfWeek: 1, startTime: "16:00", endTime: "17:00" }]);
  const C4 = await createClass(A, t4.id, rooms[2].id, [{ dayOfWeek: 1, startTime: "08:00", endTime: "09:00" }]);
  const C5 = await createClass(A, t5.id, rooms[3].id, [{ dayOfWeek: 1, startTime: "09:00", endTime: "10:00" }]);
  const C6 = await createClass(A, t3.id, rooms[4].id, [{ dayOfWeek: 1, startTime: "17:00", endTime: "18:00" }]);
  const C7 = await createClass(A, t3.id, rooms[5].id, [{ dayOfWeek: 1, startTime: "18:30", endTime: "19:30" }]);
  const CB = await createClass(B, tB.id, roomB.id, [{ dayOfWeek: 1, startTime: "11:00", endTime: "12:00" }]);

  const S_live = await sessionOf(C1, "2026-10-12");
  const S_wed = await sessionOf(C1, "2026-10-14");
  const S_up = await sessionOf(C2, "2026-10-12");
  const S_inactive = await sessionOf(C4, "2026-10-12");
  const S_closed = await sessionOf(C5, "2026-10-12");
  const S_cancel = await sessionOf(C6, "2026-10-12");
  const S_resched = await sessionOf(C7, "2026-10-12");
  const S_B = await sessionOf(CB, "2026-10-12");

  // A one-time session today (title only — no class).
  const oneOff = await createOneOffSession(
    prisma,
    A,
    {
      teacherId: t3.id,
      roomId: rooms[6].id,
      extraRoomIds: [],
      date: day("2026-10-12"),
      startTime: "14:00",
      endTime: "15:00",
      title: "Revision day",
      subjectId: null,
      gradeId: null,
      price: 20_000,
      centerShareType: "FIXED",
      centerShareValue: 5_000,
    },
    { confirmConflicts: true, now: NOW_CREATE },
  );
  if (!oneOff.ok) throw new Error(`fixture one-time session refused: ${JSON.stringify(oneOff)}`);
  const S_one = oneOff.sessionId;

  // Lifecycle states the reception query must filter.
  await cancelSession(prisma, A, S_cancel.id, { now: NOW_CREATE });
  await prisma.session.update({ where: { id: S_resched.id }, data: { rescheduledToId: S_wed.id } });
  await deactivateClass(prisma, A, C4, { now: NOW });

  // Students: A and B each start at 1001 — the collision is the point.
  const sMona = await makeStudent(A, "mona", "Mona", "Hassan");
  const sAli = await makeStudent(A, "ali", "Ali", "Mahmoud");
  const sNada = await makeStudent(A, "nada", "Nada", "Youssef");
  const sBlockedTeacher = await makeStudent(A, "bt", "Tamer", "Blocked");
  const sBlockedClass = await makeStudent(A, "bc", "Cora", "Blocked");
  const sDropIn = await makeStudent(A, "dropin", "Drew", "Dropin");
  const sInactive = await makeStudent(A, "off", "Ines", "Inactive", false);
  const sAbsent = await makeStudent(A, "abs", "Abdo", "Absentee");
  const sB = await makeStudent(B, "sb", "Bella", "OtherBranch");
  const sB2 = await makeStudent(B, "sb2", "Boris", "OtherBranch");
  check(
    "Fixture: both centres' first student code is 1001 (a bare code is ambiguous across centres)",
    sMona.profile.studentCode === "1001" && sB.profile.studentCode === "1001" && sB2.profile.studentCode === "1002",
  );
  await enroll(A, sMona.profile.id, C1);
  await enroll(A, sAli.profile.id, C1);
  await enroll(A, sAli.profile.id, C2);
  await enroll(A, sNada.profile.id, C5);
  await enroll(A, sAbsent.profile.id, C5);
  await enroll(A, sBlockedClass.profile.id, C2);

  const cardsAt = (now: Date, permissions = ALL, db = prisma) =>
    loadReceptionSessions(db, { centerId: A, locale: "en", timeZone: TZ, now, permissions });
  const byId = (cards: ReceptionSessionCard[]) => new Map(cards.map((card) => [card.id, card]));

  // ── 1. The reception query ───────────────────────────────────────────────
  console.log("\n1. Today's sessions — one query, centre-scoped");
  const staff = await makeUser("staff");
  await checkIn(A, S_closed.id, sNada.profile.id, at("09:05"), null);
  const m1 = await checkIn(A, S_live.id, sMona.profile.id, at("11:05"));
  const aliRow = await checkIn(A, S_live.id, sAli.profile.id, at("11:20"));
  check("Fixture: 11:05 is Present and 11:20 is Late (threshold 10) — decided automatically", m1.attendanceStatus === "PRESENT" && aliRow.attendanceStatus === "LATE");
  const closeResult = await closeSession(prisma, A, S_closed.id, { closedBy: staff.id, now: NOW });
  check(
    "Fixture: the 09:00 session was ended by staff (its enrolled no-show is now an ABSENT row)",
    closeResult.ok && (await prisma.sessionAttendee.count({ where: { sessionId: S_closed.id, attendanceStatus: "ABSENT" } })) === 1,
    JSON.stringify(closeResult),
  );

  const cards = await cardsAt(NOW);
  const map = byId(cards);
  const ids = new Set(cards.map((card) => card.id));
  check(
    "It returns exactly today's live, upcoming, ended and one-time sessions",
    cards.length === 4 && ids.has(S_live.id) && ids.has(S_up.id) && ids.has(S_closed.id) && ids.has(S_one),
    cards.map((card) => card.label).join(", "),
  );
  check(
    "…excluding cancelled, rescheduled, deactivated-class and another centre's sessions",
    !ids.has(S_cancel.id) && !ids.has(S_resched.id) && !ids.has(S_inactive.id) && !ids.has(S_B.id),
  );
  check(
    "The deactivated class's session really exists (the exclusion is the filter, not a missing row)",
    (await prisma.session.count({ where: { id: S_inactive.id } })) === 1,
  );
  check(
    "Order: Live, then upcoming by start time, then ended last",
    cards.map((card) => card.id).join() === [S_live.id, S_one, S_up.id, S_closed.id].join(),
    cards.map((card) => `${card.displayStatus}@${card.startTime}`).join(", "),
  );
  check(
    "Teacher names are the centre-local membership names, not the global ones",
    map.get(S_live.id)?.teacherName === "Hala Teacher-One" &&
      map.get(S_up.id)?.teacherName === "Omar Teacher-Two" &&
      map.get(S_one)?.teacherName === "Nour Teacher-Three",
    cards.map((card) => card.teacherName).join(", "),
  );
  check(
    "A one-time session is labelled by its own title",
    map.get(S_one)?.label === "Revision day" && map.get(S_one)?.kind === "oneOff",
  );
  check(
    "The checked-in count is Present + Late only (an ABSENT row is not counted)",
    map.get(S_live.id)?.checkedIn === 2 &&
      map.get(S_closed.id)?.checkedIn === 1 &&
      (await prisma.sessionAttendee.count({ where: { sessionId: S_closed.id } })) === 2 &&
      map.get(S_up.id)?.checkedIn === 0,
    JSON.stringify(cards.map((card) => card.checkedIn)),
  );
  check(
    "Status, flags and the session price come straight from the data",
    map.get(S_live.id)?.displayStatus === "LIVE" &&
      map.get(S_up.id)?.displayStatus === "SCHEDULED" &&
      map.get(S_closed.id)?.displayStatus === "COMPLETED" &&
      map.get(S_closed.id)?.autoClosed === false &&
      map.get(S_live.id)?.price === 12_000 &&
      map.get(S_one)?.price === 20_000 &&
      map.get(S_live.id)?.rooms.join() === "R1",
  );
  check(
    "End session: enabled on a live session, disabled before it starts, hidden once closed",
    map.get(S_live.id)?.end === "enabled" && map.get(S_up.id)?.end === "disabled" && map.get(S_one)?.end === "disabled" && map.get(S_closed.id)?.end === "hidden",
  );
  check(
    "A closed session offers View receipt and no check-in; the open ones offer check-in and no receipt",
    map.get(S_closed.id)?.canViewReceipt === true &&
      map.get(S_closed.id)?.acceptsCheckIn === false &&
      map.get(S_closed.id)?.canAttend === false &&
      map.get(S_live.id)?.canAttend === true &&
      map.get(S_live.id)?.canViewReceipt === false,
  );
  const noEnd = byId(await cardsAt(NOW, { checkIn: true, end: false }));
  const noCheckIn = byId(await cardsAt(NOW, { checkIn: false, end: true }));
  check(
    "Without session.close the End control is hidden everywhere; without attendance.record no card offers Start attending",
    [...noEnd.values()].every((card) => card.end === "hidden") &&
      [...noCheckIn.values()].every((card) => card.canAttend === false) &&
      noCheckIn.get(S_live.id)?.end === "enabled",
  );
  check(
    "Defaults: a receptionist holds session.close, attendance.record and reception.use; an accountant does not hold session.close",
    can("RECEPTIONIST", "session.close", grantsFor("RECEPTIONIST")) &&
      can("RECEPTIONIST", "attendance.record", grantsFor("RECEPTIONIST")) &&
      can("RECEPTIONIST", "reception.use", grantsFor("RECEPTIONIST")) &&
      !can("ACCOUNTANT", "session.close", grantsFor("ACCOUNTANT")) &&
      !can("RECEPTIONIST", "session.close", {}),
  );
  check(
    "Another centre's reception list is its own",
    (await loadReceptionSessions(prisma, { centerId: B, locale: "en", timeZone: TZ, now: NOW, permissions: ALL })).map((card) => card.id).join() === S_B.id,
  );
  check(
    "'Today' is the centre's day: at 00:30 Cairo (still 11 Oct in UTC) the 12 Oct sessions are today",
    todayInTimezone(TZ, NOW_EARLY).toISOString() === day("2026-10-12").toISOString() &&
      (await cardsAt(NOW_EARLY)).length >= 3,
  );

  // No N+1: the statement count does not grow with the number of sessions.
  const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  let statements = 0;
  logged.$on("query", () => {
    statements += 1;
  });
  await cardsAt(NOW, ALL, logged as unknown as PrismaClient);
  const before = statements;
  for (const [i, teacher] of [t1, t2, t4].entries()) {
    const extra = await createOneOffSession(
      prisma,
      A,
      {
        teacherId: teacher.id,
        roomId: rooms[7].id,
        extraRoomIds: [],
        date: day("2026-10-12"),
        startTime: `${19 + i}:00`.padStart(5, "0"),
        endTime: `${19 + i}:45`.padStart(5, "0"),
        title: `Extra ${i}`,
        subjectId: null,
        gradeId: null,
        price: 10_000,
        centerShareType: "FIXED",
        centerShareValue: 1_000,
      },
      { confirmConflicts: true, now: NOW_CREATE },
    );
    if (!extra.ok) throw new Error(`fixture refused: ${JSON.stringify(extra)}`);
  }
  statements = 0;
  const grown = await cardsAt(NOW, ALL, logged as unknown as PrismaClient);
  await logged.$disconnect();
  check(
    "No N+1: with three more sessions and teachers the same number of statements runs",
    grown.length === 7 && statements === before && before <= 16,
    `before=${before} after=${statements} cards=${grown.length}`,
  );

  // ── 2. Session mode: the id in the URL is untrusted ──────────────────────
  console.log("\n2. Session validation (by direct call)");
  const validate = (sessionId: string, now = NOW, centerId = A) =>
    validateReceptionSession(prisma, { centerId, sessionId, timeZone: TZ, now });
  const okLive = await validate(S_live.id);
  check("An open session of this centre, today, is accepted", okLive.ok && okLive.session.id === S_live.id);
  check("Another centre's session id is refused as notFound", JSON.stringify(await validate(S_B.id)) === JSON.stringify({ ok: false, reason: "notFound" }));
  check("A made-up id is refused as notFound", (await validate("not-a-real-id")).ok === false);
  check("Not today: another day's session is refused (notToday)", JSON.stringify(await validate(S_wed.id)) === JSON.stringify({ ok: false, reason: "notToday" }));
  check("A closed session is refused (closed)", JSON.stringify(await validate(S_closed.id)) === JSON.stringify({ ok: false, reason: "closed" }));
  check("A cancelled session is refused (cancelled)", JSON.stringify(await validate(S_cancel.id)) === JSON.stringify({ ok: false, reason: "cancelled" }));
  check("A rescheduled session is refused (rescheduled)", JSON.stringify(await validate(S_resched.id)) === JSON.stringify({ ok: false, reason: "rescheduled" }));
  check("A deactivated class's session is refused (inactive)", JSON.stringify(await validate(S_inactive.id)) === JSON.stringify({ ok: false, reason: "inactive" }));
  check("A one-time session is accepted", (await validate(S_one)).ok);
  check(
    "The date is the centre's: 00:30 Cairo on 12 Oct accepts 12 Oct's session",
    (await validate(S_up.id, NOW_EARLY)).ok,
  );

  // ── 3. Resolving a scan ──────────────────────────────────────────────────
  console.log("\n3. Resolving what was scanned or typed (centre-scoped)");
  const resolve = (raw: string, centerId = A) => resolveStudentInput(prisma, { centerId, raw });
  const monaResult = await resolve(studentQrPayload(A, "1001"));
  check("This centre's card resolves to this centre's student", monaResult.kind === "student" && monaResult.student.id === sMona.profile.id && monaResult.student.name === "Mona Hassan");
  check("A bare code resolves in THIS centre only (B's 1001 is a different person)", (await resolve("1001")).kind === "student" && ((await resolve("1001")) as { student: { id: string } }).student.id === sMona.profile.id);
  const noisy = await resolve(`]Q1${studentQrPayload(A.toUpperCase(), "١٠٠١")}\r\n`);
  check("A noisy burst (prefix, Arabic-Indic digits, upper-case id, CRLF) resolves to the right student", noisy.kind === "student" && noisy.student.id === sMona.profile.id);
  const foreignCard = await resolve(studentQrPayload(B, "1001"));
  const foreignUnknown = await resolve(studentQrPayload(B, "7777"));
  const foreignRandom = await resolve(studentQrPayload("11111111-2222-4333-8444-555555555555", "1001"));
  check(
    "B's card at A's desk is refused as otherBranch — and says exactly the same whether or not that code exists in B",
    foreignCard.kind === "otherBranch" &&
      JSON.stringify(foreignCard) === JSON.stringify(foreignUnknown) &&
      JSON.stringify(foreignCard) === JSON.stringify(foreignRandom),
  );
  check("…and resolves nothing: it never returns B's student", !JSON.stringify(foreignCard).includes(sB.profile.id) && !JSON.stringify(foreignCard).includes("Bella"));
  check("B's desk reads B's card as B's student", ((await resolve(studentQrPayload(B, "1001"), B)) as { student?: { id: string } }).student?.id === sB.profile.id);
  check("An unknown code is notFound (card and bare)", (await resolve(studentQrPayload(A, "9999"))).kind === "notFound" && (await resolve("9999")).kind === "notFound");
  check("A card that cannot be read (non-English keyboard layout) is unreadable, not 'not found'", (await resolve("نشغثيع|ثحخ-خثخ|1001")).kind === "unreadable");
  check("A deactivated student is reported as inactive", (await resolve(studentQrPayload(A, sInactive.profile.studentCode))).kind === "inactive");
  const byName = await resolve("Mona");
  check("A name fragment finds one student", byName.kind === "student" && byName.student.id === sMona.profile.id);
  const byLast = await resolve("Blocked");
  check("A fragment shared by several students returns candidates", byLast.kind === "candidates" && byLast.students.length === 2);
  check("Nothing matching is notFound", (await resolve("Zzzzzz")).kind === "notFound");

  // ── 4. The pre-confirm look ──────────────────────────────────────────────
  console.log("\n4. Duplicates, blocks and drop-ins");
  const sessionRef = (row: { id: string; teacherId: string; classGroupId: string | null }) => ({
    id: row.id,
    teacherId: row.teacherId,
    classGroupId: row.classGroupId,
  });
  const liveRef = sessionRef(S_live);
  const upRef = sessionRef(S_up);
  const state = (session: ReturnType<typeof sessionRef>, student: { profile: { id: string; userId: string } }) =>
    studentSessionState(prisma, { centerId: A, session, student: { id: student.profile.id, userId: student.profile.userId } });

  const already = await state(liveRef, sMona);
  check(
    "A student already on the roster is 'already' with the stored status and time — no new row",
    already.outcome === "already" && already.status === "PRESENT" && already.recordedAt.getTime() === m1.recordedAt.getTime(),
  );
  const rowsBefore = await prisma.sessionAttendee.count({ where: { sessionId: S_live.id, studentProfileId: sMona.profile.id } });
  let duplicateRefused = false;
  try {
    await checkIn(A, S_live.id, sMona.profile.id, at("11:06"));
  } catch {
    duplicateRefused = true;
  }
  check(
    "A second write for the same (session, student) is refused by the unique key — one row, never two",
    duplicateRefused && rowsBefore === 1 && (await prisma.sessionAttendee.count({ where: { sessionId: S_live.id, studentProfileId: sMona.profile.id } })) === 1,
  );

  await prisma.studentBlock.create({ data: scopedData(A, { scope: "TEACHER", refId: t1.id, blockedUserId: sBlockedTeacher.profile.userId }) });
  await prisma.studentBlock.create({ data: scopedData(A, { scope: "CLASS", refId: C2, blockedUserId: sBlockedClass.profile.userId }) });
  const blockedByTeacher = await state(liveRef, sBlockedTeacher);
  const blockedByClass = await state(upRef, sBlockedClass);
  check("A teacher block refuses the student (scope TEACHER)", blockedByTeacher.outcome === "blocked");
  check("A class block refuses the student (scope CLASS)", blockedByClass.outcome === "blocked");
  check(
    "The shared rule agrees on both scopes, and each block is specific to its teacher/class",
    (await isStudentBlockedFromSession(prisma, A, S_live, sBlockedTeacher.profile.userId)) &&
      (await isStudentBlockedFromSession(prisma, A, S_up, sBlockedClass.profile.userId)) &&
      !(await isStudentBlockedFromSession(prisma, A, S_up, sBlockedTeacher.profile.userId)) &&
      !(await isStudentBlockedFromSession(prisma, A, S_live, sBlockedClass.profile.userId)),
  );
  const oneOffRow = await prisma.session.findUniqueOrThrow({ where: { id: S_one } });
  check(
    "A one-time session has no class block to check — only its teacher's applies",
    !(await isStudentBlockedFromSession(prisma, A, oneOffRow, sBlockedClass.profile.userId)),
  );
  await prisma.studentBlock.create({ data: scopedData(B, { scope: "TEACHER", refId: t1.id, blockedUserId: sMona.profile.userId }) });
  check(
    "A block recorded at another centre never blocks here",
    !(await isStudentBlockedFromSession(prisma, A, S_live, sMona.profile.userId)),
  );
  const wrote = await prisma.sessionAttendee.count({ where: { studentProfileId: { in: [sBlockedTeacher.profile.id, sBlockedClass.profile.id] } } });
  check("Refusing a blocked student wrote nothing", wrote === 0);

  const notEnrolledHere = await state(liveRef, sNada);
  check("A student not on this session's roster is ready (and not enrolled in its class)", notEnrolledHere.outcome === "ready" && notEnrolledHere.enrolled === false);
  const dropIn = await state(liveRef, sDropIn);
  const enrolledReady = await state(upRef, sAli);
  check(
    "Enrolled in the class → enrolled; not enrolled → drop-in (checked in exactly as before)",
    dropIn.outcome === "ready" && dropIn.enrolled === false && enrolledReady.outcome === "ready" && enrolledReady.enrolled === true,
  );
  const dropRow = await checkIn(A, S_live.id, sDropIn.profile.id, at("11:30"), null);
  check("A drop-in check-in stores isDropIn with no enrolment", dropRow.isDropIn === true && dropRow.enrollmentId === null);

  // ── 5. The student picker ────────────────────────────────────────────────
  console.log("\n5. Sessions offered for a student");
  const offer = (studentProfileId: string, list: ReceptionSessionCard[]) =>
    openSessionsForStudent(prisma, { centerId: A, studentProfileId, cards: list });
  const monaOffer = await offer(sMona.profile.id, cards);
  check(
    "Only open sessions are offered — the closed one never is",
    monaOffer.options.length === 3 && !monaOffer.options.some((card) => card.id === S_closed.id),
  );
  check(
    "Every offered session carries a teacher name (the picker label is name · teacher · time)",
    monaOffer.options.every((card) => card.teacherName !== null && card.label.length > 0),
  );
  check("Exactly one open session on the student's enrolments → preselected", monaOffer.preselectId === S_live.id);
  const aliOffer = await offer(sAli.profile.id, cards);
  check("Two open enrolled sessions → nothing preselected", aliOffer.preselectId === null);
  const dropOffer = await offer(sDropIn.profile.id, cards);
  check("No enrolments → nothing preselected, all open sessions still offered", dropOffer.preselectId === null && dropOffer.options.length === 3);
  const nadaOffer = await offer(sNada.profile.id, cards);
  check("Enrolled only in an ended class → nothing preselected", nadaOffer.preselectId === null);

  // ── 6. Money is the existing path ────────────────────────────────────────
  console.log("\n6. Check-in + payment through the existing helpers");
  const monaPay = await pay(A, m1.id, at("11:06"));
  const aliPay = await pay(A, aliRow.id, at("11:21"));
  const expected = splitShare(12_000, "PERCENTAGE", 15);
  check(
    "Both entry points freeze the same snapshots: price, centre cut and teacher share from lib/money.ts",
    monaPay.ok && aliPay.ok &&
      monaPay.payment.priceSnapshot === 12_000 && aliPay.payment.priceSnapshot === 12_000 &&
      monaPay.payment.centerShareSnapshot === expected.centerShare && aliPay.payment.centerShareSnapshot === expected.centerShare &&
      monaPay.payment.teacherShareSnapshot === expected.teacherShare && aliPay.payment.teacherShareSnapshot === expected.teacherShare &&
      monaPay.payment.centerShareSnapshot + monaPay.payment.teacherShareSnapshot === 12_000,
    JSON.stringify([monaPay, aliPay]),
  );
  const again = await pay(A, m1.id, at("11:07"));
  check("A second payment for the same student is refused (alreadyPaid) — a re-confirm never double-charges", !again.ok && again.error === "alreadyPaid");
  const recent = await recentCheckIns(prisma, { centerId: A, sessionId: S_live.id });
  check(
    "Recent check-ins: newest first, Present/Late only, scoped to the session",
    recent.length === 3 && recent[0].studentName === "Drew Dropin" && recent[recent.length - 1].studentName === "Mona Hassan" &&
      recent.every((row) => row.status === "PRESENT" || row.status === "LATE"),
    recent.map((row) => row.studentName).join(", "),
  );
  check(
    "Recent check-ins are bounded and empty for another centre's lookup",
    (await recentCheckIns(prisma, { centerId: B, sessionId: S_live.id })).length === 0,
  );

  // ── 7. End session from reception ────────────────────────────────────────
  console.log("\n7. End session (R2's closeSession, reached from a card)");
  const early = await closeSession(prisma, A, S_up.id, { closedBy: staff.id, now: NOW });
  check("Before the session starts it is refused (notStarted) — the card shows the control disabled", !early.ok && early.error === "notStarted", JSON.stringify(early));
  const ended = await closeSession(prisma, A, S_live.id, { closedBy: staff.id, now: NOW });
  check("A live, started session closes (MANUAL, by the actor)", ended.ok && ended.session.closeMode === "MANUAL" && ended.session.closedBy === staff.id, JSON.stringify(ended));
  const twice = await closeSession(prisma, A, S_live.id, { closedBy: staff.id, now: NOW });
  check("Ending it again is refused (alreadyClosed)", !twice.ok && twice.error === "alreadyClosed", JSON.stringify(twice));
  const foreignEnd = await closeSession(prisma, A, S_B.id, { closedBy: staff.id, now: NOW });
  check("Another centre's session cannot be ended from here (notFound)", !foreignEnd.ok && foreignEnd.error === "notFound", JSON.stringify(foreignEnd));
  const after = byId(await cardsAt(NOW));
  const endedCard = after.get(S_live.id);
  check(
    "The card flips to View receipt and every check-in control is gone",
    endedCard?.displayStatus === "COMPLETED" && endedCard.canViewReceipt && !endedCard.canAttend && !endedCard.acceptsCheckIn && endedCard.end === "hidden",
  );
  check("An ended session is no longer valid for session mode", (await validate(S_live.id)).ok === false);
  let refusedAfterEnd = false;
  try {
    await checkIn(A, S_live.id, sNada.profile.id, at("11:40"));
  } catch (error) {
    refusedAfterEnd = error instanceof SessionClosedError && error.reason === "sessionClosed";
  }
  check("A check-in after the end is refused by the data layer (sessionClosed)", refusedAfterEnd);
  check(
    "The ended session's students are not offered it (closed sessions are never offered)",
    !(await offer(sMona.profile.id, Array.from(after.values()))).options.some((card) => card.id === S_live.id),
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
    if (failures > 0) {
      console.error(`\n${failures} reception check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll reception checks passed.");
  });
