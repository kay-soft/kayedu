/**
 * Notifications check — the W1 acceptance gate (docs/03-build-order.md W1
 * "Gates"; D-W12, docs/00 §5.1 "W-batch").
 *
 * Run with:  npm run check:notifications   (staging or a local database only — S1)
 *
 * Exercises the REAL producers through the real event writers
 * (`confirmReservation`, `rejectReservation`, `confirmBooking`,
 * `rejectBooking`, `cancelSession`, `rescheduleSession`, `createBranchPause`)
 * and the real reads in `lib/db/notifications.ts`, outside the Next.js runtime:
 *
 *  1. Producers — each event writes exactly one notice per recipient: the
 *     requester on an enrolment or booking decision; each ACTIVE enrolled
 *     student and each confirmed booker on a cancel (one session, or a branch
 *     pause) or a reschedule (payload: the old session and the new one).
 *     A student with no relation to the session gets nothing.
 *  2. Same transaction — an event rolled back leaves no notice, and every
 *     producer call in lib/db hands on the event's own `tx` (static).
 *  3. Dedupe — the same event twice writes one row.
 *  4. Own notices only — another person lists none of them, cannot open one
 *     (it stays unread) and "mark all" never touches them.
 *  5. Access re-check — a deactivated profile hides session notices, a
 *     suspended or deleted branch hides every notice about it; nothing is
 *     deleted, and restoring access shows them again.
 *  6. Ids only — every payload is exactly its kind's uuids; a name is refused
 *     by the writer and by the database CHECK.
 *  7. RLS on the table, zero policies.
 *  8. Email — with EMAIL_ENABLED off nothing is sent; there is no cron.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { readFileSync } from "node:fs";

import type { NotificationKind, Prisma } from "@prisma/client";

import { gatePrisma } from "./lib/gate-db.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { createBranchPause } from "../lib/db/branch-admin.ts";
import {
  NotificationPayloadError,
  countUnread,
  listNotifications,
  loadNotificationSubjects,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  notifyReservationResolved,
  notifySessionCancelled,
  type NotificationReach,
} from "../lib/db/notifications.ts";
import { confirmReservation, rejectReservation } from "../lib/db/reservations.ts";
import { confirmBooking, rejectBooking } from "../lib/db/session-bookings.ts";
import { cancelSession, rescheduleSession } from "../lib/db/sessions.ts";
import { NOTIFICATION_KIND_LIST, isIdsOnlyPayload } from "../lib/notifications/kinds.ts";
import { emailEnabled, queueNotificationEmails } from "../lib/notify/email.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const STEM = "notifications-check";
const SLUG_A = `${STEM}-a`;
const SLUG_B = `${STEM}-b`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  // Notices cascade with their branch and with their recipient.
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: STEM } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `${STEM}-` } } });
}

/** A UTC-midnight day marker `days` from today, and its "YYYY-MM-DD" key. */
function day(days: number): { date: Date; key: string } {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  return { date, key: date.toISOString().slice(0, 10) };
}

async function makeUser(tag: string) {
  return prisma.user.create({
    data: { firstName: "N", lastName: tag, email: `${STEM}-${tag}@kayedu.test`, locale: "en" },
  });
}

async function makeCenter(slug: string) {
  return prisma.center.create({
    data: { slug, name: slug, organization: { create: { name: slug } } },
  });
}

async function makeClass(centerId: string, teacherId: string, extra: Partial<Prisma.ClassGroupUncheckedCreateInput> = {}) {
  return prisma.classGroup.create({
    data: {
      centerId,
      teacherId,
      price: 10_000,
      startDate: day(-30).date,
      endDate: day(120).date,
      ...extra,
    },
  });
}

