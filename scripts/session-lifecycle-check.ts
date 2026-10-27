/**
 * Session lifecycle check — the R2 acceptance gate
 * (docs/00-master-product-spec.md §5.1 "Session lifecycle", docs/03-build-order.md R2).
 *
 * Run with:  npm run check:session-lifecycle
 *
 * Exercises the real production functions — `lib/db/session-lifecycle.ts`
 * (the closure guard, closing, absence materialization), `lib/db/attendance.ts`
 * (check-in with the automatic late rule, live status changes with
 * void-on-absent), `lib/db/payments.ts`/`lib/db/refunds.ts`,
 * `lib/db/sessions.ts`'s cancel/reschedule/override and
 * `lib/db/settlements.ts` — by **direct call**, never through the UI. Every
 * clock-dependent assertion injects `now`, so the gate means the same thing
 * whatever day or hour it runs. Needs a reachable database and cleans up
 * after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { scopedData, scopedFindById } from "../lib/db/tenant-scope.ts";
import {
  changeAttendanceStatus,
  consecutiveAbsenceCount,
  createAttendance,
  recheckInAttendee,
  SessionClosedError,
  updateAttendanceStatus,
} from "../lib/db/attendance.ts";
import { attendanceDisplay, EXCLUDE_DROP_IN_NO_SHOWS, isDropInNoShow } from "../lib/attendance-rules.ts";
import { studentSessionState } from "../lib/db/reception.ts";
import { studentPastAttendance } from "../lib/db/student-portal.ts";
import { studentSessionsWithTeacher } from "../lib/db/teacher-portal.ts";
import { attendedSessionsToRate, submitSessionRating } from "../lib/db/ratings.ts";
import { recordPayment, sessionReceiptTotals, voidPayment } from "../lib/db/payments.ts";
import { refundPayment } from "../lib/db/refunds.ts";
import {
  closeEndedSessions,
  closeSession,
  closeSessionIfDayOver,
  isSessionClosed,
  listSessionAttendanceChanges,
  materializeAbsences,
  orderChangeLog,
  sessionChangeLog,
  SYSTEM_ACTOR_ID,
} from "../lib/db/session-lifecycle.ts";
import {
  cancelSession,
  deriveSessionDisplayStatus,
  rescheduleSession,
  updateSessionShareOverride,
} from "../lib/db/sessions.ts";
import { createPeriodSettlement, createSessionSettlement } from "../lib/db/settlements.ts";
import { attendanceStatusCounts, revenueTotals } from "../lib/db/analytics.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { can, DEFAULT_ROLE_GRANTS, type PermissionGrants } from "../lib/auth/permissions.ts";
import {
  checkInStatus,
  endOfSessionDay,
  isSessionDayOver,
  resolveLateThreshold,
} from "../lib/scheduling.ts";

const prisma = await gatePrisma();

const SLUG_A = "session-lifecycle-check-a";
const SLUG_B = "session-lifecycle-check-b";
const EMAIL_PREFIX = "session-lifecycle-check-";
const TZ = "Africa/Cairo";
const PRICE = 12_000; // 120 EGP
const FIXED_CUT = 1_500; // teacher share 10,500
const TEACHER_SHARE = PRICE - FIXED_CUT;
const CLASS_THRESHOLD = 10;
const ROLLBACK_TRIGGER = "session_lifecycle_check_fail_void";

// Winter dates (Cairo = UTC+2, no DST) so every instant below is unambiguous.
const D = new Date("2026-12-07T00:00:00.000Z");
/** A wall-clock instant in Cairo on 2026-12-dd, as UTC (Cairo = UTC+2 in December). */
function cairo(day: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(2026, 11, day, hh - 2, mm));
}
function day(dd: number): Date {
  return new Date(Date.UTC(2026, 11, dd));
}

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function refusedWith(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof SessionClosedError ? error.reason : `other:${String(error)}`;
  }
}

