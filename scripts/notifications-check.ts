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
 *  9–15. W3b (D-W32), through the real `publishAssessment`, `extendAssessment`,
 *     `deleteAssessment` and `syncAssessmentSoonNotices`: each assessment kind,
 *     the thresholds at their edges, dedupe on repeat and concurrent reads, every
 *     hiding case of the re-check, rolled-back writers, deletion, ids only.
 *
 * Needs a reachable database and cleans up after itself.
 */


import type { NotificationKind, Prisma } from "@prisma/client";
import { IntlMessageFormat } from "intl-messageformat";

import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { gatePrisma } from "./lib/gate-db.ts";
import { assessmentDefaults, type AssessmentDraft } from "../lib/assessments.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { startAttempt, submitAttempt, type AssessmentStudent } from "../lib/db/assessment-attempts.ts";
import {
  createAssessment,
  deleteAssessment,
  extendAssessment,
  publishAssessment,
  unpublishAssessment,
  type AssessmentTeacher,
} from "../lib/db/assessments.ts";
import { createBranchPause } from "../lib/db/branch-admin.ts";
import {
  NotificationPayloadError,
  countUnread,
  hiddenAssessmentNoticeIds,
  listNotifications,
  loadNotificationSubjects,
  markAllNotificationsRead,
  markNotificationRead,
  notify,
  notifyAssessmentExtended,
  notifyAssessmentPublished,
  notifyReservationResolved,
  notifySessionCancelled,
  syncAssessmentSoonNotices,
  type NotificationReach,
} from "../lib/db/notifications.ts";
import { confirmReservation, rejectReservation } from "../lib/db/reservations.ts";
import { confirmBooking, rejectBooking } from "../lib/db/session-bookings.ts";
import { cancelSession, rescheduleSession } from "../lib/db/sessions.ts";
import {
  ASSESSMENT_NOTICE_KINDS,
  ASSESSMENT_SOON,
  NOTIFICATION_KIND_LIST,
  assessmentSoonNotice,
  dedupeKeys,
  isIdsOnlyPayload,
  notificationHref,
} from "../lib/notifications/kinds.ts";
import { emailEnabled, queueNotificationEmails } from "../lib/notify/email.ts";
import { readSource } from "./lib/source.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const STEM = "notifications-check";
const SLUG_A = `${STEM}-a`;
const SLUG_B = `${STEM}-b`;
const SLUG_W3B = `${STEM}-w3b`;
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
  // Notices cascade with their branch and with their recipient. The W3b branch's
  // assessment writers audit, and the log is append-only (a trigger).
  const audited = await prisma.center.findMany({ where: { slug: SLUG_W3B }, select: { id: true } });
  if (audited.length > 0) await deleteAuditRows(prisma, { centerId: { in: audited.map((center) => center.id) } });
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B, SLUG_W3B] } } });
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
    [...readSource(`${ROOT}/${file}`).matchAll(/\bnotify\w+\(\s*(\w+)\s*,/g)].map((match) => ({
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

  const email = readSource(`${ROOT}/lib/notify/email.ts`);
  check("lib/notify/email.ts imports nothing and calls no network — no sender exists yet", !/^import /m.test(email) && !/fetch\(/.test(email));
  const vercel = JSON.parse(readSource(`${ROOT}/vercel.json`)) as Record<string, unknown>;
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

// ── 9–15. Assessment notices (W3b, D-W32) ───────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function readyDraft(
  type: "EXAM" | "HOMEWORK",
  times: { windowStart?: Date; windowEnd?: Date; deadline?: Date },
  extra: Partial<AssessmentDraft> = {},
): AssessmentDraft {
  return {
    ...assessmentDefaults(type),
    title: `${type} fixture`,
    instructions: null,
    windowStart: times.windowStart ?? null,
    windowEnd: times.windowEnd ?? null,
    deadline: times.deadline ?? null,
    questions: [{ text: "Q", points: 1, options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: false }] }],
    ...extra,
  };
}

/** The reach a real request resolves: relations, student branches, and what the re-check hid. */
async function fullReach(userId: string, now: Date, options: { unreadOnly?: boolean } = {}): Promise<NotificationReach> {
  const relations = await resolveCenterRelations(prisma, userId);
  const studentCenterIds = relations.filter((relation) => relation.studentProfile).map((relation) => relation.center.id);
  return {
    relationCenterIds: relations.map((relation) => relation.center.id),
    studentCenterIds,
    hiddenNoticeIds: await hiddenAssessmentNoticeIds(prisma, userId, studentCenterIds, now, options),
  };
}

const noticesOf = (userId: string, assessmentId: string) =>
  prisma.notification.findMany({
    where: { userId, dedupeKey: { startsWith: dedupeKeys.assessmentPrefix(assessmentId) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

async function visibleOf(userId: string, assessmentId: string, now: Date) {
  const { rows } = await listNotifications(prisma, userId, await fullReach(userId, now), { skip: 0, take: 100 });
  return rows.filter((row) => row.dedupeKey.startsWith(dedupeKeys.assessmentPrefix(assessmentId)));
}

/** The real writer's own transaction, rolled back after its last statement. */
function rollingBackClient() {
  const marker = new Error("rollback on purpose");
  const client = new Proxy(prisma, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          await fn(tx);
          throw marker;
        });
    },
  });
  return { client, isRollback: (error: unknown) => error === marker };
}

function checkSoonRulesPure() {
  console.log("\n9. The soon thresholds (pure, one constant)");
  const now = new Date("2026-11-10T10:00:00.000Z");
  const later = (ms: number) => new Date(now.getTime() + ms);
  const exam = (at: Date) => assessmentSoonNotice({ type: "EXAM", windowStart: at, deadline: null }, now);
  const homework = (at: Date) => assessmentSoonNotice({ type: "HOMEWORK", windowStart: null, deadline: at }, now);
  check("One constant: 60 minutes and 24 hours", ASSESSMENT_SOON.OPENS_SOON_MINUTES === 60 && ASSESSMENT_SOON.DUE_SOON_HOURS === 24);
  check("Exam 45 minutes from opening → opens soon", exam(later(45 * MINUTE_MS))?.kind === "ASSESSMENT_OPENS_SOON");
  check("Exam exactly 60 minutes from opening → opens soon", exam(later(60 * MINUTE_MS))?.kind === "ASSESSMENT_OPENS_SOON");
  check("Exam 60 minutes and 1 ms from opening → nothing", exam(later(60 * MINUTE_MS + 1)) === null);
  check("Exam opening right now → nothing (it has opened)", exam(now) === null);
  check("Homework 20 hours from its deadline → due soon", homework(later(20 * HOUR_MS))?.kind === "ASSESSMENT_DUE_SOON");
  check("Homework exactly 24 hours from its deadline → due soon", homework(later(24 * HOUR_MS))?.kind === "ASSESSMENT_DUE_SOON");
  check("Homework 24 hours and 1 ms from its deadline → nothing", homework(later(24 * HOUR_MS + 1)) === null);
  check("Homework at its deadline → nothing (it has closed)", homework(now) === null);
  check("An exam never reads a deadline", assessmentSoonNotice({ type: "EXAM", windowStart: null, deadline: later(MINUTE_MS) }, now) === null);
  check(
    "The deep link is the assessment's own page",
    notificationHref("ASSESSMENT_PUBLISHED", { assessmentId: "11111111-1111-4111-8111-111111111111" }) ===
      "/student/assessments/11111111-1111-4111-8111-111111111111",
  );
}

function checkAssessmentNoticeTexts() {
  console.log("\n15. The notice texts and the statics");
  const values = { title: "T", className: "C", branch: "B", start: "S", end: "E" };
  for (const locale of ["en", "ar"]) {
    const kinds = (JSON.parse(readSource(`${ROOT}/messages/${locale}.json`)) as { Notifications: { kinds: Record<string, string> } }).Notifications.kinds;
    for (const kind of NOTIFICATION_KIND_LIST.filter((row) => row.startsWith("ASSESSMENT_"))) {
      for (const type of ["EXAM", "HOMEWORK"]) {
        let text = "";
        try {
          text = String(new IntlMessageFormat(kinds[kind], locale).format({ ...values, type }));
        } catch (error) {
          text = `ERROR ${String(error)}`;
        }
        const namesEnd = !text.startsWith("ERROR") && text.includes("T") && text.includes("C") && text.includes("B") && text.includes("E");
        check(`${locale} ${kind} (${type}) renders the title, class, branch and closing time`, namesEnd, text);
      }
    }
    const published = new IntlMessageFormat(kinds.ASSESSMENT_PUBLISHED, locale);
    check(`${locale}: a published exam's text states when it opens`, String(published.format({ ...values, type: "EXAM" })).includes("S"));
  }
  const writer = readSource(`${ROOT}/lib/db/assessments.ts`);
  check("Publish notifies inside its transaction", /notifyAssessmentPublished\(tx,/.test(writer));
  check("Extend notifies inside its transaction", /notifyAssessmentExtended\(tx,/.test(writer));
  check("Delete removes notices inside its transaction", /deleteAssessmentNotices\(tx,/.test(writer));
  const reachSource = readSource(`${ROOT}/lib/notifications/reach.ts`);
  check(
    "The soon sync runs only for a person with a student profile",
    /relation\.studentProfile/.test(reachSource) && /if \(studentCenterIds\.length > 0\) await syncAssessmentSoonNotices/.test(reachSource),
  );
  const parentCalendar = readSource(`${ROOT}/app/[locale]/(parent)/parent/calendar/page.tsx`);
  check("The parent's calendar reads no assessment", !/assessment/i.test(parentCalendar));
  check("Every assessment kind is in the catalogue, ids only", ASSESSMENT_NOTICE_KINDS.every((kind) => NOTIFICATION_KIND_LIST.includes(kind)));
}

async function checkAssessmentNotices() {
  checkSoonRulesPure();

  const center = await makeCenter(SLUG_W3B);
  const teacherUser = await makeUser("w3b-teacher");
  const membership = await prisma.membership.create({
    data: { centerId: center.id, userId: teacherUser.id, role: "TEACHER", firstName: "T", lastName: "W3b" },
  });
  const teacher: AssessmentTeacher = { centerId: center.id, membershipId: membership.id, userId: teacherUser.id };
  const actor = { userId: teacherUser.id };
  const T = new Date();
  const at = (ms: number) => new Date(T.getTime() + ms);

  const makeStudentIn = async (tag: string, classGroupId: string | null, status: "ACTIVE" | "REMOVED" | "BLOCKED" = "ACTIVE") => {
    const user = await makeUser(`w3b-${tag}`);
    const profile = await prisma.studentProfile.create({
      data: { centerId: center.id, userId: user.id, studentCode: `w3b-${tag}`, firstName: "S", lastName: tag },
    });
    const enrollment = classGroupId
      ? await prisma.enrollment.create({ data: { centerId: center.id, studentProfileId: profile.id, classGroupId, status } })
      : null;
    const student: AssessmentStudent = { centerId: center.id, studentProfileId: profile.id, userId: user.id };
    return { user, profile, enrollment, student };
  };

  const newExam = async (classGroupId: string, start: number, extra: Partial<AssessmentDraft> = {}) => {
    const created = await createAssessment(prisma, actor, teacher, {
      type: "EXAM",
      classGroupId,
      draft: readyDraft("EXAM", { windowStart: at(start), windowEnd: at(start + 3 * HOUR_MS) }, { durationMinutes: 30, ...extra }),
    });
    if (!created.ok) throw new Error(`fixture exam: ${JSON.stringify(created)}`);
    return created.id;
  };
  const newHomework = async (classGroupId: string, deadline: number, extra: Partial<AssessmentDraft> = {}) => {
    const session = await makeSession(center.id, classGroupId, teacherUser.id, 1, "10:00");
    const created = await createAssessment(prisma, actor, teacher, {
      type: "HOMEWORK",
      sessionId: session.id,
      draft: readyDraft("HOMEWORK", { deadline: at(deadline) }, extra),
    });
    if (!created.ok) throw new Error(`fixture homework: ${JSON.stringify(created)}`);
    return created.id;
  };
  const publish = async (id: string, when: Date = T) => {
    const result = await publishAssessment(prisma, actor, teacher, id, when);
    if (!result.ok) throw new Error(`fixture publish: ${JSON.stringify(result)}`);
  };
  const sync = (userId: string, now: Date) => syncAssessmentSoonNotices(prisma, userId, [center.id], now);

  // ── 10. Published ─────────────────────────────────────────────────────────
  console.log("\n10. ASSESSMENT_PUBLISHED — in the publish transaction");
  const classPublish = await makeClass(center.id, teacherUser.id);
  const enrolled = await makeStudentIn("enrolled", classPublish.id);
  const left = await makeStudentIn("left", classPublish.id, "REMOVED");
  const blocked = await makeStudentIn("blocked", classPublish.id, "BLOCKED");
  const notEnrolled = await makeStudentIn("not-enrolled", null);
  const parent = await makeUser("w3b-parent");
  await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: enrolled.user.id, source: "LEGACY_VERIFIED" } });

  const examId = await newExam(classPublish.id, 2 * HOUR_MS);
  const unreadBefore = await countUnread(prisma, enrolled.user.id, await fullReach(enrolled.user.id, T, { unreadOnly: true }));
  const rollback = rollingBackClient();
  const refused = await publishAssessment(rollback.client, actor, teacher, examId, T).then(() => null, (error) => error);
  check(
    "A rolled-back publish leaves no notice and the row a DRAFT",
    rollback.isRollback(refused) &&
      (await noticesOf(enrolled.user.id, examId)).length === 0 &&
      (await prisma.assessment.findUniqueOrThrow({ where: { id: examId } })).status === "DRAFT",
  );
  await publish(examId);
  const publishedRows = await noticesOf(enrolled.user.id, examId);
  check("The enrolled student gets exactly one notice", publishedRows.length === 1, JSON.stringify(publishedRows));
  check("It is ASSESSMENT_PUBLISHED, about this branch", publishedRows[0]?.kind === "ASSESSMENT_PUBLISHED" && publishedRows[0]?.centerId === center.id);
  check("Its payload is the assessment's id, nothing else", samePayload(publishedRows[0]?.payload, { assessmentId: examId }));
  check("Its key is assessment:<id>:published:<publishedAt>", publishedRows[0]?.dedupeKey === `assessment:${examId}:published:${T.getTime()}`, publishedRows[0]?.dedupeKey);
  check(
    "The student's bell count rises by one",
    (await countUnread(prisma, enrolled.user.id, await fullReach(enrolled.user.id, T, { unreadOnly: true }))) === unreadBefore + 1,
  );
  for (const [name, userId] of [
    ["A student who left", left.user.id],
    ["A blocked student", blocked.user.id],
    ["A student not enrolled", notEnrolled.user.id],
    ["A parent of the enrolled student", parent.id],
    ["The teacher", teacherUser.id],
  ] as const) {
    check(`${name} gets nothing`, (await noticesOf(userId, examId)).length === 0);
  }
  await prisma.$transaction((tx) => notifyAssessmentPublished(tx, { id: examId, centerId: center.id, classGroupId: classPublish.id }, T));
  check("The same publish twice writes one row", (await noticesOf(enrolled.user.id, examId)).length === 1);
  await prisma.$transaction((tx) => notifyAssessmentPublished(tx, { id: examId, centerId: center.id, classGroupId: classPublish.id }, T));

  // ── 11. Soon, computed on read ────────────────────────────────────────────
  console.log("\n11. OPENS_SOON and DUE_SOON — computed on read, with no job");
  const classSoon = await makeClass(center.id, teacherUser.id);
  const soonStudent = await makeStudentIn("soon", classSoon.id);
  const soonLeft = await makeStudentIn("soon-left", classSoon.id, "REMOVED");
  const soonOutsider = await makeStudentIn("soon-outsider", null);
  const opens45 = await newExam(classSoon.id, 45 * MINUTE_MS);
  await publish(opens45);
  await sync(soonStudent.user.id, T);
  const soonKindsOf = async (userId: string, id: string) =>
    (await noticesOf(userId, id)).filter((row) => row.kind === "ASSESSMENT_OPENS_SOON" || row.kind === "ASSESSMENT_DUE_SOON");
  const opens = await soonKindsOf(soonStudent.user.id, opens45);
  check("An exam 45 minutes from opening produces one opens-soon notice", opens.length === 1 && opens[0].kind === "ASSESSMENT_OPENS_SOON", JSON.stringify(opens));
  check(
    "Its key is assessment:<id>:<kind>:<windowStart>",
    opens[0]?.dedupeKey === `assessment:${opens45}:ASSESSMENT_OPENS_SOON:${at(45 * MINUTE_MS).getTime()}`,
    opens[0]?.dedupeKey,
  );
  check("Its payload is ids only", samePayload(opens[0]?.payload, { assessmentId: opens45 }));
  await sync(soonStudent.user.id, T);
  await sync(soonStudent.user.id, at(MINUTE_MS));
  check("Reloading creates no second notice", (await soonKindsOf(soonStudent.user.id, opens45)).length === 1);
  await sync(soonLeft.user.id, T);
  await sync(soonOutsider.user.id, T);
  check("A student who left gets no soon notice", (await soonKindsOf(soonLeft.user.id, opens45)).length === 0);
  check("A student not enrolled gets no soon notice", (await soonKindsOf(soonOutsider.user.id, opens45)).length === 0);

  const due20 = await newHomework(classSoon.id, 20 * HOUR_MS);
  await publish(due20);
  await sync(soonStudent.user.id, T);
  const due = await soonKindsOf(soonStudent.user.id, due20);
  check("A homework due in 20 hours produces one due-soon notice", due.length === 1 && due[0].kind === "ASSESSMENT_DUE_SOON", JSON.stringify(due));
  check("Its key is assessment:<id>:<kind>:<deadline>", due[0]?.dedupeKey === `assessment:${due20}:ASSESSMENT_DUE_SOON:${at(20 * HOUR_MS).getTime()}`, due[0]?.dedupeKey);

  // Boundaries against the database, with a student who sees only this class.
  const classEdge = await makeClass(center.id, teacherUser.id);
  const edgeStudent = await makeStudentIn("edge", classEdge.id);
  const edgeExam = await newExam(classEdge.id, 5 * HOUR_MS);
  const edgeHomework = await newHomework(classEdge.id, 30 * HOUR_MS);
  await publish(edgeExam);
  await publish(edgeHomework);
  const windowStart = at(5 * HOUR_MS).getTime();
  const deadline = at(30 * HOUR_MS).getTime();
  await sync(edgeStudent.user.id, new Date(windowStart - 60 * MINUTE_MS - 1));
  check("Database: the exam at 60 minutes + 1 ms gets nothing", (await soonKindsOf(edgeStudent.user.id, edgeExam)).length === 0);
  await sync(edgeStudent.user.id, new Date(windowStart));
  check("Database: the exam at its opening moment gets nothing", (await soonKindsOf(edgeStudent.user.id, edgeExam)).length === 0);
  await sync(edgeStudent.user.id, new Date(windowStart - 60 * MINUTE_MS));
  check("Database: the exam at exactly 60 minutes gets its notice", (await soonKindsOf(edgeStudent.user.id, edgeExam)).length === 1);
  await sync(edgeStudent.user.id, new Date(deadline - 24 * HOUR_MS - 1));
  check("Database: the homework at 24 hours + 1 ms gets nothing", (await soonKindsOf(edgeStudent.user.id, edgeHomework)).length === 0);
  await sync(edgeStudent.user.id, new Date(deadline));
  check("Database: the homework at its deadline gets nothing", (await soonKindsOf(edgeStudent.user.id, edgeHomework)).length === 0);
  await sync(edgeStudent.user.id, new Date(deadline - 24 * HOUR_MS));
  check("Database: the homework at exactly 24 hours gets its notice", (await soonKindsOf(edgeStudent.user.id, edgeHomework)).length === 1);

  // Two concurrent reads.
  const classRace = await makeClass(center.id, teacherUser.id);
  const raceStudent = await makeStudentIn("race", classRace.id);
  const raceExam = await newExam(classRace.id, 30 * MINUTE_MS);
  const raceHomework = await newHomework(classRace.id, 3 * HOUR_MS);
  await publish(raceExam);
  await publish(raceHomework);
  await Promise.all([sync(raceStudent.user.id, T), sync(raceStudent.user.id, T), sync(raceStudent.user.id, T)]);
  check(
    "Concurrent reads leave one row per notice",
    (await soonKindsOf(raceStudent.user.id, raceExam)).length === 1 && (await soonKindsOf(raceStudent.user.id, raceHomework)).length === 1,
  );

  // ── 12. The re-check ──────────────────────────────────────────────────────
  console.log("\n12. The read-time re-check — hidden, never deleted");
  const visibleCount = async () => (await visibleOf(enrolled.user.id, examId, T)).length;
  const storedCount = async () => (await noticesOf(enrolled.user.id, examId)).length;
  const hiddenWhile = async (name: string, change: () => Promise<unknown>, restore: () => Promise<unknown>) => {
    const stored = await storedCount();
    await change();
    const whileHidden = await visibleCount();
    const unreadHidden = await countUnread(prisma, enrolled.user.id, await fullReach(enrolled.user.id, T, { unreadOnly: true }));
    const stillStored = await storedCount();
    await restore();
    check(`${name} hides it`, whileHidden === 0, String(whileHidden));
    check(`${name}: the bell does not count it`, unreadHidden === unreadBefore, String(unreadHidden));
    check(`${name}: the row is still stored`, stillStored === stored);
    check(`${name}: undoing it shows the notice again`, (await visibleCount()) === 1);
  };
  check("Visible with full access", (await visibleCount()) === 1);
  await hiddenWhile(
    "An inactive class",
    () => prisma.classGroup.update({ where: { id: classPublish.id }, data: { active: false } }),
    () => prisma.classGroup.update({ where: { id: classPublish.id }, data: { active: true } }),
  );
  await hiddenWhile(
    "A student leaving the class",
    () => prisma.enrollment.update({ where: { id: enrolled.enrollment!.id }, data: { status: "REMOVED" } }),
    () => prisma.enrollment.update({ where: { id: enrolled.enrollment!.id }, data: { status: "ACTIVE" } }),
  );
  await hiddenWhile(
    "A blocked enrolment",
    () => prisma.enrollment.update({ where: { id: enrolled.enrollment!.id }, data: { status: "BLOCKED" } }),
    () => prisma.enrollment.update({ where: { id: enrolled.enrollment!.id }, data: { status: "ACTIVE" } }),
  );
  await hiddenWhile(
    "A deactivated profile",
    () => prisma.studentProfile.update({ where: { id: enrolled.profile.id }, data: { active: false } }),
    () => prisma.studentProfile.update({ where: { id: enrolled.profile.id }, data: { active: true } }),
  );
  await hiddenWhile(
    "A suspended branch",
    () => prisma.center.update({ where: { id: center.id }, data: { lifecycleState: "SUSPENDED" } }),
    () => prisma.center.update({ where: { id: center.id }, data: { lifecycleState: "ACTIVE" } }),
  );
  await prisma.$transaction((tx) =>
    notify(tx, [
      {
        userId: teacherUser.id,
        kind: "ASSESSMENT_PUBLISHED",
        centerId: center.id,
        payload: { assessmentId: examId },
        dedupeKey: dedupeKeys.assessmentPublished(examId, T),
      },
    ]),
  );
  check("A person who is staff at the branch, not a student, sees no assessment notice", (await visibleOf(teacherUser.id, examId, T)).length === 0);

  const unpublishTo = await unpublishAssessment(prisma, actor, teacher, examId);
  check("Unpublish succeeds", unpublishTo.ok);
  const hiddenId = publishedRows[0].id;
  check("An unpublished assessment hides its notice", (await visibleCount()) === 0);
  check("A hidden notice cannot be opened", (await markNotificationRead(prisma, enrolled.user.id, await fullReach(enrolled.user.id, T), hiddenId)) === null);
  await markAllNotificationsRead(prisma, enrolled.user.id, await fullReach(enrolled.user.id, T, { unreadOnly: true }));
  check("\"Mark all\" leaves a hidden notice unread", (await prisma.notification.findUniqueOrThrow({ where: { id: hiddenId } })).readAt === null);
  await publish(examId, at(1_000));
  const republished = await noticesOf(enrolled.user.id, examId);
  const shown = await visibleOf(enrolled.user.id, examId, T);
  check("Republishing writes a new notice (publishedAt is in the key)", republished.length === 2, JSON.stringify(republished.map((row) => row.dedupeKey)));
  check(
    "Only the new one shows, so one publish rings once",
    shown.length === 1 && shown[0].dedupeKey === dedupeKeys.assessmentPublished(examId, at(1_000)),
    JSON.stringify(shown.map((row) => row.dedupeKey)),
  );

  // The soon notices and a final attempt.
  const { rows: beforeSubmit } = await listNotifications(prisma, soonStudent.user.id, await fullReach(soonStudent.user.id, T), { skip: 0, take: 100 });
  const dueShown = (rows: { kind: string; dedupeKey: string }[]) =>
    rows.filter((row) => row.kind === "ASSESSMENT_DUE_SOON" && row.dedupeKey.startsWith(dedupeKeys.assessmentPrefix(due20))).length;
  check("The due-soon notice shows before any attempt", dueShown(beforeSubmit) === 1);
  const started = await startAttempt(prisma, soonStudent.student, due20, T);
  if (!started.ok) throw new Error(`fixture start: ${JSON.stringify(started)}`);
  const inProgress = await visibleOf(soonStudent.user.id, due20, T);
  check("An attempt still in progress keeps it", dueShown(inProgress) === 1);
  await sync(soonStudent.user.id, T);
  check("An attempt still in progress adds no second one", (await soonKindsOf(soonStudent.user.id, due20)).length === 1);
  await submitAttempt(prisma, soonStudent.student, started.attemptId, at(MINUTE_MS));
  check("Submitting hides it", dueShown(await visibleOf(soonStudent.user.id, due20, at(MINUTE_MS))) === 0);
  await sync(soonStudent.user.id, at(2 * MINUTE_MS));
  check("A read after submitting creates nothing new", (await soonKindsOf(soonStudent.user.id, due20)).length === 1);
  const dueRow = (await soonKindsOf(soonStudent.user.id, due20))[0];
  check("The full re-check names a hidden notice", (await hiddenAssessmentNoticeIds(prisma, soonStudent.user.id, [center.id], at(MINUTE_MS))).includes(dueRow.id));
  await prisma.notification.update({ where: { id: dueRow.id }, data: { readAt: at(MINUTE_MS) } });
  check(
    "The bell's unread-only re-check leaves a read notice out",
    !(await hiddenAssessmentNoticeIds(prisma, soonStudent.user.id, [center.id], at(MINUTE_MS), { unreadOnly: true })).includes(dueRow.id),
  );

  const finalExamRows = await soonKindsOf(soonStudent.user.id, opens45);
  await prisma.assessmentAttempt.create({
    data: {
      centerId: center.id,
      assessmentId: opens45,
      studentProfileId: soonStudent.profile.id,
      startedAt: T,
      lastSeenAt: T,
      submittedAt: T,
      finalisedBy: "STUDENT",
      score: 0,
      maxScore: 1,
    },
  });
  check("A final attempt hides the opens-soon notice", !(await visibleOf(soonStudent.user.id, opens45, T)).some((row) => row.id === finalExamRows[0]?.id));
  check("It is still stored", (await soonKindsOf(soonStudent.user.id, opens45)).length === 1);

  const classDue = await makeClass(center.id, teacherUser.id);
  const dueStudent = await makeStudentIn("overdue", classDue.id);
  const timedHomework = await newHomework(classDue.id, 10 * HOUR_MS, { durationMinutes: 10 });
  await publish(timedHomework);
  await sync(dueStudent.user.id, T);
  const timedStart = await startAttempt(prisma, dueStudent.student, timedHomework, T);
  if (!timedStart.ok) throw new Error(`fixture start: ${JSON.stringify(timedStart)}`);
  const pastItsEnd = at(11 * MINUTE_MS);
  check(
    "An attempt past its end counts as final before anyone finalised it (D-W10), with nothing written",
    !(await visibleOf(dueStudent.user.id, timedHomework, pastItsEnd)).some((row) => row.kind === "ASSESSMENT_DUE_SOON") &&
      (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: timedStart.attemptId } })).submittedAt === null,
  );

  // ── 13. Extended ──────────────────────────────────────────────────────────
  console.log("\n13. ASSESSMENT_EXTENDED — in the extend transaction");
  const classExtend = await makeClass(center.id, teacherUser.id);
  const fresh = await makeStudentIn("fresh", classExtend.id);
  const working = await makeStudentIn("working", classExtend.id);
  const finished = await makeStudentIn("finished", classExtend.id);
  const overdue = await makeStudentIn("past-end", classExtend.id);
  const gone = await makeStudentIn("gone", classExtend.id, "REMOVED");
  const extendId = await newExam(classExtend.id, -1 * HOUR_MS);
  await publish(extendId);
  for (const [student, when] of [[working.student, T], [finished.student, T], [overdue.student, at(-40 * MINUTE_MS)]] as const) {
    const result = await startAttempt(prisma, student, extendId, when);
    if (!result.ok) throw new Error(`fixture start: ${JSON.stringify(result)}`);
    if (student === finished.student) await submitAttempt(prisma, student, result.attemptId, T);
  }
  const extendedOf = async (userId: string) => (await noticesOf(userId, extendId)).filter((row) => row.kind === "ASSESSMENT_EXTENDED");
  const firstEnd = at(5 * HOUR_MS);
  const extendRollback = rollingBackClient();
  const extendRefused = await extendAssessment(extendRollback.client, actor, teacher, extendId, firstEnd, T).then(() => null, (error) => error);
  check(
    "A rolled-back extension leaves no notice and the old end",
    extendRollback.isRollback(extendRefused) &&
      (await extendedOf(fresh.user.id)).length === 0 &&
      (await prisma.assessment.findUniqueOrThrow({ where: { id: extendId } })).windowEnd?.getTime() === at(2 * HOUR_MS).getTime(),
  );
  const extended = await extendAssessment(prisma, actor, teacher, extendId, firstEnd, T);
  check("The extension succeeds", extended.ok, JSON.stringify(extended));
  check("A student with no attempt is told", (await extendedOf(fresh.user.id)).length === 1);
  check("A student mid-attempt is told", (await extendedOf(working.user.id)).length === 1);
  check("A student who submitted is not", (await extendedOf(finished.user.id)).length === 0);
  check("An attempt the extension finalised at its old end is not", (await extendedOf(overdue.user.id)).length === 0);
  check("A student who left is not", (await extendedOf(gone.user.id)).length === 0);
  check("Its key carries the new end", (await extendedOf(fresh.user.id))[0]?.dedupeKey === `assessment:${extendId}:extended:${firstEnd.getTime()}`);
  await prisma.$transaction((tx) => notifyAssessmentExtended(tx, { id: extendId, centerId: center.id, classGroupId: classExtend.id }, firstEnd));
  check("The same extension twice writes one row", (await extendedOf(fresh.user.id)).length === 1);
  const secondEnd = at(6 * HOUR_MS);
  await extendAssessment(prisma, actor, teacher, extendId, secondEnd, T);
  check("A later extension is a new notice", (await extendedOf(fresh.user.id)).length === 2);
  await prisma.classGroup.update({ where: { id: classExtend.id }, data: { active: false } });
  await extendAssessment(prisma, actor, teacher, extendId, at(7 * HOUR_MS), T);
  await prisma.classGroup.update({ where: { id: classExtend.id }, data: { active: true } });
  check("Nobody is told while the class is inactive", (await extendedOf(fresh.user.id)).length === 2);

  // ── 14. Delete, payloads, current names ───────────────────────────────────
  console.log("\n14. Deleting removes the notices; payloads are ids only; the text reads current values");
  const classDelete = await makeClass(center.id, teacherUser.id);
  const deleteStudent = await makeStudentIn("delete", classDelete.id);
  const doomed = await newExam(classDelete.id, 30 * MINUTE_MS);
  const kept = await newExam(classDelete.id, 40 * MINUTE_MS);
  await publish(doomed);
  await publish(kept);
  await sync(deleteStudent.user.id, T);
  const storedBefore = (await noticesOf(deleteStudent.user.id, doomed)).length;
  const keptBefore = (await noticesOf(deleteStudent.user.id, kept)).length;
  check("Fixture: both exams hold a published and an opens-soon notice", storedBefore === 2 && keptBefore === 2, `${storedBefore}/${keptBefore}`);
  await unpublishAssessment(prisma, actor, teacher, doomed);
  check("Unpublishing hides them and deletes none", (await noticesOf(deleteStudent.user.id, doomed)).length === 2 && (await visibleOf(deleteStudent.user.id, doomed, T)).length === 0);
  const deleteRollback = rollingBackClient();
  const deleteRefused = await deleteAssessment(deleteRollback.client, actor, teacher, doomed).then(() => null, (error) => error);
  check(
    "A rolled-back delete keeps the assessment and its notices",
    deleteRollback.isRollback(deleteRefused) && (await noticesOf(deleteStudent.user.id, doomed)).length === 2,
  );
  const removed = await deleteAssessment(prisma, actor, teacher, doomed);
  check("Deleting the draft succeeds", removed.ok, JSON.stringify(removed));
  check("It leaves no notice row, of any kind", (await prisma.notification.count({ where: { dedupeKey: { startsWith: dedupeKeys.assessmentPrefix(doomed) } } })) === 0);
  check("Another assessment's notices are untouched", (await noticesOf(deleteStudent.user.id, kept)).length === keptBefore);

  const allRows = await prisma.notification.findMany({ where: { centerId: center.id } });
  check(
    "Every assessment payload is exactly its id",
    allRows.length > 0 && allRows.every((row) => isIdsOnlyPayload(row.kind, row.payload) && UUID.test((row.payload as { assessmentId: string }).assessmentId)),
  );
  const nameRefused = await prisma
    .$transaction((tx) =>
      notify(tx, [
        {
          userId: enrolled.user.id,
          kind: "ASSESSMENT_PUBLISHED",
          centerId: center.id,
          payload: { assessmentId: examId, title: "A name" },
          dedupeKey: `assessment:${examId}:refused`,
        },
      ]),
    )
    .then(() => null, (error) => error);
  check("A title in the payload is refused by the writer", nameRefused instanceof NotificationPayloadError);

  await prisma.assessment.update({ where: { id: kept }, data: { title: "Renamed" } });
  // Frozen at creation by a trigger (D-14), so it is set there.
  const zonedSession = await prisma.session.create({
    data: {
      centerId: center.id,
      classGroupId: classDelete.id,
      teacherId: teacherUser.id,
      date: day(2).date,
      startTime: "11:00",
      endTime: "12:00",
      priceSnapshot: 10_000,
      timezone: "Asia/Dubai",
    },
  });
  const zonedHomework = await createAssessment(prisma, actor, teacher, {
    type: "HOMEWORK",
    sessionId: zonedSession.id,
    draft: readyDraft("HOMEWORK", { deadline: at(10 * HOUR_MS) }),
  });
  if (!zonedHomework.ok) throw new Error("fixture zoned homework");
  await publish(zonedHomework.id);
  const subjects = await loadNotificationSubjects(prisma, [
    ...(await noticesOf(deleteStudent.user.id, kept)),
    ...(await noticesOf(deleteStudent.user.id, zonedHomework.id)),
  ]);
  check("The text reads the current title", subjects.assessments.get(kept)?.title === "Renamed");
  check("An exam with no session reads the branch's timezone", subjects.assessments.get(kept)?.session === null && Boolean(subjects.branches.get(center.id)?.timeZone));
  check("A homework reads its session's frozen timezone", subjects.assessments.get(zonedHomework.id)?.session?.timezone === "Asia/Dubai", JSON.stringify(subjects.assessments.get(zonedHomework.id)?.session ?? null));
  check("The subjects never carry a question or a correct mark", !JSON.stringify([...subjects.assessments.values()]).includes("isCorrect"));

  checkAssessmentNoticeTexts();
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
  // A hand-written list, not a count: adding a kind must be a deliberate edit here too.
  const EXPECTED_KINDS = [
    "ASSESSMENT_DUE_SOON",
    "ASSESSMENT_EXTENDED",
    "ASSESSMENT_OPENS_SOON",
    "ASSESSMENT_PUBLISHED",
    "BOOKING_APPROVED",
    "BOOKING_DECLINED",
    "ENROLLMENT_APPROVED",
    "ENROLLMENT_DECLINED",
    "SESSION_CANCELLED",
    "SESSION_RESCHEDULED",
  ];
  check(
    "Every kind declares its ids (the catalogue is exactly the ten expected kinds)",
    [...NOTIFICATION_KIND_LIST].sort().join() === EXPECTED_KINDS.join(),
    NOTIFICATION_KIND_LIST.join(),
  );

  // ── 7. RLS ────────────────────────────────────────────────────────────────
  console.log("\n7. Row-level security");
  const [rls] = await prisma.$queryRaw<{ on: boolean }[]>`
    SELECT c.relrowsecurity AS on FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'Notification'`;
  const [policies] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'Notification'`;
  check("RLS is on for Notification", rls?.on === true);
  check("Notification carries zero policies (deny-all to the Data API)", Number(policies?.count ?? -1) === 0);

  await checkAssessmentNotices();
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