async function makeSession(centerId: string, classGroupId: string, teacherId: string, days: number, startTime: string) {
  const [hours, minutes] = startTime.split(":").map(Number);
  const endTime = `${String(hours + 1).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return prisma.session.create({
    data: { centerId, classGroupId, teacherId, date: day(days).date, startTime, endTime, priceSnapshot: 10_000 },
  });
}

async function reach(userId: string): Promise<NotificationReach> {
  const relations = await resolveCenterRelations(prisma, userId);
  return { relationCenterIds: relations.map((relation) => relation.center.id) };
}

async function rowsFor(userId: string, kind?: NotificationKind) {
  return prisma.notification.findMany({
    where: { userId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "asc" },
  });
}

/** A payload equals the expected ids — key order aside (JSONB stores keys in its own order). */
function samePayload(actual: unknown, expected: Record<string, string>): boolean {
  if (!actual || typeof actual !== "object") return false;
  const entries = Object.entries(actual as Record<string, unknown>);
  return entries.length === Object.keys(expected).length && entries.every(([key, value]) => expected[key] === value);
}

/** Runs `fn` in a transaction that is then rolled back on purpose. */
async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<boolean> {
  const marker = new Error("rollback on purpose");
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw marker;
    });
  } catch (error) {
    return error === marker;
  }
  return false;
}

// ── 2 (static) & 8: every producer gets the event's own tx; no cron, no sender ─

function checkStatic() {
  console.log("Static: producers, email, cron");
  const writers = ["lib/db/reservations.ts", "lib/db/session-bookings.ts", "lib/db/sessions.ts"];
  const calls = writers.flatMap((file) =>
    [...readFileSync(`${ROOT}/${file}`, "utf8").matchAll(/\bnotify\w+\(\s*(\w+)\s*,/g)].map((match) => ({
      file,
      arg: match[1],
    })),
  );
  check(
    "The six producer calls sit in the three event writers",
    calls.length === 6,
    JSON.stringify(calls),
  );
  check(
    "Every producer call hands on the event's own transaction (`tx`)",
    calls.every((call) => call.arg === "tx"),
    JSON.stringify(calls.filter((call) => call.arg !== "tx")),
  );

  const email = readFileSync(`${ROOT}/lib/notify/email.ts`, "utf8");
  check("lib/notify/email.ts imports nothing and calls no network — no sender exists yet", !/^import /m.test(email) && !/fetch\(/.test(email));
  const vercel = JSON.parse(readFileSync(`${ROOT}/vercel.json`, "utf8")) as Record<string, unknown>;
  check("No cron is configured (vercel.json has no `crons`)", !("crons" in vercel));

  const before = process.env.EMAIL_ENABLED;
  delete process.env.EMAIL_ENABLED;
  const off = !emailEnabled() && queueNotificationEmails([{ userId: "u", kind: "SESSION_CANCELLED" }]).status === "off";
  process.env.EMAIL_ENABLED = "true";
  const onButNoSender = queueNotificationEmails([{ userId: "u", kind: "SESSION_CANCELLED" }]).status === "noSender";
  if (before === undefined) delete process.env.EMAIL_ENABLED;
  else process.env.EMAIL_ENABLED = before;
  check("EMAIL_ENABLED unset → off: the hook sends nothing", off);
  check("EMAIL_ENABLED=true still sends nothing until M20's sender exists", onButNoSender);
  check("This run's environment has EMAIL_ENABLED off", !emailEnabled());
}

async function main() {
  await cleanup();
  checkStatic();

  console.log("\nDatabase-backed checks");
  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const manager = await makeUser("manager");
  const teacher = await makeUser("teacher");
  const student = await makeUser("student"); // the one who is notified
  const booker = await makeUser("booker"); // books a session, never enrolled
  const outsider = await makeUser("outsider"); // no relation to anything here

  const classA = await makeClass(centerA.id, teacher.id, { sessionBookingMode: "APPROVAL" });
  const classDeclined = await makeClass(centerA.id, teacher.id);
  const classRollback = await makeClass(centerA.id, teacher.id);
  const classB = await makeClass(centerB.id, teacher.id);

  // ── 1. Enrolment request approved / declined ──────────────────────────────
  console.log("\n1. Producers");
  const approveMe = await prisma.reservation.create({
    data: { centerId: centerA.id, classGroupId: classA.id, studentId: student.id },
  });
  const approved = await prisma.$transaction((tx) => confirmReservation(tx, centerA.id, approveMe.id, manager.id));
  const approvedRows = await rowsFor(student.id, "ENROLLMENT_APPROVED");
  check("Approving a request confirms it", approved.ok, JSON.stringify(approved));
  check(
    "…and writes one ENROLLMENT_APPROVED notice for the student, about this branch, naming the request and class",
    approvedRows.length === 1 &&
      approvedRows[0].centerId === centerA.id &&
      samePayload(approvedRows[0].payload, { reservationId: approveMe.id, classGroupId: classA.id }),
    JSON.stringify(approvedRows),
  );

  const declineMe = await prisma.reservation.create({
    data: { centerId: centerA.id, classGroupId: classDeclined.id, studentId: student.id },
  });
  const declined = await rejectReservation(prisma, centerA.id, declineMe.id, manager.id);
  check("Declining a request rejects it", declined.ok, JSON.stringify(declined));
  check(
    "…and writes one ENROLLMENT_DECLINED notice for the student",
    (await rowsFor(student.id, "ENROLLMENT_DECLINED")).length === 1,
  );

  // A request at the other branch, declined — the student holds no profile there.
  const declineAtB = await prisma.reservation.create({
    data: { centerId: centerB.id, classGroupId: classB.id, studentId: student.id },
  });
  await rejectReservation(prisma, centerB.id, declineAtB.id, manager.id);

  // ── Bookings (F6) approved / declined ─────────────────────────────────────
  const bookedSession = await makeSession(centerA.id, classA.id, teacher.id, 10, "10:00");
  const bookingYes = await prisma.sessionBooking.create({
    data: { centerId: centerA.id, sessionId: bookedSession.id, studentId: booker.id },
  });
  const bookingOk = await prisma.$transaction((tx) => confirmBooking(tx, centerA.id, bookingYes.id, manager.id));
  check("Approving a booking confirms it", bookingOk.ok, JSON.stringify(bookingOk));
  const bookingRows = await rowsFor(booker.id, "BOOKING_APPROVED");
  check(
    "…and writes one BOOKING_APPROVED notice for the booker, naming the booking and its session",
    bookingRows.length === 1 &&
      samePayload(bookingRows[0].payload, { bookingId: bookingYes.id, sessionId: bookedSession.id }),
    JSON.stringify(bookingRows),
  );
  const otherSession = await makeSession(centerA.id, classA.id, teacher.id, 11, "10:00");
  const bookingNo = await prisma.sessionBooking.create({
    data: { centerId: centerA.id, sessionId: otherSession.id, studentId: booker.id },
  });
  const bookingRejected = await prisma.$transaction((tx) => rejectBooking(tx, centerA.id, bookingNo.id, manager.id));
  check("Declining a booking rejects it", bookingRejected.ok, JSON.stringify(bookingRejected));
  check("…and writes one BOOKING_DECLINED notice for the booker", (await rowsFor(booker.id, "BOOKING_DECLINED")).length === 1);

  // ── Session cancelled: enrolled student + confirmed booker, nobody else ────
  const cancelled = await cancelSession(prisma, centerA.id, bookedSession.id);
  check("Cancelling the session succeeds", cancelled.ok, JSON.stringify(cancelled));
  const cancelRows = await prisma.notification.findMany({
    where: { kind: "SESSION_CANCELLED", payload: { equals: { sessionId: bookedSession.id } } },
  });
  check(
    "…and notifies exactly the ACTIVE enrolled student and the confirmed booker",
    cancelRows.length === 2 && new Set(cancelRows.map((row) => row.userId)).size === 2 &&
      cancelRows.every((row) => [student.id, booker.id].includes(row.userId)),
    JSON.stringify(cancelRows.map((row) => row.userId)),
  );
  check("…and nobody unrelated is notified", (await rowsFor(outsider.id)).length === 0);

  // ── Session rescheduled: old and new ──────────────────────────────────────
  const moveMe = await makeSession(centerA.id, classA.id, teacher.id, 12, "12:00");
  await prisma.sessionBooking.create({
    data: { centerId: centerA.id, sessionId: moveMe.id, studentId: booker.id, status: "CONFIRMED", resolvedAt: new Date() },
  });
  const target = day(31);
  const moved = await rescheduleSession(
    prisma,
    centerA.id,
    moveMe.id,
    { date: target.date, startTime: "15:00", endTime: "16:00" },
    "WARN",
    "en",
    { confirmConflicts: false },
  );
  check("Rescheduling the session succeeds", moved.ok, JSON.stringify(moved));
  const movedRows = await prisma.notification.findMany({
    where: { kind: "SESSION_RESCHEDULED", payload: { path: ["sessionId"], equals: moveMe.id } },
  });
  check(
    "…and notifies the enrolled student and the confirmed booker, with the old and the new session",
    moved.ok &&
      movedRows.length === 2 &&
      movedRows.every(
        (row) =>
          [student.id, booker.id].includes(row.userId) &&
          samePayload(row.payload, { sessionId: moveMe.id, newSessionId: moved.session.id }),
      ),
    JSON.stringify(movedRows),
  );
  if (moved.ok) {
    const subjects = await loadNotificationSubjects(prisma, movedRows);
    const from = subjects.sessions.get(moveMe.id);
    const to = subjects.sessions.get(moved.session.id);
    check(
      "The text's names load at read time: the old slot and the new slot, from the ids",
      from?.startTime === "12:00" && to?.startTime === "15:00" && to.date.getTime() === target.date.getTime() &&
        subjects.branches.get(centerA.id)?.name === SLUG_A,
      JSON.stringify({ from, to }),
    );
  }

  // ── Branch pause: its cancellations notify too (through cancelSession) ────
  const pausedSession = await makeSession(centerA.id, classA.id, teacher.id, 20, "09:00");
  const pause = await createBranchPause(prisma, {
    centerId: centerA.id,
    startDate: day(20).key,
    endDate: day(21).key,
    reason: null,
    actorUserId: manager.id,
  });
  check("A branch pause over a session's day is created", pause.ok, JSON.stringify(pause));
  check(
    "…and the session it cancels notifies the enrolled student",
    (await prisma.notification.count({
      where: { userId: student.id, kind: "SESSION_CANCELLED", payload: { equals: { sessionId: pausedSession.id } } },
    })) === 1,
  );

  // ── 2. Same transaction: a rolled-back event leaves no notice ─────────────
  console.log("\n2. Inside the event's transaction");
  const rollbackRequest = await prisma.reservation.create({
    data: { centerId: centerA.id, classGroupId: classRollback.id, studentId: booker.id },
  });
  const before = await prisma.notification.count();
  check(
    "An approval rolled back leaves no notice and the request PENDING",
    (await rolledBack((tx) => confirmReservation(tx, centerA.id, rollbackRequest.id, manager.id))) &&
      (await prisma.notification.count()) === before &&
      (await prisma.reservation.findUniqueOrThrow({ where: { id: rollbackRequest.id } })).status === "PENDING",
  );
  check(
    "A decline rolled back leaves no notice and the request PENDING",
    (await rolledBack((tx) => rejectReservation(tx, centerA.id, rollbackRequest.id, manager.id))) &&
      (await prisma.notification.count()) === before &&
      (await prisma.reservation.findUniqueOrThrow({ where: { id: rollbackRequest.id } })).status === "PENDING",
  );
  const rollbackBookingSession = await makeSession(centerA.id, classA.id, teacher.id, 13, "10:00");
  const rollbackBooking = await prisma.sessionBooking.create({
    data: { centerId: centerA.id, sessionId: rollbackBookingSession.id, studentId: outsider.id },
  });
  check(
    "A booking approval rolled back leaves no notice",
    (await rolledBack((tx) => confirmBooking(tx, centerA.id, rollbackBooking.id, manager.id))) &&
      (await prisma.notification.count()) === before,
  );
  const rollbackSession = await makeSession(centerA.id, classA.id, teacher.id, 14, "10:00");
  check(
    "A cancellation rolled back leaves no notice and the session SCHEDULED",
    (await rolledBack((tx) => cancelSession(tx, centerA.id, rollbackSession.id))) &&
      (await prisma.notification.count()) === before &&
      (await prisma.session.findUniqueOrThrow({ where: { id: rollbackSession.id } })).status === "SCHEDULED",
  );

  // ── 3. Dedupe ─────────────────────────────────────────────────────────────
  console.log("\n3. Dedupe");
  const approvedRequest = await prisma.reservation.findUniqueOrThrow({ where: { id: approveMe.id } });
  await prisma.$transaction((tx) => notifyReservationResolved(tx, approvedRequest, "approved"));
  await prisma.$transaction((tx) => notifySessionCancelled(tx, centerA.id, bookedSession.id));
  check("Producing the same approval twice keeps one row", (await rowsFor(student.id, "ENROLLMENT_APPROVED")).length === 1);
  check(
    "Producing the same cancellation twice keeps one row per recipient",
    (await prisma.notification.count({
      where: { kind: "SESSION_CANCELLED", payload: { equals: { sessionId: bookedSession.id } } },
    })) === 2,
  );
  const again = await prisma.$transaction((tx) => confirmReservation(tx, centerA.id, approveMe.id, manager.id));
  check(
    "Approving an already-approved request is refused and writes nothing",
    !again.ok && (await rowsFor(student.id, "ENROLLMENT_APPROVED")).length === 1,
    JSON.stringify(again),
  );

  // ── 4. Own notices only ───────────────────────────────────────────────────
  console.log("\n4. Own notices only");
  const studentReach = await reach(student.id);
  const outsiderReach = await reach(outsider.id);
  const studentList = await listNotifications(prisma, student.id, studentReach, { skip: 0, take: 50 });
  check(
    "The student's inbox lists only their own notices",
    studentList.rows.length > 0 && studentList.rows.every((row) => row.userId === student.id),
  );
  const outsiderList = await listNotifications(prisma, outsider.id, outsiderReach, { skip: 0, take: 50 });
  check("Another person's inbox lists none of them", outsiderList.total === 0 && (await countUnread(prisma, outsider.id, outsiderReach)) === 0);
  const someoneElses = studentList.rows[0];
  check(
    "Another person opening the student's notice by id gets nothing, and it stays unread",
    (await markNotificationRead(prisma, outsider.id, outsiderReach, someoneElses.id)) === null &&
      (await prisma.notification.findUniqueOrThrow({ where: { id: someoneElses.id } })).readAt === null,
  );
  await markAllNotificationsRead(prisma, outsider.id, outsiderReach);
  check(
    "Another person's \"mark all as read\" leaves the student's notices unread",
    (await countUnread(prisma, student.id, studentReach)) === studentList.total,
  );
  const opened = await markNotificationRead(prisma, student.id, studentReach, someoneElses.id);
  check(
    "The student opening their own notice marks it read, once",
    opened?.readAt instanceof Date && (await countUnread(prisma, student.id, studentReach)) === studentList.total - 1,
  );

  // ── 5. Access re-check ────────────────────────────────────────────────────
  console.log("\n5. Access re-check — hidden, never deleted");
  const stored = await prisma.notification.count({ where: { userId: student.id } });
  const visibleKinds = async () =>
    (await listNotifications(prisma, student.id, await reach(student.id), { skip: 0, take: 50 })).rows.map(
      (row) => `${row.kind}@${row.centerId === centerA.id ? "A" : "B"}`,
    );
  const all = await visibleKinds();
  check(
    "With full access the student sees every notice, the declined request at a branch they never joined included",
    all.length === stored && all.includes("ENROLLMENT_DECLINED@B") && all.includes("SESSION_CANCELLED@A"),
    JSON.stringify(all),
  );

  const profile = await prisma.studentProfile.findFirstOrThrow({ where: { userId: student.id, centerId: centerA.id } });
  await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: false } });
  const noProfile = await visibleKinds();
  check(
    "A deactivated profile hides the branch's session notices; the student's own request answers stay",
    !noProfile.some((entry) => entry.startsWith("SESSION_")) && noProfile.includes("ENROLLMENT_APPROVED@A"),
    JSON.stringify(noProfile),
  );
  await prisma.studentProfile.update({ where: { id: profile.id }, data: { active: true } });

  await prisma.center.update({ where: { id: centerA.id }, data: { lifecycleState: "SUSPENDED" } });
  const suspended = await visibleKinds();
  check(
    "A suspended branch hides every notice about it; another branch's stay",
    suspended.every((entry) => entry.endsWith("@B")) && suspended.length > 0,
    JSON.stringify(suspended),
  );
  await prisma.center.update({ where: { id: centerA.id }, data: { lifecycleState: "ACTIVE" } });

  const deletedAt = new Date();
  await prisma.center.update({
    where: { id: centerA.id },
    data: { deletedAt, deletedBy: manager.id, restorableUntil: new Date(deletedAt.getTime() + 30 * 86_400_000) },
  });
  const deleted = await visibleKinds();
  check("A deleted branch hides every notice about it", deleted.every((entry) => entry.endsWith("@B")), JSON.stringify(deleted));
  check(
    "A hidden notice cannot be opened",
    (await markNotificationRead(prisma, student.id, await reach(student.id), cancelRows[0].id)) === null,
  );
  await prisma.center.update({ where: { id: centerA.id }, data: { deletedAt: null, deletedBy: null, restorableUntil: null } });
  check("Nothing was deleted: every row is still stored", (await prisma.notification.count({ where: { userId: student.id } })) === stored);
  check("Restoring access shows them all again", (await visibleKinds()).length === stored);

  // ── 6. Ids only ───────────────────────────────────────────────────────────
  console.log("\n6. Payload holds ids only");
  const gateRows = await prisma.notification.findMany({ where: { centerId: { in: [centerA.id, centerB.id] } } });
  check(
    "Every notice's payload is exactly its kind's ids, each a uuid",
    gateRows.length > 0 &&
      gateRows.every(
        (row) =>
          isIdsOnlyPayload(row.kind, row.payload) &&
          Object.values(row.payload as Record<string, string>).every((value) => UUID.test(value)),
      ),
  );
  check(
    "No payload carries a person's name or email",
    gateRows.every((row) => !/kayedu\.test|"N"|student|booker/.test(JSON.stringify(row.payload))),
  );
  let writerRefused = false;
  try {
    await prisma.$transaction((tx) =>
      notify(tx, [
        { userId: student.id, kind: "SESSION_CANCELLED", centerId: centerA.id, payload: { sessionId: "Ahmed Ali" }, dedupeKey: `${STEM}-bad-1` },
      ]),
    );
  } catch (error) {
    writerRefused = error instanceof NotificationPayloadError;
  }
  check("The writer refuses a payload that is not ids", writerRefused);
  let databaseRefused = false;
  try {
    await prisma.notification.create({
      data: { userId: student.id, kind: "SESSION_CANCELLED", centerId: centerA.id, payload: { name: "Ahmed" }, dedupeKey: `${STEM}-bad-2` },
    });
  } catch {
    databaseRefused = true;
  }
  check("The database CHECK refuses a name in a payload", databaseRefused);
  check("Every kind declares its ids (the catalogue covers the enum)", NOTIFICATION_KIND_LIST.length === 6);

  // ── 7. RLS ────────────────────────────────────────────────────────────────
  console.log("\n7. Row-level security");
  const [rls] = await prisma.$queryRaw<{ on: boolean }[]>`
    SELECT c.relrowsecurity AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'Notification'`;
  const [policies] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'Notification'`;
  check("RLS is on for Notification", rls?.on === true);
  check("Notification carries zero policies (deny-all to the Data API)", Number(policies?.count ?? -1) === 0);
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nAll notification checks passed." : `\n${failures} notification check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