async function dropRollbackTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER} ON "Payment"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${ROLLBACK_TRIGGER}()`);
}

async function cleanup() {
  await dropRollbackTrigger();
  const centers = await prisma.center.findMany({
    where: { slug: { in: [SLUG_A, SLUG_B] } },
    select: { id: true, organizationId: true },
  });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    // AuditLog.centerId has no cascade; the AUTO-close rows reference these centres.
    await deleteAuditRows(prisma, { centerId: { in: ids } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

function grantsFor(role: keyof typeof DEFAULT_ROLE_GRANTS): PermissionGrants {
  return Object.fromEntries(DEFAULT_ROLE_GRANTS[role].map((action) => [action, true]));
}

// ── Static assertions (no database) ─────────────────────────────────────────

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

function checkStatic() {
  console.log("Static assertions (no database needed)");
  const appFiles = listFiles("app");
  const libFiles = listFiles("lib");

  const backfillInApp = appFiles.filter((file) => readFileSync(file, "utf8").includes("historicalBackfill"));
  check(
    "No file under app/ passes historicalBackfill — the scripts-only escape hatch never reaches production",
    backfillInApp.length === 0,
    backfillInApp.join(", "),
  );

  // R5 Step 0 (decided): R4 and R5 delete *pristine* sessions on purpose
  // (resync, deactivation, a holiday, a class that never ran, and R5's
  // deleteManualSession), so "no delete path anywhere" became "session
  // deletes exist only in lib/db/class-sessions.ts, and every one passes
  // through the pristine predicate". A closed session is still never deletable.
  const sessionDeletes = [...appFiles, ...libFiles].filter((file) =>
    /\.session\.(delete|deleteMany)\(|sessions\.(remove|delete)\b/.test(readFileSync(file, "utf8")),
  );
  const isEngineFile = (file: string) => file.replace(/\\/g, "/").endsWith("lib/db/class-sessions.ts");
  const engine = readFileSync("lib/db/class-sessions.ts", "utf8");
  const deleteCalls = [...engine.matchAll(/\.session\.(delete|deleteMany)\(/g)].map((match) => {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    for (; i < engine.length && depth > 0; i++) {
      if (engine[i] === "(") depth += 1;
      else if (engine[i] === ")") depth -= 1;
    }
    return engine.slice(start, i - 1);
  });
  const constantBody = (name: string) => {
    const at = engine.indexOf(`const ${name} = {`);
    return at === -1 ? "" : engine.slice(at, engine.indexOf("} satisfies", at));
  };
  const untouched = constantBody("UNTOUCHED");
  const noOverride = constantBody("NO_OVERRIDE");
  const stillPristine = constantBody("STILL_PRISTINE");
  const pristineWhereAt = engine.indexOf("const pristineWhere");
  const pristineWhere =
    pristineWhereAt === -1 ? "" : engine.slice(pristineWhereAt, engine.indexOf(";", pristineWhereAt));
  const predicateComplete =
    [
      "status: SCHEDULED",
      "closedAt: null",
      "attendees: { none: {} }",
      "payments: { none: {} }",
      "settlements: { none: {} }",
      "ratings: { none: {} }",
      "rescheduledToId: null",
      "rescheduledFrom: { is: null }",
    ].every((clause) => untouched.includes(clause)) &&
    noOverride.includes("...UNTOUCHED") &&
    noOverride.includes("centerShareType: null") &&
    noOverride.includes("centerShareValue: null") &&
    stillPristine.includes("...NO_OVERRIDE") &&
    // deleteManualSession: a class session needs NO_OVERRIDE; a one-time
    // session (no class) needs UNTOUCHED — its cut is its own, not an
    // override of a class's, so there is no override to be free of.
    /\.\.\.UNTOUCHED,\s*classGroupId: null/.test(pristineWhere) &&
    pristineWhere.includes("...NO_OVERRIDE");
  check(
    "Session deletes exist only in lib/db/class-sessions.ts (the engine and R5's deleteManualSession)",
    sessionDeletes.length === 1 && isEngineFile(sessionDeletes[0]),
    sessionDeletes.join(", "),
  );
  check(
    "Every session delete passes the pristine predicate: not closed, no attendees/payments/settlement/ratings, no share override, no reschedule link",
    deleteCalls.length > 0 &&
      deleteCalls.every((args) => /\.\.\.(STILL_PRISTINE|NO_OVERRIDE)\b|\bpristineWhere\b/.test(args)) &&
      predicateComplete,
    deleteCalls.join(" | "),
  );

  const closedAtWriters = [...appFiles, ...libFiles].filter((file) => {
    if (file.replace(/\\/g, "/").endsWith("lib/db/session-lifecycle.ts")) return false;
    return /data:\s*\{[^{}]*\bclosedAt\b/.test(readFileSync(file, "utf8"));
  });
  check(
    "Nothing but lib/db/session-lifecycle.ts ever writes Session.closedAt",
    closedAtWriters.length === 0,
    closedAtWriters.join(", "),
  );

  const lifecycle = readFileSync("lib/db/session-lifecycle.ts", "utf8");
  check(
    "lib/db/session-lifecycle.ts never writes closedAt back to null (no reopen)",
    !/closedAt:\s*null\s*,?\s*\n\s*closedBy/.test(lifecycle) &&
      !/data:\s*\{[^{}]*closedAt:\s*null/.test(lifecycle),
  );
  const reopenExports = [...appFiles, ...libFiles].filter((file) =>
    /export\s+(async\s+)?function\s+\w*(reopen|unclose)\w*/i.test(readFileSync(file, "utf8")),
  );
  check("No reopen/unclose function is exported anywhere", reopenExports.length === 0, reopenExports.join(", "));

  const sessionActions = readFileSync("app/[locale]/(center)/sessions/actions.ts", "utf8");
  check(
    "endSessionAction re-checks session.close server-side",
    /export async function endSessionAction[\s\S]*?ctxCan\(ctx, "session\.close"\)/.test(sessionActions),
  );

  console.log("\nLate computation, timezone and display status (no database needed)");
  const s16 = { date: D, startTime: "16:00" };
  check("Exactly at start + threshold is PRESENT", checkInStatus(s16, 10, cairo(7, 16, 10), TZ) === "PRESENT");
  check("One minute after start + threshold is LATE", checkInStatus(s16, 10, cairo(7, 16, 11), TZ) === "LATE");
  check("Before the start is PRESENT", checkInStatus(s16, 10, cairo(7, 15, 30), TZ) === "PRESENT");
  check("The day before is PRESENT", checkInStatus(s16, 10, cairo(6, 20, 0), TZ) === "PRESENT");
  check("Any time on a later day is LATE", checkInStatus(s16, 10, cairo(8, 9, 0), TZ) === "LATE");
  check(
    "Late is decided in the centre's timezone, not UTC (16:05 Cairo = 14:05Z is still PRESENT)",
    checkInStatus(s16, 10, new Date("2026-12-07T14:05:00.000Z"), TZ) === "PRESENT" &&
      checkInStatus(s16, 10, new Date("2026-12-07T16:05:00.000Z"), TZ) === "LATE",
  );
  check(
    "The class threshold wins; the centre default is the fallback; 10 is the last resort",
    resolveLateThreshold(5, 15) === 5 &&
      resolveLateThreshold(null, 15) === 15 &&
      resolveLateThreshold(undefined, null) === 10,
  );
  check(
    "23:59 Cairo is still the session's day; 00:00 the next day is over",
    !isSessionDayOver(D, cairo(7, 23, 59), TZ) && isSessionDayOver(D, cairo(8, 0, 0), TZ),
  );
  check(
    "00:30 Cairo on the 8th (22:30Z on the 7th — still the 7th in UTC) counts as the day over",
    isSessionDayOver(D, new Date("2026-12-07T22:30:00.000Z"), TZ),
  );
  check(
    "endOfSessionDay is local midnight after the session's day (22:00Z in Cairo winter)",
    endOfSessionDay(D, TZ).toISOString() === "2026-12-07T22:00:00.000Z",
  );
  const base = { status: "SCHEDULED" as const, date: D, startTime: "16:00", endTime: "18:00", rescheduledToId: null };
  check(
    "Display status agrees with the stored close: closedAt → COMPLETED even mid-day",
    deriveSessionDisplayStatus({ ...base, closedAt: cairo(7, 16, 30) }, cairo(7, 16, 45), TZ) === "COMPLETED",
  );
  check(
    "Display: started and not closed is LIVE — past its end time too, until ended or the day ends",
    deriveSessionDisplayStatus({ ...base, closedAt: null }, cairo(7, 16, 30), TZ) === "LIVE" &&
      deriveSessionDisplayStatus({ ...base, closedAt: null }, cairo(7, 21, 0), TZ) === "LIVE",
  );
  check(
    "Display: before start SCHEDULED; day over COMPLETED; stored COMPLETED COMPLETED; cancelled/rescheduled keep precedence",
    deriveSessionDisplayStatus({ ...base, closedAt: null }, cairo(7, 15, 0), TZ) === "SCHEDULED" &&
      deriveSessionDisplayStatus({ ...base, closedAt: null }, cairo(8, 0, 30), TZ) === "COMPLETED" &&
      deriveSessionDisplayStatus({ ...base, status: "COMPLETED", closedAt: null }, cairo(7, 15, 0), TZ) === "COMPLETED" &&
      deriveSessionDisplayStatus({ ...base, status: "CANCELLED", closedAt: null }, cairo(7, 16, 30), TZ) === "CANCELLED" &&
      deriveSessionDisplayStatus({ ...base, rescheduledToId: "x", closedAt: null }, cairo(7, 16, 30), TZ) === "RESCHEDULED",
  );
  check(
    "isSessionClosed: closedAt or day over, a cancelled/rescheduled session included (D-07)",
    isSessionClosed({ closedAt: cairo(7, 17, 0), date: D }, cairo(7, 17, 1), TZ) &&
      isSessionClosed({ closedAt: null, date: D }, cairo(8, 0, 1), TZ) &&
      !isSessionClosed({ closedAt: null, date: D }, cairo(7, 23, 0), TZ) &&
      isSessionClosed({ closedAt: null, date: D }, cairo(8, 1, 0), TZ),
  );

  console.log("\nT5 — void/refund resets attendance (no database needed)");
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const migrationSql = readFileSync(
    "prisma/migrations/20261027190000_t5_void_refund_reset_attendance/migration.sql",
    "utf8",
  );
  const indexPredicate = migrationSql.match(
    /CREATE UNIQUE INDEX "Payment_one_active_per_attendee_t5"\s+ON "Payment"\("sessionAttendeeId"\) WHERE ([^;]+);/,
  )?.[1];
  const paymentsSource = readFileSync("lib/db/payments.ts", "utf8");
  const conflictPredicate = paymentsSource.match(/ON CONFLICT \("sessionAttendeeId"\) WHERE (.+?) DO NOTHING/)?.[1];
  check(
    "recordPayment's ON CONFLICT predicate matches the active-payment index in the T5 migration exactly",
    indexPredicate !== undefined &&
      conflictPredicate !== undefined &&
      normalize(indexPredicate) === normalize(conflictPredicate) &&
      normalize(indexPredicate) === `"voided" = false AND "refunded" = false`,
    JSON.stringify({ indexPredicate, conflictPredicate }),
  );
  check(
    "The migration swaps the index without a gap: create the new one, drop the old, rename — and keeps the CHECK",
    (() => {
      const create = migrationSql.indexOf(`CREATE UNIQUE INDEX "Payment_one_active_per_attendee_t5"`);
      const drop = migrationSql.indexOf(`DROP INDEX "Payment_one_active_per_attendee";`);
      const rename = migrationSql.indexOf(
        `ALTER INDEX "Payment_one_active_per_attendee_t5" RENAME TO "Payment_one_active_per_attendee";`,
      );
      return create !== -1 && create < drop && drop < rename && !/Payment_not_voided_and_refunded/.test(migrationSql.replace(/--.*$/gm, ""));
    })(),
  );
  check(
    "lockAttendeeRow's active-payment fact is 'not voided AND not refunded' too",
    /p\."voided" = false AND p\."refunded" = false\s*\) AS "hasActivePayment"/.test(readFileSync("lib/db/session-lifecycle.ts", "utf8")),
  );
  const body = (source: string, name: string) => {
    const at = source.indexOf(`export async function ${name}(`);
    return at === -1 ? "" : source.slice(at, source.indexOf("\n}\n", at));
  };
  const voidBody = body(paymentsSource, "voidPayment");
  const refundBody = body(readFileSync("lib/db/refunds.ts", "utf8"), "refundPayment");
  check(
    "voidPayment and refundPayment lock session → attendee → payment, then reset through the one writer",
    voidBody.indexOf("ensureSessionOpenOrAutoClose") < voidBody.indexOf("lockAttendeeRow") &&
      voidBody.indexOf("lockAttendeeRow") < voidBody.indexOf("voidPaymentRow") &&
      voidBody.indexOf("voidPaymentRow") < voidBody.indexOf("resetAttendanceAfterReversal") &&
      refundBody.indexOf("ensureSessionOpenOrAutoClose") < refundBody.indexOf("lockAttendeeRow") &&
      refundBody.indexOf("lockAttendeeRow") < refundBody.indexOf("lockPaymentRow") &&
      refundBody.indexOf("lockPaymentRow") < refundBody.indexOf("resetAttendanceAfterReversal") &&
      voidBody.includes("historicalBackfill") && refundBody.includes("historicalBackfill"),
  );
  check(
    "There is one attendance-change writer: only lib/db/attendance-change.ts creates SessionAttendanceChange rows",
    [...appFiles, ...libFiles].filter((file) => /sessionAttendanceChange\.create\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(/\\/g, "/"))
      .join() === "lib/db/attendance-change.ts",
  );
  check(
    "A drop-in's ABSENT row is never an absence; any live ABSENT row reads Not arrived; an enrolled one closed reads Absent",
    isDropInNoShow({ isDropIn: true, attendanceStatus: "ABSENT" }) &&
      !isDropInNoShow({ isDropIn: false, attendanceStatus: "ABSENT" }) &&
      !isDropInNoShow({ isDropIn: true, attendanceStatus: "PRESENT" }) &&
      attendanceDisplay({ isDropIn: false, attendanceStatus: "ABSENT" }, false) === "NOT_ARRIVED" &&
      attendanceDisplay({ isDropIn: true, attendanceStatus: "ABSENT" }, true) === "NOT_ARRIVED" &&
      attendanceDisplay({ isDropIn: false, attendanceStatus: "ABSENT" }, true) === "ABSENT" &&
      attendanceDisplay({ isDropIn: true, attendanceStatus: "LATE" }, false) === "LATE" &&
      JSON.stringify(EXCLUDE_DROP_IN_NO_SHOWS) === JSON.stringify({ NOT: { isDropIn: true, attendanceStatus: "ABSENT" } }),
  );
  check(
    "Every consumer the drop-in rule covers applies the one filter (streak, analytics, student/parent history, teacher history)",
    /\.\.\.EXCLUDE_DROP_IN_NO_SHOWS/.test(body(readFileSync("lib/db/attendance.ts", "utf8"), "consecutiveAbsenceCount")) &&
      /\.\.\.EXCLUDE_DROP_IN_NO_SHOWS/.test(body(readFileSync("lib/db/analytics.ts", "utf8"), "attendanceStatusCounts")) &&
      /\.\.\.EXCLUDE_DROP_IN_NO_SHOWS/.test(readFileSync("lib/db/student-portal.ts", "utf8").split("export function studentPastAttendance")[1] ?? "") &&
      /\.\.\.EXCLUDE_DROP_IN_NO_SHOWS/.test(readFileSync("lib/db/teacher-portal.ts", "utf8").split("export function studentSessionsWithTeacher")[1] ?? ""),
  );
  // The change log's order is causal: changes run on the app's clock and
  // payments on the database's — here the two clocks are a month apart.
  const at = (iso: string) => new Date(iso);
  const log = orderChangeLog({
    checkedInAt: at("2026-11-01T10:00:00Z"),
    changes: [
      { id: "c1", changedAt: at("2026-12-16T14:05:00Z"), fromStatus: "PRESENT", toStatus: "ABSENT", reason: "Wrong student", byName: null, cause: { reversal: "void", paymentId: "p1" } },
      { id: "c2", changedAt: at("2026-12-16T14:20:00Z"), fromStatus: "ABSENT", toStatus: "LATE", reason: null, byName: null, cause: null },
    ],
    payments: [
      { id: "p2", recordedAt: at("2026-11-01T10:30:00Z"), amount: PRICE, byName: null },
      { id: "p1", recordedAt: at("2026-11-01T10:01:00Z"), amount: PRICE, byName: null },
    ],
  });
  check(
    "The change log reads checked in → paid → voided (amount, reason) → reset → checked in again → paid, whatever the clocks",
    log.map((event) => event.kind).join() === "checkIn,payment,reversal,change,change,payment" &&
      log[1].kind === "payment" && log[1].paymentId === "p1" &&
      log[2].kind === "reversal" && log[2].reversal === "void" && log[2].amount === PRICE && log[2].reason === "Wrong student" &&
      log[3].kind === "change" && log[3].toStatus === "ABSENT" && log[3].reason === null &&
      log[4].kind === "change" && log[4].fromStatus === "ABSENT" && log[4].toStatus === "LATE" &&
      log[5].kind === "payment" && log[5].paymentId === "p2",
    JSON.stringify(log.map((event) => event.kind)),
  );
  const refundLog = orderChangeLog({
    checkedInAt: at("2026-12-16T14:00:00Z"),
    changes: [
      { id: "c1", changedAt: at("2026-12-16T14:10:00Z"), fromStatus: "PRESENT", toStatus: "ABSENT", reason: "cash back", byName: null, cause: { reversal: "refund", paymentId: "p1" } },
    ],
    payments: [{ id: "p1", recordedAt: at("2026-12-16T14:01:00Z"), amount: PRICE, byName: null }],
  });
  check(
    "A refund reads as a refund in the log, not as a void",
    refundLog.map((event) => event.kind).join() === "checkIn,payment,reversal,change" &&
      refundLog[2].kind === "reversal" && refundLog[2].reversal === "refund",
  );

  console.log("\nPermissions (no database needed)");
  check(
    "OWNER, MANAGER and RECEPTIONIST hold session.close by default",
    can("OWNER", "session.close", grantsFor("OWNER")) &&
      can("MANAGER", "session.close", grantsFor("MANAGER")) &&
      can("RECEPTIONIST", "session.close", grantsFor("RECEPTIONIST")),
  );
  check(
    "ACCOUNTANT and TEACHER do not — and a role without the grant is refused",
    !can("ACCOUNTANT", "session.close", grantsFor("ACCOUNTANT")) &&
      !can("TEACHER", "session.close", grantsFor("TEACHER")) &&
      !can("RECEPTIONIST", "session.close", {}),
  );
}

// ── Database-backed checks ──────────────────────────────────────────────────

async function main() {
  await cleanup();
  checkStatic();

  console.log("\nMigration backfill");
  const receptionistCenters = await prisma.permissionGrant.findMany({
    where: { role: "RECEPTIONIST", action: "reception.use", allowed: true },
    select: { centerId: true },
  });
  const withClose = await prisma.permissionGrant.findMany({
    where: { role: "RECEPTIONIST", action: "session.close", allowed: true },
    select: { centerId: true },
  });
  const closeSet = new Set(withClose.map((row) => row.centerId));
  const missing = receptionistCenters.filter((row) => !closeSet.has(row.centerId));
  check(
    "Every centre whose RECEPTIONIST has the core-loop baseline also holds session.close (R2 backfill)",
    missing.length === 0,
    `${missing.length} centre(s) missing it`,
  );

  console.log("\nDatabase-backed checks");
  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Lifecycle A", organization: { create: { name: "Lifecycle A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Lifecycle B", organization: { create: { name: "Lifecycle B" } } },
  });
  for (const center of [centerA, centerB]) {
    await prisma.centerSettings.create({
      data: { centerId: center.id, timezone: TZ, defaultLateThreshold: 15 },
    });
    await ensureDefaultPaymentMethods(prisma, center.id);
  }
  const [methodA] = await listActivePaymentMethods(prisma, centerA.id);

  const teacher = await prisma.user.create({
    data: { firstName: "Tara", lastName: "Teacher", email: `${EMAIL_PREFIX}teacher@kayedu.test`, locale: "en" },
  });
  const staff = await prisma.user.create({
    data: { firstName: "Rami", lastName: "Reception", email: `${EMAIL_PREFIX}staff@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerA.id, { userId: teacher.id, role: "TEACHER", joinedAt: new Date() }),
  });
  await prisma.membership.create({
    data: scopedData(centerA.id, {
      userId: staff.id,
      role: "RECEPTIONIST",
      firstName: "Rami",
      lastName: "Desk",
      joinedAt: new Date(),
    }),
  });
  const classA = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacher.id,
      price: PRICE,
      centerShareType: "FIXED",
      centerShareValue: FIXED_CUT,
      lateThresholdMinutes: CLASS_THRESHOLD,
    }),
  });

  const students: { id: string }[] = [];
  for (let i = 1; i <= 8; i++) {
    const user = await prisma.user.create({
      data: { firstName: `S${i}`, lastName: "Student", email: `${EMAIL_PREFIX}s${i}@kayedu.test`, locale: "en" },
    });
    students.push(
      await prisma.studentProfile.create({
        data: scopedData(centerA.id, { userId: user.id, studentCode: `LC${i}`, firstName: `S${i}`, lastName: "Local" }),
        select: { id: true },
      }),
    );
  }
  const [s1, s2, s3, s4, s5, s6, s7, s8] = students.map((s) => s.id);
  // s3, s4 enrolled ACTIVE; s5 enrolled but REMOVED; s6 never enrolled.
  await prisma.enrollment.createMany({
    data: [
      { centerId: centerA.id, studentProfileId: s3, classGroupId: classA.id, status: "ACTIVE" },
      { centerId: centerA.id, studentProfileId: s4, classGroupId: classA.id, status: "ACTIVE" },
      { centerId: centerA.id, studentProfileId: s5, classGroupId: classA.id, status: "REMOVED" },
    ],
  });
  const enrollmentS3 = await prisma.enrollment.findFirstOrThrow({ where: { studentProfileId: s3, classGroupId: classA.id } });

  async function makeSession(date: Date, startTime: string, endTime: string, classGroupId = classA.id) {
    return prisma.session.create({
      data: scopedData(centerA.id, { classGroupId, teacherId: teacher.id, date, startTime, endTime, priceSnapshot: PRICE }),
    });
  }
  async function checkIn(sessionId: string, studentProfileId: string, now: Date, enrollmentId: string | null = null) {
    return createAttendance(
      prisma,
      { centerId: centerA.id, sessionId, studentProfileId, enrollmentId, isDropIn: enrollmentId === null, recordedBy: staff.id },
      { now },
    );
  }
  async function pay(attendeeId: string, now: Date) {
    const result = await prisma.$transaction((tx) =>
      recordPayment(tx, centerA.id, attendeeId, methodA.id, staff.id, { now }),
    );
    if (!result.ok) throw new Error(`pay failed: ${result.error}`);
    return result.payment;
  }

  // ── 1. Automatic LATE at check-in (stored, nobody chose it) ───────────
  const sessionLate = await makeSession(day(7), "16:00", "18:00");
  const onTime = await checkIn(sessionLate.id, s1, cairo(7, 16, CLASS_THRESHOLD));
  const late = await checkIn(sessionLate.id, s2, cairo(7, 16, CLASS_THRESHOLD + 1));
  check("A check-in exactly at start + the class threshold is stored PRESENT", onTime.attendanceStatus === "PRESENT");
  check("A check-in one minute later is stored LATE", late.attendanceStatus === "LATE");

  // ── 2. Lazy auto-close at the Cairo day boundary (23:30 session) ──────
  const sessionEdge = await makeSession(day(7), "23:30", "23:59");
  const edgeCheckIn = await checkIn(sessionEdge.id, s3, cairo(7, 23, 45), enrollmentS3.id);
  check("23:45 Cairo is still the session's day — the check-in lands (LATE)", edgeCheckIn.attendanceStatus === "LATE");
  const afterMidnight = new Date("2026-12-07T22:05:00.000Z"); // 00:05 Cairo on the 8th; still the 7th in UTC
  const edgeRefusal = await refusedWith(checkIn(sessionEdge.id, s6, afterMidnight));
  const edgeClosed = await prisma.session.findUniqueOrThrow({ where: { id: sessionEdge.id } });
  check("The first write after the day ended (Cairo time) is refused as sessionClosed", edgeRefusal === "sessionClosed", String(edgeRefusal));
  check(
    "…and that touch closed the session AUTO at local midnight, status COMPLETED, no actor",
    edgeClosed.closeMode === "AUTO" &&
      edgeClosed.closedBy === null &&
      edgeClosed.status === "COMPLETED" &&
      edgeClosed.closedAt?.toISOString() === "2026-12-07T22:00:00.000Z",
    JSON.stringify({ mode: edgeClosed.closeMode, at: edgeClosed.closedAt, status: edgeClosed.status }),
  );
  const edgeRoster = await prisma.sessionAttendee.findMany({ where: { sessionId: sessionEdge.id } });
  const byStudent = new Map(edgeRoster.map((row) => [row.studentProfileId, row]));
  const s4Absent = byStudent.get(s4);
  check(
    "The enrolled no-show became ABSENT — enrollment set, not a drop-in, recorded by the system",
    s4Absent?.attendanceStatus === "ABSENT" &&
      s4Absent.enrollmentId !== null &&
      s4Absent.isDropIn === false &&
      s4Absent.recordedBy === SYSTEM_ACTOR_ID,
    JSON.stringify(s4Absent),
  );
  check("The student who checked in keeps their mark", byStudent.get(s3)?.attendanceStatus === "LATE");
  check(
    "A removed enrolment and a never-enrolled student get nothing",
    !byStudent.has(s5) && !byStudent.has(s6) && edgeRoster.length === 2,
    `roster size ${edgeRoster.length}`,
  );
  const autoAudit = await prisma.auditLog.findMany({ where: { entityId: sessionEdge.id, action: "session.close" } });
  check(
    "The AUTO close wrote one session.close audit row with no actor",
    autoAudit.length === 1 && autoAudit[0].actorUserId === null && autoAudit[0].centerId === centerA.id,
  );

  // Idempotency: close again, materialize again, race two closes.
  const again = await closeSessionIfDayOver(prisma, centerA.id, sessionEdge.id, afterMidnight);
  const rematerialized = await materializeAbsences(prisma, edgeClosed, afterMidnight, TZ);
  const manualOnClosed = await closeSession(prisma, centerA.id, sessionEdge.id, { closedBy: staff.id, now: afterMidnight });
  check(
    "Closing twice creates nothing: no second close, zero new ABSENT rows, manual close refused as alreadyClosed",
    again === false &&
      rematerialized === 0 &&
      !manualOnClosed.ok &&
      manualOnClosed.error === "alreadyClosed" &&
      (await prisma.sessionAttendee.count({ where: { sessionId: sessionEdge.id } })) === 2,
  );
  const sessionRace = await makeSession(day(6), "23:30", "23:59");
  const raceResults = await Promise.all([
    closeSessionIfDayOver(prisma, centerA.id, sessionRace.id, afterMidnight),
    closeSessionIfDayOver(prisma, centerA.id, sessionRace.id, afterMidnight),
    closeEndedSessions(prisma, centerA.id, afterMidnight, { from: day(6), to: day(6) }),
  ]);
  const raceAbsent = await prisma.sessionAttendee.count({ where: { sessionId: sessionRace.id, studentProfileId: s4 } });
  const raceAudits = await prisma.auditLog.count({ where: { entityId: sessionRace.id, action: "session.close" } });
  check(
    "Three racing closes close it exactly once — one ABSENT row, one audit row",
    raceAbsent === 1 && raceAudits === 1 && [raceResults[0], raceResults[1]].filter(Boolean).length + (raceResults[2] as number) === 1,
    JSON.stringify({ raceResults, raceAbsent, raceAudits }),
  );
  check(
    "consecutiveAbsenceCount reads the materialized rows: absent on the 6th and the 7th = 2 in a row",
    (await consecutiveAbsenceCount(prisma, centerA.id, classA.id, s4, day(7))) === 2,
  );

  // ── 3. The closure guard on every write path, by direct call ──────────
  const sessionManual = await makeSession(day(8), "16:00", "18:00");
  const mA1 = await checkIn(sessionManual.id, s1, cairo(8, 16, 5));
  const mA2 = await checkIn(sessionManual.id, s2, cairo(8, 16, 5));
  const mA7 = await checkIn(sessionManual.id, s7, cairo(8, 16, 5));
  const mPay1 = await pay(mA1.id, cairo(8, 16, 6));
  const mPay2 = await pay(mA2.id, cairo(8, 16, 6));
  const notStarted = await closeSession(prisma, centerA.id, sessionManual.id, { closedBy: staff.id, now: cairo(8, 15, 0) });
  check("End session before the session starts is refused (notStarted)", !notStarted.ok && notStarted.error === "notStarted");
  const manualClose = await closeSession(prisma, centerA.id, sessionManual.id, { closedBy: staff.id, now: cairo(8, 17, 0) });
  check(
    "End session closes it MANUAL, by the actor, status COMPLETED, and materializes the enrolled no-shows",
    manualClose.ok &&
      manualClose.session.closeMode === "MANUAL" &&
      manualClose.session.closedBy === staff.id &&
      manualClose.session.status === "COMPLETED" &&
      manualClose.absentCreated === 2,
    JSON.stringify(manualClose),
  );
  const crossCenterClose = await closeSession(prisma, centerB.id, sessionManual.id, { closedBy: staff.id, now: cairo(8, 17, 0) });
  check("Centre B cannot close Centre A's session", !crossCenterClose.ok && crossCenterClose.error === "notFound");

  const live = cairo(8, 17, 5); // same day — refusals below are the stored close, not the clock
  const paymentsBefore = await prisma.payment.count({ where: { sessionId: sessionManual.id } });
  check(
    "createAttendance (check-in / add-attendee) is refused on a closed session",
    (await refusedWith(checkIn(sessionManual.id, s8, live))) === "sessionClosed",
  );
  check(
    "updateAttendanceStatus is refused on a closed session",
    (await refusedWith(updateAttendanceStatus(prisma, mA1, "ABSENT", staff.id, { now: live }))) === "sessionClosed",
  );
  const changeOnClosed = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: mA2.id, status: "ABSENT", changedBy: staff.id, mayVoidPayment: true },
    { now: live },
  );
  check("changeAttendanceStatus is refused on a closed session", !changeOnClosed.ok && changeOnClosed.error === "sessionClosed");
  const payOnClosed = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, mA7.id, methodA.id, staff.id, { now: live }),
  );
  check("recordPayment is refused on a closed session", !payOnClosed.ok && payOnClosed.error === "sessionClosed");
  const voidOnClosed = await prisma.$transaction((tx) =>
    voidPayment(tx, centerA.id, mPay1.id, "nope", staff.id, { now: live }),
  );
  check("voidPayment is refused on a closed session", !voidOnClosed.ok && voidOnClosed.error === "sessionClosed");
  const refundOnClosed = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, mPay2.id, "nope", staff.id, { now: live }),
  );
  check("refundPayment is refused on a closed session", !refundOnClosed.ok && refundOnClosed.error === "sessionClosed");
  const cancelOnClosed = await cancelSession(prisma, centerA.id, sessionManual.id, { now: live });
  check("cancelSession is refused on a closed session", !cancelOnClosed.ok && cancelOnClosed.error === "sessionClosed");
  const rescheduleOnClosed = await rescheduleSession(
    prisma,
    centerA.id,
    sessionManual.id,
    { date: day(20), startTime: "10:00", endTime: "11:00" },
    "WARN",
    "en",
    { now: live, confirmConflicts: true },
  );
  check("rescheduleSession is refused on a closed session", !rescheduleOnClosed.ok && rescheduleOnClosed.error === "sessionClosed");
  const overrideOnClosed = await updateSessionShareOverride(
    prisma,
    centerA.id,
    sessionManual.id,
    { centerShareType: "PERCENTAGE", centerShareValue: 50 },
    { now: live },
  );
  check("The session cut override is refused on a closed session", !overrideOnClosed.ok && overrideOnClosed.error === "sessionClosed");
  const [mA1After, mPay1After, mPay2After] = await Promise.all([
    prisma.sessionAttendee.findUniqueOrThrow({ where: { id: mA1.id } }),
    prisma.payment.findUniqueOrThrow({ where: { id: mPay1.id } }),
    prisma.payment.findUniqueOrThrow({ where: { id: mPay2.id } }),
  ]);
  check(
    "None of those refusals changed anything — statuses, payments, money fields",
    mA1After.attendanceStatus === mA1.attendanceStatus &&
      !mPay1After.voided &&
      !mPay2After.refunded &&
      (await prisma.payment.count({ where: { sessionId: sessionManual.id } })) === paymentsBefore &&
      (await prisma.sessionAttendanceChange.count({ where: { sessionId: sessionManual.id } })) === 0,
  );

  // The end-of-day path refuses each money write too (and closes on that touch).
  const sessionDayOverPay = await makeSession(day(9), "10:00", "12:00");
  const dA = await checkIn(sessionDayOverPay.id, s1, cairo(9, 10, 0));
  const payNextDay = await prisma.$transaction((tx) =>
    recordPayment(tx, centerA.id, dA.id, methodA.id, staff.id, { now: cairo(10, 9, 0) }),
  );
  const dayOverSession = await prisma.session.findUniqueOrThrow({ where: { id: sessionDayOverPay.id } });
  check(
    "A payment the day after is refused (sessionClosed) and the touch closed the session AUTO",
    !payNextDay.ok && payNextDay.error === "sessionClosed" && dayOverSession.closeMode === "AUTO",
    JSON.stringify(payNextDay),
  );

  // ── 4. Live PRESENT/LATE → ABSENT voids the payment atomically ─────────
  const sessionVoid = await makeSession(day(11), "16:00", "18:00");
  const vNow = cairo(11, 16, 30);
  const v1 = await checkIn(sessionVoid.id, s1, cairo(11, 16, 0));
  const v2 = await checkIn(sessionVoid.id, s2, cairo(11, 16, 0));
  const v7 = await checkIn(sessionVoid.id, s7, cairo(11, 16, 0));
  const v8 = await checkIn(sessionVoid.id, s8, cairo(11, 16, 0));
  const vPay1 = await pay(v1.id, vNow);
  const vPay2 = await pay(v2.id, vNow);
  const vPay7 = await pay(v7.id, vNow);
  const vPay8 = await pay(v8.id, vNow);
  const voidRange = { from: day(11), to: day(11) };
  const revenueBefore = await revenueTotals(prisma, centerA.id, voidRange);

  const withReason = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v1.id, status: "ABSENT", changedBy: staff.id, reason: "Checked in by mistake", mayVoidPayment: true },
    { now: vNow },
  );
  check(
    "PRESENT → ABSENT on a paid student voids the payment in the same call",
    withReason.ok &&
      withReason.attendee.attendanceStatus === "ABSENT" &&
      withReason.voidedPayment?.id === vPay1.id &&
      withReason.voidedPayment.voided === true &&
      withReason.voidedPayment.voidReason === "Checked in by mistake",
    JSON.stringify(withReason),
  );
  const vPay1Row = await prisma.payment.findUniqueOrThrow({ where: { id: vPay1.id } });
  check(
    "The voided payment's money fields are untouched (void, not refund — no Refund row)",
    vPay1Row.amount === vPay1.amount &&
      vPay1Row.centerShareSnapshot === vPay1.centerShareSnapshot &&
      vPay1Row.teacherShareSnapshot === vPay1.teacherShareSnapshot &&
      !vPay1Row.refunded &&
      (await prisma.refund.count({ where: { paymentId: vPay1.id } })) === 0,
  );
  if (withReason.ok && withReason.change) {
    check(
      "A SessionAttendanceChange row records from → to, the voided payment, the reason and the actor",
      withReason.change.fromStatus === "PRESENT" &&
        withReason.change.toStatus === "ABSENT" &&
        withReason.change.voidedPaymentId === vPay1.id &&
        withReason.change.reason === "Checked in by mistake" &&
        withReason.change.changedBy === staff.id &&
        withReason.change.centerId === centerA.id,
    );
  } else {
    check("A SessionAttendanceChange row was written", false);
  }
  const correctAudit = await prisma.auditLog.findMany({ where: { entityId: v1.id, action: "attendance.correct" } });
  const voidAudit = await prisma.auditLog.findMany({ where: { entityId: vPay1.id, action: "payment.void" } });
  check(
    "Both audit rows were written: attendance.correct and payment.void",
    correctAudit.length === 1 &&
      voidAudit.length === 1 &&
      correctAudit[0].actorUserId === staff.id &&
      (voidAudit[0].after as { trigger?: string } | null)?.trigger === "attendance.absent",
  );

  const noReason = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v2.id, status: "ABSENT", changedBy: staff.id, mayVoidPayment: true },
    { now: vNow },
  );
  const v2AfterRefusal = await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: v2.id } });
  check(
    "A change that voids a payment needs a reason (D-13): refused without one, nothing moves",
    !noReason.ok &&
      noReason.error === "reasonRequired" &&
      v2AfterRefusal.attendanceStatus === "PRESENT" &&
      !(await prisma.payment.findUniqueOrThrow({ where: { id: vPay2.id } })).voided,
  );
  // The same change with a reason goes through, so the totals below keep two voids.
  await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v2.id, status: "ABSENT", changedBy: staff.id, reason: "Left before class", mayVoidPayment: true },
    { now: vNow },
  );

  const notPermitted = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v7.id, status: "ABSENT", changedBy: staff.id, mayVoidPayment: false },
    { now: vNow },
  );
  const v7After = await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: v7.id } });
  check(
    "Without payment.void the change is refused and nothing moves (status, payment, change log)",
    !notPermitted.ok &&
      notPermitted.error === "voidNotPermitted" &&
      v7After.attendanceStatus === "PRESENT" &&
      !(await prisma.payment.findUniqueOrThrow({ where: { id: vPay7.id } })).voided &&
      (await prisma.sessionAttendanceChange.count({ where: { sessionId: sessionVoid.id, studentProfileId: s7 } })) === 0,
  );

  // Rollback: make the void itself fail inside the transaction.
  await dropRollbackTrigger();
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${ROLLBACK_TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW."id" = '${vPay8.id}' AND NEW."voided" = true THEN
         RAISE EXCEPTION 'session-lifecycle-check: forced void failure';
       END IF;
       RETURN NEW;
     END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${ROLLBACK_TRIGGER} BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION ${ROLLBACK_TRIGGER}()`,
  );
  let rollbackThrew = false;
  try {
    await changeAttendanceStatus(
      prisma,
      { centerId: centerA.id, attendeeId: v8.id, status: "ABSENT", changedBy: staff.id, reason: "Forced failure", mayVoidPayment: true },
      { now: vNow },
    );
  } catch {
    rollbackThrew = true;
  } finally {
    await dropRollbackTrigger();
  }
  const [v8After, vPay8After, v8Changes, v8Audits] = await Promise.all([
    prisma.sessionAttendee.findUniqueOrThrow({ where: { id: v8.id } }),
    prisma.payment.findUniqueOrThrow({ where: { id: vPay8.id } }),
    prisma.sessionAttendanceChange.count({ where: { sessionId: sessionVoid.id, studentProfileId: s8 } }),
    prisma.auditLog.count({ where: { entityId: { in: [v8.id, vPay8.id] } } }),
  ]);
  check(
    "If the void fails, the whole change rolls back: status, payment, change log and audit untouched",
    rollbackThrew &&
      v8After.attendanceStatus === "PRESENT" &&
      !vPay8After.voided &&
      v8Changes === 0 &&
      v8Audits === 0,
    JSON.stringify({ rollbackThrew, status: v8After.attendanceStatus, voided: vPay8After.voided, v8Changes, v8Audits }),
  );

  const backToPresent = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v1.id, status: "PRESENT", changedBy: staff.id, mayVoidPayment: true },
    { now: vNow },
  );
  check(
    "ABSENT → PRESENT is logged and creates no payment",
    backToPresent.ok &&
      backToPresent.change?.fromStatus === "ABSENT" &&
      backToPresent.voidedPayment === null &&
      (await prisma.payment.count({ where: { sessionAttendeeId: v1.id, voided: false } })) === 0,
  );
  const toLate = await changeAttendanceStatus(
    prisma,
    { centerId: centerA.id, attendeeId: v7.id, status: "LATE", changedBy: staff.id, mayVoidPayment: false },
    { now: vNow },
  );
  check(
    "Every status change is logged, not only voids (PRESENT → LATE on a paid student keeps the payment)",
    toLate.ok && toLate.change !== null && toLate.voidedPayment === null && !(await prisma.payment.findUniqueOrThrow({ where: { id: vPay7.id } })).voided,
  );

  const receipt = await sessionReceiptTotals(prisma, centerA.id, sessionVoid.id);
  check(
    "Receipt totals exclude the voided money (two of four payments remain)",
    receipt.collected === 2 * PRICE && receipt.paidCount === 2 && receipt.teacherShare === 2 * TEACHER_SHARE,
    JSON.stringify(receipt),
  );
  const revenueAfter = await revenueTotals(prisma, centerA.id, voidRange);
  check(
    "Analytics exclude it too — collected and both shares drop by exactly the two voided payments",
    revenueBefore.collected - revenueAfter.collected === 2 * PRICE &&
      revenueBefore.teacherShare - revenueAfter.teacherShare === 2 * TEACHER_SHARE &&
      revenueBefore.centerShare - revenueAfter.centerShare === 2 * FIXED_CUT,
    JSON.stringify({ revenueBefore, revenueAfter }),
  );
  const changeRows = await listSessionAttendanceChanges(prisma, centerA.id, sessionVoid.id);
  check(
    "The receipt's change list reads them back in order, with local names and the voided payment",
    changeRows.length === 4 &&
      changeRows[0].studentName.firstName === "S1" &&
      changeRows[0].changedByName?.lastName === "Desk" &&
      changeRows[0].voidedPaymentId === vPay1.id &&
      changeRows[3].voidedPaymentId === null,
    JSON.stringify(changeRows.map((row) => [row.studentName.firstName, row.fromStatus, row.toStatus])),
  );

  // ── 5. Settlements need a closed session ───────────────────────────────
  const settleLive = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, centerA.id, sessionVoid.id, staff.id, { now: cairo(11, 17, 0) }),
  );
  check("A session settlement on a live session is refused (sessionNotClosed)", !settleLive.ok && settleLive.error === "sessionNotClosed");
  await closeSession(prisma, centerA.id, sessionVoid.id, { closedBy: staff.id, now: cairo(11, 17, 30) });
  const settleClosed = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, centerA.id, sessionVoid.id, staff.id, { now: cairo(11, 17, 31) }),
  );
  check(
    "After close it is allowed — and the total excludes the voided payments",
    settleClosed.ok && settleClosed.settlement.totalAmount === 2 * TEACHER_SHARE,
    JSON.stringify(settleClosed),
  );

  // Period settlement counts only closed sessions.
  const teacher2 = await prisma.user.create({
    data: { firstName: "Omar", lastName: "Two", email: `${EMAIL_PREFIX}teacher2@kayedu.test`, locale: "en" },
  });
  const class2 = await prisma.classGroup.create({
    data: scopedData(centerA.id, { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), teacherId: teacher2.id, price: PRICE, centerShareType: "FIXED", centerShareValue: FIXED_CUT }),
  });
  const q1 = await prisma.session.create({
    data: scopedData(centerA.id, { classGroupId: class2.id, teacherId: teacher2.id, date: day(14), startTime: "10:00", endTime: "11:00", priceSnapshot: PRICE }),
  });
  const q2 = await prisma.session.create({
    data: scopedData(centerA.id, { classGroupId: class2.id, teacherId: teacher2.id, date: day(14), startTime: "16:00", endTime: "17:00", priceSnapshot: PRICE }),
  });
  const q1a = await checkIn(q1.id, s1, cairo(14, 10, 0));
  const q2a = await checkIn(q2.id, s1, cairo(14, 16, 0));
  await pay(q1a.id, cairo(14, 10, 1));
  const q2Pay = await pay(q2a.id, cairo(14, 16, 1));
  await closeSession(prisma, centerA.id, q1.id, { closedBy: staff.id, now: cairo(14, 11, 0) });
  const period = await prisma.$transaction(
    (tx) => createPeriodSettlement(tx, centerA.id, teacher2.id, day(14), day(14), staff.id, { now: cairo(14, 16, 30) }),
    { timeout: 30_000 },
  );
  check(
    "A period settlement counts only the closed session's payment — the live one is left out",
    period.ok && period.settlement.totalAmount === TEACHER_SHARE && period.settlement.closedSessionsOnly,
    JSON.stringify(period),
  );
  const refundLive = await prisma.$transaction((tx) =>
    refundPayment(tx, centerA.id, q2Pay.id, "cash back", staff.id, { now: cairo(14, 16, 40) }),
  );
  check(
    "Refunding the live session's payment inside that period's dates does not touch the period total (it was never counted)",
    refundLive.ok &&
      refundLive.adjustedSettlements.length === 0 &&
      period.ok &&
      (await prisma.settlement.findUniqueOrThrow({ where: { id: period.settlement.id } })).totalAmount === TEACHER_SHARE,
  );

  // A pre-R2 (legacy) DRAFT settlement that already counted a live payment:
  // a void live-adjusts it, like a refund always has.
  const legacySession = await makeSession(day(15), "16:00", "18:00");
  const lA = await checkIn(legacySession.id, s2, cairo(15, 16, 0));
  const lPay = await pay(lA.id, cairo(15, 16, 1));
  const legacy = await prisma.settlement.create({
    data: {
      centerId: centerA.id,
      teacherId: teacher.id,
      sessionId: legacySession.id,
      totalAmount: TEACHER_SHARE,
      createdBy: staff.id,
      closedSessionsOnly: false,
    },
  });
  const legacyVoid = await prisma.$transaction((tx) =>
    voidPayment(tx, centerA.id, lPay.id, "wrong student", staff.id, { now: cairo(15, 16, 30) }),
  );
  const legacyAfter = await prisma.settlement.findUniqueOrThrow({ where: { id: legacy.id } });
  check(
    "A void inside a pre-R2 DRAFT settlement's counted total live-adjusts it (and reports it for a settlement.adjust audit)",
    legacyVoid.ok &&
      legacyVoid.adjustedSettlements.length === 1 &&
      legacyVoid.adjustedSettlements[0].previousTotal === TEACHER_SHARE &&
      legacyAfter.totalAmount === 0,
    JSON.stringify({ legacyVoid, total: legacyAfter.totalAmount }),
  );
  const voidRefunded = await prisma.$transaction((tx) =>
    voidPayment(tx, centerA.id, q2Pay.id, "after refund", staff.id, { now: cairo(14, 16, 50) }),
  );
  check("A refunded payment cannot also be voided", !voidRefunded.ok && voidRefunded.error === "alreadyRefunded");

  // ── 6. Cross-centre isolation on the new model ─────────────────────────
  const aChange = await prisma.sessionAttendanceChange.findFirstOrThrow({ where: { centerId: centerA.id } });
  check(
    "Centre B cannot resolve Centre A's SessionAttendanceChange by id",
    (await scopedFindById(prisma.sessionAttendanceChange, centerB.id, aChange.id)) === null &&
      (await scopedFindById(prisma.sessionAttendanceChange, centerA.id, aChange.id)) !== null,
  );
  check(
    "Centre B's change list for Centre A's session is empty",
    (await listSessionAttendanceChanges(prisma, centerB.id, sessionVoid.id)).length === 0,
  );
  const crossChange = await changeAttendanceStatus(
    prisma,
    { centerId: centerB.id, attendeeId: v7.id, status: "ABSENT", changedBy: staff.id, mayVoidPayment: true },
    { now: vNow },
  );
  check("Centre B cannot change Centre A's attendee", !crossChange.ok && crossChange.error === "notFound");
  let crossCheckInRefused = false;
  try {
    await createAttendance(
      prisma,
      { centerId: centerB.id, sessionId: sessionLate.id, studentProfileId: s1, enrollmentId: null, isDropIn: true, recordedBy: staff.id },
      { now: cairo(7, 16, 0) },
    );
  } catch {
    crossCheckInRefused = true;
  }
  check("Centre B cannot check a student into Centre A's session", crossCheckInRefused);

  await checkVoidRefundReset();

  // ── 7. T5 — a void or refund on a live session resets attendance ───────
  async function checkVoidRefundReset() {
    console.log("\n7. T5 — void/refund on a live session resets attendance");
    const classT5 = await prisma.classGroup.create({
      data: scopedData(centerA.id, {
        startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"),
        teacherId: teacher.id, price: PRICE, centerShareType: "FIXED", centerShareValue: FIXED_CUT,
        lateThresholdMinutes: CLASS_THRESHOLD,
      }),
    });
    async function t5Student(code: string) {
      const user = await prisma.user.create({
        data: { firstName: code, lastName: "T5", email: `${EMAIL_PREFIX}${code.toLowerCase()}@kayedu.test`, locale: "en" },
      });
      const profile = await prisma.studentProfile.create({
        data: scopedData(centerA.id, { userId: user.id, studentCode: code, firstName: code, lastName: "Local" }),
      });
      return { userId: user.id, id: profile.id };
    }
    const [voider, refunder, enrolledReset, noShow, booker, racer] = await Promise.all(
      ["T5V", "T5R", "T5E", "T5N", "T5B", "T5C"].map(t5Student),
    );
    await prisma.enrollment.create({
      data: { centerId: centerA.id, studentProfileId: enrolledReset.id, classGroupId: classT5.id, status: "ACTIVE" },
    });
    const enrolledRow = await prisma.enrollment.findFirstOrThrow({ where: { studentProfileId: enrolledReset.id } });
    const live = await makeSession(day(16), "16:00", "18:00", classT5.id);
    const gateSession = { id: live.id, teacherId: teacher.id, classGroupId: classT5.id };

    // Void → reset → re-check-in → a NEW payment.
    const vA = await checkIn(live.id, voider.id, cairo(16, 16, 0));
    const p1 = await pay(vA.id, cairo(16, 16, 1));
    const voided = await prisma.$transaction((tx) =>
      voidPayment(tx, centerA.id, p1.id, "Wrong student", staff.id, { now: cairo(16, 16, 5) }),
    );
    const vAfterVoid = await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: vA.id } });
    check(
      "voiding a payment on a live session resets the attendee to ABSENT, in the same call, with one change row naming the void",
      voided.ok &&
        vAfterVoid.attendanceStatus === "ABSENT" &&
        voided.attendanceChange?.fromStatus === "PRESENT" &&
        voided.attendanceChange.toStatus === "ABSENT" &&
        voided.attendanceChange.voidedPaymentId === p1.id &&
        voided.attendanceChange.refundedPaymentId === null &&
        voided.attendanceChange.reason === "Wrong student" &&
        (await prisma.sessionAttendanceChange.count({ where: { sessionId: live.id, studentProfileId: voider.id } })) === 1,
      JSON.stringify(voided),
    );
    const voidResetAudit = await prisma.auditLog.findMany({ where: { entityId: vA.id, action: "attendance.correct" } });
    check(
      "the reset writes the attendance.correct audit row (ids only, trigger payment.void)",
      voidResetAudit.length === 1 &&
        (voidResetAudit[0].after as { trigger?: string; voidedPaymentId?: string } | null)?.trigger === "payment.void" &&
        (voidResetAudit[0].after as { voidedPaymentId?: string } | null)?.voidedPaymentId === p1.id &&
        !JSON.stringify(voidResetAudit[0].after).includes("Wrong student"),
    );
    const afterVoidTotals = await sessionReceiptTotals(prisma, centerA.id, live.id);
    check(
      "the reset student is Not arrived: out of the checked-in counts, not absent, not unpaid",
      afterVoidTotals.presentCount === 0 &&
        afterVoidTotals.lateCount === 0 &&
        afterVoidTotals.absentCount === 0 &&
        afterVoidTotals.notArrivedCount === 1 &&
        afterVoidTotals.unpaidCount === 0 &&
        afterVoidTotals.collected === 0 &&
        !afterVoidTotals.sessionClosed,
      JSON.stringify(afterVoidTotals),
    );
    const readyAgain = await studentSessionState(prisma, {
      centerId: centerA.id,
      session: gateSession,
      student: { id: voider.id, userId: voider.userId },
    });
    check("reception offers the reset student for check-in again (ready, not 'already')", readyAgain.outcome === "ready");
    const payWhileReset = await prisma.$transaction((tx) =>
      recordPayment(tx, centerA.id, vA.id, methodA.id, staff.id, { now: cairo(16, 16, 6) }),
    );
    check("a Not-arrived student cannot pay before checking in again", !payWhileReset.ok && payWhileReset.error === "attendanceNotPayable");
    const recheck = await recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: vA.id, recordedBy: staff.id }, { now: cairo(16, 16, 20) });
    check(
      "re-check-in: same row, Late decided by the server from this arrival, recordedAt = now, ABSENT → LATE logged",
      recheck.ok &&
        recheck.attendee.id === vA.id &&
        recheck.attendee.attendanceStatus === "LATE" &&
        recheck.attendee.recordedAt.getTime() === cairo(16, 16, 20).getTime() &&
        recheck.change.fromStatus === "ABSENT" &&
        recheck.change.toStatus === "LATE" &&
        (await prisma.sessionAttendee.count({ where: { sessionId: live.id, studentProfileId: voider.id } })) === 1,
      JSON.stringify(recheck),
    );
    const twice = await recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: vA.id, recordedBy: staff.id }, { now: cairo(16, 16, 21) });
    check("checking in a PRESENT/LATE row again is refused (alreadyCheckedIn)", !twice.ok && twice.error === "alreadyCheckedIn");
    const p2 = await pay(vA.id, cairo(16, 16, 22));
    const voiderPayments = await prisma.payment.findMany({ where: { sessionAttendeeId: vA.id }, orderBy: { recordedAt: "asc" } });
    check(
      "void then re-check-in then re-pay yields two payments: the first still voided and untouched, the second active with fresh snapshots",
      voiderPayments.length === 2 &&
        voiderPayments.filter((row) => row.voided).length === 1 &&
        voiderPayments.find((row) => row.id === p1.id)?.voided === true &&
        voiderPayments.find((row) => row.id === p1.id)?.amount === p1.amount &&
        p2.id !== p1.id && !p2.voided && !p2.refunded &&
        p2.priceSnapshot === PRICE && p2.centerShareSnapshot === FIXED_CUT && p2.teacherShareSnapshot === TEACHER_SHARE,
      JSON.stringify(voiderPayments.map((row) => [row.id, row.voided, row.refunded])),
    );

    // Refund → reset → re-check-in → re-pay: the refund frees the slot.
    const rA = await checkIn(live.id, refunder.id, cairo(16, 16, 2));
    const q1 = await pay(rA.id, cairo(16, 16, 3));
    const refunded = await prisma.$transaction((tx) =>
      refundPayment(tx, centerA.id, q1.id, "cash back", staff.id, { now: cairo(16, 16, 30) }),
    );
    check(
      "a refund on a live session resets the attendee too — the change row names the refund, not a void",
      refunded.ok &&
        refunded.attendanceChange?.toStatus === "ABSENT" &&
        refunded.attendanceChange.refundedPaymentId === q1.id &&
        refunded.attendanceChange.voidedPaymentId === null &&
        (await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: rA.id } })).attendanceStatus === "ABSENT",
      JSON.stringify(refunded),
    );
    const refundAudit = await prisma.auditLog.findMany({ where: { entityId: rA.id, action: "attendance.correct" } });
    check(
      "the refund's reset is audited (attendance.correct, trigger payment.refund)",
      refundAudit.length === 1 && (refundAudit[0].after as { trigger?: string } | null)?.trigger === "payment.refund",
    );
    await recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: rA.id, recordedBy: staff.id }, { now: cairo(16, 16, 31) });
    const q2 = await prisma.$transaction((tx) =>
      recordPayment(tx, centerA.id, rA.id, methodA.id, staff.id, { now: cairo(16, 16, 32) }),
    );
    const q1After = await prisma.payment.findUniqueOrThrow({ where: { id: q1.id }, include: { refund: true } });
    check(
      "a refunded payment frees the attendee's active-payment slot: re-pay works, the refund row and flag stay as they were",
      q2.ok &&
        q2.payment.id !== q1.id &&
        q1After.refunded && !q1After.voided && q1After.refund?.amount === q1.amount &&
        (await prisma.payment.count({ where: { sessionAttendeeId: rA.id, voided: false, refunded: false } })) === 1,
      JSON.stringify(q2),
    );

    // A refund/void that is already done is refused as before; a reason is still required.
    const voidAgain = await prisma.$transaction((tx) => voidPayment(tx, centerA.id, p1.id, "again", staff.id, { now: cairo(16, 16, 40) }));
    const refundAgain = await prisma.$transaction((tx) => refundPayment(tx, centerA.id, q1.id, "again", staff.id, { now: cairo(16, 16, 40) }));
    const noReason = await prisma.$transaction((tx) => voidPayment(tx, centerA.id, p2.id, "  ", staff.id, { now: cairo(16, 16, 40) }));
    check(
      "an already voided/refunded payment is refused as before, and a void still needs its reason (D-13)",
      !voidAgain.ok && voidAgain.error === "alreadyVoided" &&
        !refundAgain.ok && refundAgain.error === "alreadyRefunded" &&
        !noReason.ok && noReason.error === "reasonRequired",
    );

    // Concurrency: a void racing a re-check-in on one student — one transaction at a time, coherent result.
    const cA = await checkIn(live.id, racer.id, cairo(16, 16, 4));
    const c1 = await pay(cA.id, cairo(16, 16, 5));
    const [raceVoid, raceRecheck] = await Promise.all([
      prisma.$transaction((tx) => voidPayment(tx, centerA.id, c1.id, "race", staff.id, { now: cairo(16, 16, 41) })),
      recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: cA.id, recordedBy: staff.id }, { now: cairo(16, 16, 41) }),
    ]);
    const cAfter = await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: cA.id } });
    check(
      "a void racing a re-check-in serializes on the attendee row: no duplicate row, no second active payment, a coherent status",
      raceVoid.ok &&
        (await prisma.sessionAttendee.count({ where: { sessionId: live.id, studentProfileId: racer.id } })) === 1 &&
        (await prisma.payment.count({ where: { sessionAttendeeId: cA.id, voided: false, refunded: false } })) === 0 &&
        (raceRecheck.ok ? cAfter.attendanceStatus !== "ABSENT" : raceRecheck.error === "alreadyCheckedIn" && cAfter.attendanceStatus === "ABSENT"),
      JSON.stringify({ raceRecheck, status: cAfter.attendanceStatus }),
    );

    // F6 — a booking survives the reset and is linked (again) on re-check-in.
    await prisma.sessionBooking.create({
      data: { centerId: centerA.id, sessionId: live.id, studentId: booker.userId, status: "CONFIRMED" },
    });
    const bA = await checkIn(live.id, booker.id, cairo(16, 16, 6));
    const bPay = await pay(bA.id, cairo(16, 16, 7));
    await prisma.$transaction((tx) => voidPayment(tx, centerA.id, bPay.id, "wrong class", staff.id, { now: cairo(16, 16, 42) }));
    const bookingAfterReset = await prisma.sessionBooking.findFirstOrThrow({ where: { sessionId: live.id, studentId: booker.userId } });
    await prisma.sessionBooking.update({ where: { id: bookingAfterReset.id }, data: { sessionAttendeeId: null } });
    await recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: bA.id, recordedBy: staff.id }, { now: cairo(16, 16, 43) });
    const bookingAfterRecheck = await prisma.sessionBooking.findFirstOrThrow({ where: { sessionId: live.id, studentId: booker.userId } });
    check(
      "a reset does not cancel or unlink the booking (still CONFIRMED, linked to the same row); re-check-in links it again without conflict",
      bookingAfterReset.status === "CONFIRMED" &&
        bookingAfterReset.sessionAttendeeId === bA.id &&
        bookingAfterRecheck.status === "CONFIRMED" &&
        bookingAfterRecheck.sessionAttendeeId === bA.id,
      JSON.stringify({ bookingAfterReset, bookingAfterRecheck }),
    );
    // Leave the booker reset again (a drop-in who never came) for the exclusions below.
    const bPay2 = await pay(bA.id, cairo(16, 16, 44));
    await prisma.$transaction((tx) => voidPayment(tx, centerA.id, bPay2.id, "left", staff.id, { now: cairo(16, 16, 45) }));

    // A drop-in who is voided and never comes back, and an enrolled student who is reset.
    const nA = await checkIn(live.id, noShow.id, cairo(16, 16, 8));
    const nPay = await pay(nA.id, cairo(16, 16, 9));
    await prisma.$transaction((tx) => voidPayment(tx, centerA.id, nPay.id, "not this class", staff.id, { now: cairo(16, 16, 46) }));
    const eA = await checkIn(live.id, enrolledReset.id, cairo(16, 16, 10), enrolledRow.id);
    const ePay = await pay(eA.id, cairo(16, 16, 11));
    await prisma.$transaction((tx) => refundPayment(tx, centerA.id, ePay.id, "teacher absent", staff.id, { now: cairo(16, 16, 47) }));

    // The change log on the receipt.
    const changeLog = await sessionChangeLog(prisma, centerA.id, live.id);
    const voiderLog = changeLog.find((entry) => entry.studentProfileId === voider.id);
    check(
      "the receipt's change log reads checked in → paid → voided (amount, reason) → reset → checked in again → paid",
      voiderLog?.events.map((event) => event.kind).join() === "checkIn,payment,reversal,change,change,payment" &&
        voiderLog.events[2].kind === "reversal" &&
        voiderLog.events[2].reversal === "void" &&
        voiderLog.events[2].amount === PRICE &&
        voiderLog.events[2].reason === "Wrong student",
      JSON.stringify(voiderLog?.events.map((event) => event.kind)),
    );
    const refunderLog = changeLog.find((entry) => entry.studentProfileId === refunder.id);
    check(
      "a refund reads as a refund in the change log",
      refunderLog?.events.some((event) => event.kind === "reversal" && event.reversal === "refund" && event.reason === "cash back") === true,
    );

    // Close: the drop-in's ABSENT rows are no absence anywhere; the enrolled one is, as today.
    const closedT5 = await closeSession(prisma, centerA.id, live.id, { closedBy: staff.id, now: cairo(16, 18, 30) });
    check("End session closes it (materializeAbsences stays idempotent: the reset rows already exist)", closedT5.ok && closedT5.absentCreated === 0, JSON.stringify(closedT5));
    const closedTotals = await sessionReceiptTotals(prisma, centerA.id, live.id);
    // The race above may legally end either way; the racer is a drop-in.
    const racerIn = cAfter.attendanceStatus !== "ABSENT";
    check(
      "the closed receipt counts the enrolled reset student as absent and no drop-in no-show",
      closedTotals.sessionClosed &&
        closedTotals.absentCount === 1 &&
        closedTotals.notArrivedCount === (racerIn ? 2 : 3) &&
        closedTotals.lateCount + closedTotals.presentCount === (racerIn ? 3 : 2),
      JSON.stringify(closedTotals),
    );
    check(
      "a drop-in ABSENT row is not in the absence streak; the enrolled one still is",
      (await consecutiveAbsenceCount(prisma, centerA.id, classT5.id, noShow.id, day(16))) === 0 &&
        (await consecutiveAbsenceCount(prisma, centerA.id, classT5.id, enrolledReset.id, day(16))) === 1,
    );
    const statusCounts = await attendanceStatusCounts(prisma, centerA.id, { from: day(16), to: day(16) });
    check("analytics' absences exclude the drop-in no-shows (one enrolled absence)", statusCounts.ABSENT === 1, JSON.stringify(statusCounts));
    const noShowHistory = await studentPastAttendance(prisma, centerA.id, noShow.id, day(17));
    const enrolledHistory = await studentPastAttendance(prisma, centerA.id, enrolledReset.id, day(17));
    check(
      "the drop-in no-show has no past session in the student/parent history; the enrolled absence is still there",
      noShowHistory.every((row) => row.sessionId !== live.id) && enrolledHistory.some((row) => row.sessionId === live.id),
    );
    check(
      "nor in the teacher's history with that student",
      (await studentSessionsWithTeacher(prisma, centerA.id, teacher.id, noShow.id)).every((row) => row.sessionId !== live.id),
    );
    const toRate = await attendedSessionsToRate(prisma, noShow.userId, cairo(16, 20, 0));
    const voiderToRate = await attendedSessionsToRate(prisma, voider.userId, cairo(16, 20, 0));
    const rateReset = await submitSessionRating(prisma, { studentUserId: enrolledReset.userId, sessionId: live.id, score: 5, now: cairo(16, 20, 0) });
    check(
      "ratings exclude ABSENT: a reset or no-show student is not asked and cannot rate; the re-checked-in one is asked",
      toRate.every((row) => row.sessionId !== live.id) &&
        voiderToRate.some((row) => row.sessionId === live.id) &&
        !rateReset.ok && rateReset.error === "notAttended",
    );

    // Revenue and settlements see only the live payments.
    const revenue = await revenueTotals(prisma, centerA.id, { from: day(16), to: day(16) });
    const settled = await prisma.$transaction((tx) =>
      createSessionSettlement(tx, centerA.id, live.id, staff.id, { now: cairo(16, 18, 31) }),
    );
    check(
      "revenue and the settlement count only the live payments (the re-payments), never the voided or refunded ones",
      revenue.collected === 2 * PRICE &&
        revenue.teacherShare === 2 * TEACHER_SHARE &&
        settled.ok &&
        settled.settlement.totalAmount === 2 * TEACHER_SHARE,
      JSON.stringify({ revenue, settled }),
    );

    // A closed session refuses void, refund and re-check-in.
    const voidClosed = await prisma.$transaction((tx) => voidPayment(tx, centerA.id, p2.id, "late", staff.id, { now: cairo(16, 18, 40) }));
    const refundClosed = await prisma.$transaction((tx) => refundPayment(tx, centerA.id, p2.id, "late", staff.id, { now: cairo(16, 18, 40) }));
    const recheckClosed = await recheckInAttendee(prisma, { centerId: centerA.id, attendeeId: nA.id, recordedBy: staff.id }, { now: cairo(16, 18, 40) });
    check(
      "a closed session refuses void, refund and re-check-in (sessionClosed), and nothing moved",
      !voidClosed.ok && voidClosed.error === "sessionClosed" &&
        !refundClosed.ok && refundClosed.error === "sessionClosed" &&
        !recheckClosed.ok && recheckClosed.error === "sessionClosed" &&
        (await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: nA.id } })).attendanceStatus === "ABSENT" &&
        !(await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).voided,
    );
    const crossRecheck = await recheckInAttendee(prisma, { centerId: centerB.id, attendeeId: nA.id, recordedBy: staff.id }, { now: cairo(16, 16, 50) });
    check("Centre B cannot re-check-in Centre A's attendee (notFound)", !crossRecheck.ok && crossRecheck.error === "notFound");

    // historicalBackfill (scripts) states history explicitly: no reset.
    const backfillSession = await makeSession(day(2), "10:00", "11:00", classT5.id);
    const hA = await createAttendance(
      prisma,
      { centerId: centerA.id, sessionId: backfillSession.id, studentProfileId: racer.id, enrollmentId: null, isDropIn: true, recordedBy: staff.id },
      { historicalBackfill: true, status: "PRESENT" },
    );
    const hPay = await prisma.$transaction((tx) => recordPayment(tx, centerA.id, hA.id, methodA.id, staff.id, { historicalBackfill: true }));
    const hVoid = hPay.ok
      ? await prisma.$transaction((tx) => voidPayment(tx, centerA.id, hPay.payment.id, "backfill", staff.id, { historicalBackfill: true }))
      : null;
    check(
      "a historicalBackfill void leaves the attendance it was told about (no reset)",
      hVoid?.ok === true &&
        hVoid.attendanceChange === null &&
        (await prisma.sessionAttendee.findUniqueOrThrow({ where: { id: hA.id } })).attendanceStatus === "PRESENT",
    );
  }
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
      console.error(`\n${failures} session-lifecycle check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll session-lifecycle checks passed.");
  });
