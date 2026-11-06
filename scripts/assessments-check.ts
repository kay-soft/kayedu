/**
 * Assessments check — the W2 and W3a acceptance gate (docs/03-build-order.md W2
 * and W3a "Gates"; D-W01–D-W11, D-W30, D-W31 in docs/00 §5.1 "W-batch").
 *
 * Run with:  npm run check:assessments   (staging or a local database only — S1)
 *
 * Exercises the REAL rules (lib/assessments.ts), the REAL data layer
 * (lib/db/assessments.ts) and the REAL permission resolution outside Next:
 *
 *  1. Defaults per type, and a new question (4 empty options, 1 point).
 *  2. The default homework deadline: the next session − 30 min; none → the
 *     session's end + 7 days; a cancelled or rescheduled next session is
 *     skipped; each session's own frozen timezone is used.
 *  3. Every save limit (draftErrors) and the database CHECKs / the one-correct
 *     partial unique index behind them; the "Ready to publish" list.
 *  4. Who can: the class's teacher for an exam, the session's teacher for a
 *     homework (a per-session change counts), only the owner afterwards;
 *     another teacher, another centre, centre staff (a stray grant row
 *     included), an inactive membership and a denied experience are refused;
 *     the Owner's switch-off refuses and switching it back restores.
 *  5. The student serializer never carries isCorrect; the student select
 *     names it nowhere; the drawn order is honoured.
 *  6. The lock helper: false in W2, and asked by every question/option write
 *     (static); nothing outside lib/db/assessments.ts writes those tables.
 *  7. Audit rows: assessment.create / update / delete, ids and counts only.
 *  8. RLS on the three tables, zero policies; the migration's backfill (every
 *     existing branch holds the TEACHER grant) and the permission ceiling.
 *  9. Statics: no centre, student or parent file imports the module; every
 *     builder action re-resolves the branch and the owning teacher.
 * 10. W3a, pure: end-time derivation, due, state, reveal, grading, shuffle.
 * 11. Publish, unpublish, delete.
 * 12. Start and eligibility: the window, one attempt, a double start, left /
 *     blocked / not enrolled / another centre / staff / parent / inactive class.
 * 13. Locking after the first attempt; extend forwards only, before it has
 *     passed, finalising what is overdue.
 * 14. Autosave validation. 15. Lazy finalisation, under two concurrent calls.
 * 16. One sitting. 17. Reveal, score, and every student payload (rule 11).
 * 18. Homework and the class engine (D-W31). 19. Audit rows, ids only.
 * 20. RLS on the two tables and the W3a statics.
 * 21. W3b: where an assessment sits on the calendar, in its zone (pure).
 * 22. The calendar's reads: the range, who sees what, rule 11, the counts.
 * 23. Publish, extend and delete write their notices; the calendar statics.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { Prisma, Role } from "@prisma/client";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { gateSlugPrefixes } from "./lib/gate-fixtures.ts";
import { readSource } from "./lib/source.ts";
import { allowedOrigins, isSameOriginRequest } from "../lib/same-origin.ts";
import {
  ASSESSMENT_LIMITS,
  ONE_SITTING_GRACE_SECONDS,
  STUDENT_ASSESSMENT_SELECT,
  assessmentDefaults,
  attemptEnd,
  attemptOrder,
  finalisationDue,
  gradeAnswers,
  percentage,
  revealAllowed,
  startRefusal,
  studentAssessmentState,
  type AssessmentTiming,
  defaultHomeworkDeadline,
  drawOrder,
  draftErrors,
  isReady,
  newDraftQuestion,
  readiness,
  sessionInstant,
  toStudentAssessment,
  type AssessmentDraft,
  type DraftQuestion,
} from "../lib/assessments.ts";
import {
  DEFAULT_ROLE_GRANTS,
  PERMISSIONS,
  can,
  editableActionsFor,
  type Permission,
  type PermissionGrants,
  type TenantRole,
} from "../lib/auth/permissions.ts";
import {
  assessmentAttemptCounts,
  createAssessment,
  deleteAssessment,
  extendAssessment,
  findTeacherAssessment,
  homeworkDeadlineFor,
  isAssessmentLocked,
  listTeacherAssessments,
  publishAssessment,
  resolveAssessmentTeacher,
  saveAssessmentDraft,
  unpublishAssessment,
  type AssessmentTeacher,
} from "../lib/db/assessments.ts";
import {
  attemptHeartbeat,
  finaliseIfDue,
  listStudentAssessments,
  readAttemptReveal,
  readStudentAssessment,
  resolveAssessmentStudent,
  saveAnswer,
  startAttempt,
  submitAttempt,
  type AssessmentStudent,
  type StudentAssessmentView,
} from "../lib/db/assessment-attempts.ts";
import { loadAuditFeed } from "../lib/db/audit-feed.ts";
import { cancelSession } from "../lib/db/sessions.ts";
import { deleteClass, deleteManualSession, sessionDisqualifiers } from "../lib/db/class-sessions.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { loadPermissionGrants, savePermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
import {
  ASSESSMENT_CALENDAR_TONES,
  STUDENT_CALENDAR_TONES,
  assessmentCalendarWindow,
  assessmentOnCalendar,
} from "../lib/calendar.ts";
import { dateKey, zonedDateTimeToUtc } from "../lib/scheduling.ts";

const prisma = await gatePrisma();
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const STEM = "assessments-check";
const SLUG_A = `${STEM}-a`;
const SLUG_B = `${STEM}-b`;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let failures = 0;
function check(name: string, passed: boolean, detail = "") {
  if (passed) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const centers = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { id: true } });
  if (centers.length > 0) await deleteAuditRows(prisma, { centerId: { in: centers.map((center) => center.id) } });
  // Assessments, questions and options cascade with their branch.
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: STEM } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `${STEM}-` } } });
}

/** A UTC-midnight day marker `days` from today. */
function day(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}

async function makeCenter(slug: string) {
  const center = await prisma.center.create({ data: { slug, name: slug, organization: { create: { name: slug } } } });
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, center.id));
  return center;
}

async function makeMember(centerId: string, tag: string, role: Role) {
  const user = await prisma.user.findFirst({ where: { email: `${STEM}-${tag}@kayedu.test` } }) ??
    (await prisma.user.create({ data: { firstName: "A", lastName: tag, email: `${STEM}-${tag}@kayedu.test`, locale: "en" } }));
  const membership = await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role, joinedAt: new Date(), firstName: "A", lastName: tag }),
  });
  return { user, membership };
}

async function makeClass(centerId: string, teacherId: string) {
  return prisma.classGroup.create({
    data: { centerId, teacherId, price: 10_000, startDate: day(-30), endDate: day(120) },
  });
}

async function makeSession(
  centerId: string,
  classGroupId: string | null,
  teacherId: string,
  days: number,
  startTime: string,
  extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
) {
  const [hours, minutes] = startTime.split(":").map(Number);
  const endTime = `${String(hours + 1).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return prisma.session.create({
    data: {
      centerId,
      classGroupId,
      teacherId,
      date: day(days),
      startTime,
      endTime,
      priceSnapshot: 10_000,
      ...(classGroupId ? {} : { title: "One-off", centerShareType: "PERCENTAGE" as const, centerShareValue: 15 }),
      ...extra,
    },
  });
}

/** What `resolveAssessmentTeacher` reads of a context — with the branch's real stored grants. */
async function authority(centerId: string, userId: string, role: TenantRole, experienceDenied = false) {
  const grants: PermissionGrants =
    role === "STUDENT" || role === "PLATFORM_ADMIN" || role === "PARENT" ? {} : await loadPermissionGrants(prisma, centerId, role);
  return { center: { id: centerId }, user: { id: userId }, role, grants, experienceDenied };
}

function question(options = 4, correct = 0, extra: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    text: "Q",
    points: 1,
    options: Array.from({ length: options }, (_, i) => ({ text: `O${i}`, isCorrect: i === correct })),
    ...extra,
  };
}

function examDraft(extra: Partial<AssessmentDraft> = {}): AssessmentDraft {
  return {
    ...assessmentDefaults("EXAM"),
    title: "Exam",
    instructions: null,
    windowStart: new Date(Date.now() + DAY),
    windowEnd: new Date(Date.now() + DAY + 2 * 60 * MINUTE),
    deadline: null,
    questions: [question()],
    ...extra,
  };
}

function homeworkDraft(deadline: Date, extra: Partial<AssessmentDraft> = {}): AssessmentDraft {
  return {
    ...assessmentDefaults("HOMEWORK"),
    title: "Homework",
    instructions: null,
    windowStart: null,
    windowEnd: null,
    deadline,
    questions: [question()],
    ...extra,
  };
}

const codes = (type: "EXAM" | "HOMEWORK", draft: AssessmentDraft) => draftErrors(type, draft).map((error) => error.code);

async function refusedByDb(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

// ── 1. Defaults ────────────────────────────────────────────────────────────

function checkDefaults() {
  console.log("1. Defaults per type (D-W02, D-W03, D-W05, D-W06)");
  const exam = assessmentDefaults("EXAM");
  const homework = assessmentDefaults("HOMEWORK");
  check(
    "EXAM: 30 minutes, one sitting off, shuffle on, show score off, show correct answers off",
    exam.durationMinutes === 30 && !exam.oneSitting && exam.shuffle && !exam.showScore && !exam.showCorrectAnswers,
    JSON.stringify(exam),
  );
  check(
    "HOMEWORK: untimed, shuffle off, show score on, show correct answers on",
    homework.durationMinutes === null && !homework.oneSitting && !homework.shuffle && homework.showScore && homework.showCorrectAnswers,
    JSON.stringify(homework),
  );
  const fresh = newDraftQuestion();
  check(
    "A new question starts with 4 empty options, none correct, and 1 point",
    fresh.points === 1 && fresh.options.length === 4 && fresh.options.every((o) => o.text === "" && !o.isCorrect) && fresh.text === "",
  );
}

// ── 2. The homework deadline ───────────────────────────────────────────────

async function checkDeadline(centerId: string, teacherId: string) {
  console.log("\n2. The default homework deadline (D-W03)");
  const cairo = "Africa/Cairo";
  const pure = defaultHomeworkDeadline({ sessionEnd: new Date("2026-11-10T15:00:00Z"), nextSessionStart: new Date("2026-11-12T14:00:00Z") });
  check("Pure: next session start − 30 minutes", pure.basis === "nextSession" && pure.deadline.toISOString() === "2026-11-12T13:30:00.000Z");
  const none = defaultHomeworkDeadline({ sessionEnd: new Date("2026-11-10T15:00:00Z"), nextSessionStart: null });
  check("Pure: no next session → the session's end + 7 days", none.basis === "fallback" && none.deadline.toISOString() === "2026-11-17T15:00:00.000Z");

  // A class with the homework session and a next session two days on.
  const c1 = await makeClass(centerId, teacherId);
  const h = await makeSession(centerId, c1.id, teacherId, 1, "16:00");
  const n = await makeSession(centerId, c1.id, teacherId, 3, "16:00");
  const at = (s: { date: Date; startTime: string; endTime: string; timezone: string | null }, edge: "start" | "end") =>
    sessionInstant(s, edge, s.timezone ?? cairo);
  const hRow = await prisma.session.findUniqueOrThrow({ where: { id: h.id } });
  const nRow = await prisma.session.findUniqueOrThrow({ where: { id: n.id } });
  const withNext = await homeworkDeadlineFor(prisma, centerId, { ...hRow, classGroupId: c1.id }, cairo);
  check(
    "With a next SCHEDULED session: its start − 30 minutes",
    withNext.basis === "nextSession" && withNext.deadline.getTime() === at(nRow, "start").getTime() - 30 * MINUTE,
    withNext.deadline.toISOString(),
  );

  await prisma.session.update({ where: { id: n.id }, data: { status: "CANCELLED" } });
  const afterCancel = await homeworkDeadlineFor(prisma, centerId, { ...hRow, classGroupId: c1.id }, cairo);
  check(
    "The next session cancelled, none after it: the session's end + 7 days",
    afterCancel.basis === "fallback" && afterCancel.deadline.getTime() === at(hRow, "end").getTime() + 7 * DAY,
    afterCancel.deadline.toISOString(),
  );
  const n2 = await makeSession(centerId, c1.id, teacherId, 5, "10:00");
  const n2Row = await prisma.session.findUniqueOrThrow({ where: { id: n2.id } });
  const skipCancelled = await homeworkDeadlineFor(prisma, centerId, { ...hRow, classGroupId: c1.id }, cairo);
  check(
    "A cancelled next session is skipped for the one after it",
    skipCancelled.basis === "nextSession" && skipCancelled.deadline.getTime() === at(n2Row, "start").getTime() - 30 * MINUTE,
  );

  // A rescheduled-away next session is skipped (its replacement belongs to another class here).
  const c2 = await makeClass(centerId, teacherId);
  const c3 = await makeClass(centerId, teacherId);
  const h2 = await makeSession(centerId, c2.id, teacherId, 1, "12:00");
  const moved = await makeSession(centerId, c2.id, teacherId, 3, "12:00");
  const replacement = await makeSession(centerId, c3.id, teacherId, 4, "12:00");
  await prisma.session.update({ where: { id: moved.id }, data: { rescheduledToId: replacement.id } });
  const h2Row = await prisma.session.findUniqueOrThrow({ where: { id: h2.id } });
  const afterMove = await homeworkDeadlineFor(prisma, centerId, { ...h2Row, classGroupId: c2.id }, cairo);
  check(
    "A rescheduled-away next session is skipped (here: nothing after it → end + 7 days)",
    afterMove.basis === "fallback" && afterMove.deadline.getTime() === at(h2Row, "end").getTime() + 7 * DAY,
  );

  // An earlier session of the class is never "next".
  const c4 = await makeClass(centerId, teacherId);
  await makeSession(centerId, c4.id, teacherId, -2, "09:00");
  const h4 = await makeSession(centerId, c4.id, teacherId, 2, "09:00", { timezone: "Asia/Dubai" });
  const h4Row = await prisma.session.findUniqueOrThrow({ where: { id: h4.id } });
  const dubai = await homeworkDeadlineFor(prisma, centerId, { ...h4Row, classGroupId: c4.id }, cairo);
  const dubaiEnd = zonedDateTimeToUtc(dateKey(h4Row.date), 10 * 60, "Asia/Dubai");
  check(
    "An earlier session is never next, and the session's own frozen timezone is used (Asia/Dubai, not the branch's)",
    dubai.basis === "fallback" &&
      dubai.deadline.getTime() === dubaiEnd.getTime() + 7 * DAY &&
      dubaiEnd.getTime() !== zonedDateTimeToUtc(dateKey(h4Row.date), 10 * 60, cairo).getTime(),
    dubai.deadline.toISOString(),
  );
}

// ── 3. Limits, CHECKs and readiness ────────────────────────────────────────

function checkLimits() {
  console.log("\n3a. Every save limit (draftErrors)");
  const L = ASSESSMENT_LIMITS;
  check("A valid exam draft has no errors", codes("EXAM", examDraft()).length === 0, codes("EXAM", examDraft()).join(","));
  check("A valid homework draft has no errors", codes("HOMEWORK", homeworkDraft(new Date(Date.now() + DAY))).length === 0);
  check("1 option is refused; 2 is allowed", codes("EXAM", examDraft({ questions: [question(1)] })).includes("optionCount") && codes("EXAM", examDraft({ questions: [question(2)] })).length === 0);
  check("6 options are refused; 5 is allowed", codes("EXAM", examDraft({ questions: [question(6)] })).includes("optionCount") && codes("EXAM", examDraft({ questions: [question(5)] })).length === 0);
  const twoCorrect = question(4);
  twoCorrect.options[1].isCorrect = true;
  check("Two correct options are refused (at most one)", codes("EXAM", examDraft({ questions: [twoCorrect] })).includes("multipleCorrect"));
  check("No correct option is still savable (a draft)", codes("EXAM", examDraft({ questions: [question(4, -1)] })).length === 0);
  check(
    "Points 0, 101 and 1.5 are refused; 1 and 100 are allowed",
    [0, 101, 1.5].every((points) => codes("EXAM", examDraft({ questions: [question(4, 0, { points })] })).includes("pointsRange")) &&
      [1, 100].every((points) => codes("EXAM", examDraft({ questions: [question(4, 0, { points })] })).length === 0),
  );
  check(
    `${L.maxQuestions + 1} questions are refused; ${L.maxQuestions} are allowed`,
    codes("EXAM", examDraft({ questions: Array.from({ length: L.maxQuestions + 1 }, () => question()) })).includes("tooManyQuestions") &&
      codes("EXAM", examDraft({ questions: Array.from({ length: L.maxQuestions }, () => question()) })).length === 0,
  );
  check(
    "Question text over 2,000 characters is refused; exactly 2,000 is allowed",
    codes("EXAM", examDraft({ questions: [question(4, 0, { text: "x".repeat(2001) })] })).includes("questionTooLong") &&
      codes("EXAM", examDraft({ questions: [question(4, 0, { text: "x".repeat(2000) })] })).length === 0,
  );
  const longOption = question();
  longOption.options[0].text = "x".repeat(501);
  const okOption = question();
  okOption.options[0].text = "x".repeat(500);
  check(
    "Option text over 500 characters is refused; exactly 500 is allowed",
    codes("EXAM", examDraft({ questions: [longOption] })).includes("optionTooLong") && codes("EXAM", examDraft({ questions: [okOption] })).length === 0,
  );
  check(
    "Duration 0 and 601 are refused; 1 and 600 (in a long enough window) are allowed",
    [0, 601].every((d) => codes("EXAM", examDraft({ durationMinutes: d })).includes("durationRange")) &&
      [1, 600].every((d) => codes("EXAM", examDraft({ durationMinutes: d, windowEnd: new Date(Date.now() + 2 * DAY) })).length === 0),
  );
  const start = new Date(Date.now() + DAY);
  check(
    "windowEnd equal to or before windowStart is refused",
    codes("EXAM", examDraft({ windowStart: start, windowEnd: start })).includes("windowOrder") &&
      codes("EXAM", examDraft({ windowStart: start, windowEnd: new Date(start.getTime() - MINUTE) })).includes("windowOrder"),
  );
  check(
    "A duration longer than the window is refused; equal is allowed",
    codes("EXAM", examDraft({ windowStart: start, windowEnd: new Date(start.getTime() + 30 * MINUTE), durationMinutes: 31 })).includes("durationLongerThanWindow") &&
      codes("EXAM", examDraft({ windowStart: start, windowEnd: new Date(start.getTime() + 30 * MINUTE), durationMinutes: 30 })).length === 0,
  );
  check("An exam draft without a window is savable", codes("EXAM", examDraft({ windowStart: null, windowEnd: null })).length === 0);
  check("A homework without a deadline is refused", codes("HOMEWORK", homeworkDraft(new Date(), { deadline: null })).includes("deadlineRequired"));
  check(
    "A homework with a window or one sitting, or an exam with a deadline, is refused",
    codes("HOMEWORK", homeworkDraft(new Date(), { windowStart: start })).includes("fieldsForType") &&
      codes("HOMEWORK", homeworkDraft(new Date(), { oneSitting: true })).includes("fieldsForType") &&
      codes("EXAM", examDraft({ deadline: start })).includes("fieldsForType"),
  );
  check(
    "An empty title is refused; over 200 characters is refused",
    codes("EXAM", examDraft({ title: "  " })).includes("titleRequired") && codes("EXAM", examDraft({ title: "x".repeat(201) })).includes("titleTooLong"),
  );

  console.log("\n3b. Ready to publish (computed; enforced at publish in W3)");
  const now = new Date();
  const ready = (type: "EXAM" | "HOMEWORK", draft: AssessmentDraft) =>
    Object.fromEntries(readiness(type, draft, now).map((item) => [item.key, item.ok]));
  check("A complete exam is ready", isReady(readiness("EXAM", examDraft(), now)));
  check("No questions → not ready", ready("EXAM", examDraft({ questions: [] })).hasQuestions === false);
  check("An empty option → not ready", ready("EXAM", examDraft({ questions: [{ ...question(), options: [{ text: "", isCorrect: true }, { text: "b", isCorrect: false }] }] })).allTextFilled === false);
  check("No correct option → not ready", ready("EXAM", examDraft({ questions: [question(4, -1)] })).oneCorrectEach === false);
  check("An exam with no window → not ready", ready("EXAM", examDraft({ windowEnd: null })).windowSet === false);
  check(
    "A homework deadline in the past → not ready; in the future → ready",
    ready("HOMEWORK", homeworkDraft(new Date(now.getTime() - MINUTE))).deadlineInFuture === false &&
      isReady(readiness("HOMEWORK", homeworkDraft(new Date(now.getTime() + DAY)), now)),
  );
}

async function checkDatabaseConstraints(centerId: string, membershipId: string, classGroupId: string, userId: string) {
  console.log("\n3c. The database backs the limits (CHECKs, the one-correct partial unique index)");
  const base = { centerId, classGroupId, teacherMembershipId: membershipId, title: "raw", createdByUserId: userId, updatedByUserId: userId };
  check("An EXAM with a deadline is refused by the CHECK", await refusedByDb(() => prisma.assessment.create({ data: { ...base, type: "EXAM", deadline: new Date() } })));
  check("A HOMEWORK with no session is refused by the CHECK", await refusedByDb(() => prisma.assessment.create({ data: { ...base, type: "HOMEWORK", deadline: new Date() } })));
  check("windowEnd before windowStart is refused by the CHECK", await refusedByDb(() => prisma.assessment.create({ data: { ...base, type: "EXAM", windowStart: new Date(Date.now() + DAY), windowEnd: new Date() } })));
  check("durationMinutes 601 is refused by the CHECK", await refusedByDb(() => prisma.assessment.create({ data: { ...base, type: "EXAM", durationMinutes: 601 } })));
  const row = await prisma.assessment.create({ data: { ...base, type: "EXAM" } });
  check("Points 101 are refused by the CHECK", await refusedByDb(() => prisma.assessmentQuestion.create({ data: { centerId, assessmentId: row.id, position: 0, text: "q", points: 101 } })));
  const q = await prisma.assessmentQuestion.create({ data: { centerId, assessmentId: row.id, position: 0, text: "q" } });
  await prisma.assessmentOption.create({ data: { centerId, questionId: q.id, position: 0, text: "a", isCorrect: true } });
  check(
    "A second correct option on one question is refused by the partial unique index",
    await refusedByDb(() => prisma.assessmentOption.create({ data: { centerId, questionId: q.id, position: 1, text: "b", isCorrect: true } })),
  );
  const index = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'AssessmentOption' AND indexname = 'AssessmentOption_one_correct_per_question'`;
  check("AssessmentOption_one_correct_per_question exists, partial on isCorrect", index.length === 1 && /UNIQUE/.test(index[0].indexdef) && /WHERE "isCorrect"/.test(index[0].indexdef));
  await prisma.assessment.delete({ where: { id: row.id } });
}

// ── 4. Who can ─────────────────────────────────────────────────────────────

async function checkWhoCan(ids: {
  centerA: string;
  centerB: string;
  teacherA: { userId: string; membershipId: string };
  teacherA2: { userId: string; membershipId: string };
  teacherB: { userId: string; membershipId: string };
  ownerUserId: string;
  staffUserIds: Record<"MANAGER" | "RECEPTIONIST" | "ACCOUNTANT", string>;
}) {
  console.log("\n4. Who can (D-W11, D-W30)");
  const { centerA, centerB } = ids;

  const asA = await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "TEACHER"));
  const asA2 = await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA2.userId, "TEACHER"));
  const asB = await resolveAssessmentTeacher(prisma, await authority(centerB, ids.teacherB.userId, "TEACHER"));
  check("A TEACHER with the baseline grant and an active membership resolves", asA?.membershipId === ids.teacherA.membershipId && asA2 !== null && asB !== null);
  if (!asA || !asA2 || !asB) return null;
  const actorA = { userId: ids.teacherA.userId };

  // Centre staff — even with a stray grant row — never resolve.
  await savePermissionGrants(prisma, centerA, [
    { role: "MANAGER", action: "assessment.manage.own", allowed: true },
    { role: "RECEPTIONIST", action: "assessment.manage.own", allowed: true },
    { role: "ACCOUNTANT", action: "assessment.manage.own", allowed: true },
  ]);
  const staff = await Promise.all(
    (["MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const).map(async (role) =>
      resolveAssessmentTeacher(prisma, await authority(centerA, ids.staffUserIds[role], role)),
    ),
  );
  check("MANAGER, RECEPTIONIST and ACCOUNTANT never resolve — even with a stray grant row (the ceiling)", staff.every((value) => value === null));
  check("OWNER never resolves (assessments are the teacher's own)", (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.ownerUserId, "OWNER"))) === null);
  check(
    "A denied teacher experience grants nothing",
    (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "TEACHER", true))) === null,
  );
  check(
    "STUDENT and PARENT never resolve",
    (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "STUDENT"))) === null &&
      (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "PARENT"))) === null,
  );

  // An exam: the class's teacher only.
  const classA = await makeClass(centerA, ids.teacherA.userId);
  const exam = await createAssessment(prisma, actorA, asA, { type: "EXAM", classGroupId: classA.id, draft: examDraft() });
  check("The class's teacher creates an exam", exam.ok);
  const examRow = exam.ok ? await prisma.assessment.findUniqueOrThrow({ where: { id: exam.id } }) : null;
  check(
    "…stored as a DRAFT with the exam defaults, owned by their membership, the actor recorded",
    examRow !== null &&
      examRow.status === "DRAFT" &&
      examRow.durationMinutes === 30 &&
      examRow.shuffle &&
      !examRow.showScore &&
      !examRow.showCorrectAnswers &&
      examRow.teacherMembershipId === ids.teacherA.membershipId &&
      examRow.createdByUserId === ids.teacherA.userId &&
      examRow.centerId === centerA,
  );
  const otherTeacherExam = await createAssessment(prisma, { userId: ids.teacherA2.userId }, asA2, { type: "EXAM", classGroupId: classA.id, draft: examDraft() });
  check("Another teacher at the same branch cannot set an exam on that class", !otherTeacherExam.ok && otherTeacherExam.error === "notFound");
  const crossCentreExam = await createAssessment(prisma, { userId: ids.teacherB.userId }, asB, { type: "EXAM", classGroupId: classA.id, draft: examDraft() });
  check("A teacher at another branch cannot set an exam on it (cross-centre)", !crossCentreExam.ok && crossCentreExam.error === "notFound");

  // A homework: the session's teacher — a per-session change counts.
  const own = await makeSession(centerA, classA.id, ids.teacherA.userId, 2, "15:00");
  const covered = await makeSession(centerA, classA.id, ids.teacherA2.userId, 4, "15:00");
  const deadline = new Date(Date.now() + 3 * DAY);
  const hwOwn = await createAssessment(prisma, actorA, asA, { type: "HOMEWORK", sessionId: own.id, draft: homeworkDraft(deadline) });
  const hwRow = hwOwn.ok ? await prisma.assessment.findUniqueOrThrow({ where: { id: hwOwn.id } }) : null;
  check(
    "The session's teacher sets homework; the class comes from the session; homework defaults stored",
    hwRow !== null &&
      hwRow.classGroupId === classA.id &&
      hwRow.sessionId === own.id &&
      hwRow.durationMinutes === null &&
      !hwRow.shuffle &&
      hwRow.showScore &&
      hwRow.showCorrectAnswers &&
      hwRow.deadline?.getTime() === deadline.getTime(),
  );
  const hwCover = await createAssessment(prisma, { userId: ids.teacherA2.userId }, asA2, { type: "HOMEWORK", sessionId: covered.id, draft: homeworkDraft(deadline) });
  check("A teacher covering one session (per-session teacher change) sets its homework", hwCover.ok);
  const hwNotTheirs = await createAssessment(prisma, actorA, asA, { type: "HOMEWORK", sessionId: covered.id, draft: homeworkDraft(deadline) });
  check("The class's teacher cannot set homework on a session someone else teaches", !hwNotTheirs.ok && hwNotTheirs.error === "notFound");
  const oneOff = await makeSession(centerA, null, ids.teacherA.userId, 2, "18:00");
  const hwOneOff = await createAssessment(prisma, actorA, asA, { type: "HOMEWORK", sessionId: oneOff.id, draft: homeworkDraft(deadline) });
  check("A one-time session takes no homework (no enrolment, D-W03)", !hwOneOff.ok && hwOneOff.error === "notFound");
  const cancelled = await makeSession(centerA, classA.id, ids.teacherA.userId, 6, "15:00", { status: "CANCELLED" });
  const hwCancelled = await createAssessment(prisma, actorA, asA, { type: "HOMEWORK", sessionId: cancelled.id, draft: homeworkDraft(deadline) });
  check("A cancelled session takes no homework", !hwCancelled.ok && hwCancelled.error === "notFound");
  const movedAway = await makeSession(centerA, classA.id, ids.teacherA.userId, 7, "15:00");
  const movedTo = await makeSession(centerA, classA.id, ids.teacherA.userId, 8, "15:00");
  await prisma.session.update({ where: { id: movedAway.id }, data: { rescheduledToId: movedTo.id } });
  const hwMoved = await createAssessment(prisma, actorA, asA, { type: "HOMEWORK", sessionId: movedAway.id, draft: homeworkDraft(deadline) });
  check("A session moved away takes no homework (its replacement does)", !hwMoved.ok && hwMoved.error === "notFound");
  const hwCross = await createAssessment(prisma, { userId: ids.teacherB.userId }, asB, { type: "HOMEWORK", sessionId: own.id, draft: homeworkDraft(deadline) });
  check("A teacher at another branch cannot set homework on this branch's session", !hwCross.ok && hwCross.error === "notFound");

  // After creation: the owning membership is the authority.
  if (!exam.ok) return null;
  check("The owner reads their draft", (await findTeacherAssessment(prisma, asA, exam.id)) !== null);
  check("Another teacher at the branch reads nothing", (await findTeacherAssessment(prisma, asA2, exam.id)) === null);
  check(
    "A teacher at another branch reads nothing (even naming this branch's row id)",
    (await findTeacherAssessment(prisma, asB, exam.id)) === null &&
      (await findTeacherAssessment(prisma, { ...asB, centerId: centerA }, exam.id)) === null,
  );
  const coverId = hwCover.ok ? hwCover.id : null;
  check(
    "Lists hold the owner's own rows only",
    (await listTeacherAssessments(prisma, asA)).every((row) => row.id !== coverId) &&
      (await listTeacherAssessments(prisma, asA2)).every((row) => row.id !== exam.id) &&
      (await listTeacherAssessments(prisma, asB)).length === 0,
  );
  const foreignSave = await saveAssessmentDraft(prisma, { userId: ids.teacherA2.userId }, asA2, exam.id, examDraft());
  const crossSave = await saveAssessmentDraft(prisma, { userId: ids.teacherB.userId }, asB, exam.id, examDraft());
  const foreignDelete = await deleteAssessment(prisma, { userId: ids.teacherA2.userId }, asA2, exam.id);
  check(
    "Another teacher, and another branch, can neither save nor delete it",
    !foreignSave.ok && foreignSave.error === "notFound" && !crossSave.ok && crossSave.error === "notFound" && !foreignDelete.ok && foreignDelete.error === "notFound",
  );

  // The Owner switches the cell off — refused; back on — restored.
  await savePermissionGrants(prisma, centerA, [{ role: "TEACHER", action: "assessment.manage.own", allowed: false }]);
  check(
    "The Owner switches assessment.manage.own off for TEACHER: the teacher no longer resolves",
    (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "TEACHER"))) === null,
  );
  await savePermissionGrants(prisma, centerA, [{ role: "TEACHER", action: "assessment.manage.own", allowed: true }]);
  check(
    "Switched back on: the teacher resolves again",
    (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA.userId, "TEACHER"))) !== null,
  );

  // A deactivated membership: no resolution, and a writer holding an old handle refuses.
  await prisma.membership.update({ where: { id: ids.teacherA2.membershipId }, data: { active: false } });
  check("An inactive TEACHER membership does not resolve", (await resolveAssessmentTeacher(prisma, await authority(centerA, ids.teacherA2.userId, "TEACHER"))) === null);
  const staleSave = hwCover.ok ? await saveAssessmentDraft(prisma, { userId: ids.teacherA2.userId }, asA2, hwCover.id, homeworkDraft(deadline)) : null;
  check("…and a write with a handle resolved before the deactivation is refused (re-read in the write)", staleSave !== null && !staleSave.ok && staleSave.error === "forbidden");
  await prisma.membership.update({ where: { id: ids.teacherA2.membershipId }, data: { active: true } });

  return { teacher: asA, actor: actorA, examId: exam.id, homeworkId: hwOwn.ok ? hwOwn.id : null };
}

// ── 5. The student serializer ──────────────────────────────────────────────

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

async function checkSerializer(teacher: AssessmentTeacher, examId: string, actor: { userId: string }) {
  console.log("\n5. The student-facing serializer (D-W09)");
  const saved = await saveAssessmentDraft(prisma, actor, teacher, examId, examDraft({ questions: [question(4, 2), question(3, 0), question(5, 4)] }));
  check("A three-question draft saves", saved.ok);
  const row = await findTeacherAssessment(prisma, teacher, examId);
  if (!row) return check("…and reads back", false);
  check("The teacher's builder read does carry isCorrect (the control)", row.questions.some((q) => q.options.some((o) => o.isCorrect)));
  const view = toStudentAssessment(row);
  const json = JSON.stringify(view);
  check("toStudentAssessment of a full teacher row never names isCorrect or correct", !/isCorrect|"correct"/i.test(json) && !keysDeep(view).has("isCorrect"));
  check("…and keeps every question and option (text, points, ids)", view.questions.length === 3 && view.questions[2].options.length === 5 && view.totalPoints === 3);
  check("STUDENT_ASSESSMENT_SELECT names isCorrect nowhere", !keysDeep(STUDENT_ASSESSMENT_SELECT).has("isCorrect"));
  const studentRead = await prisma.assessment.findFirst({ where: { id: examId, centerId: teacher.centerId }, select: STUDENT_ASSESSMENT_SELECT });
  check("A database read with the student select returns no isCorrect", studentRead !== null && !keysDeep(studentRead).has("isCorrect"));
  const seeded = (() => {
    let x = 7;
    return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  })();
  const order = drawOrder(row, seeded);
  const drawn = toStudentAssessment(row, order);
  check(
    "A drawn order is honoured for questions and options, and still carries no correctness",
    drawn.questions.map((q) => q.id).join() === order.questions.join() &&
      drawn.questions.every((q) => q.options.map((o) => o.id).join() === order.options[q.id].join()) &&
      !keysDeep(drawn).has("isCorrect"),
  );
  check(
    "The preview page renders only the serializer's output (static)",
    /toStudentAssessment\(row/.test(readSource(join(ROOT, "app/[locale]/(teacher)/teacher/assessments/[id]/preview/page.tsx"))) &&
      !/isCorrect/.test(readSource(join(ROOT, "app/[locale]/(teacher)/teacher/assessments/[id]/preview/page.tsx"))),
  );
}

// ── 6. The lock helper ─────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (/node_modules|\.next/.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Each top-level function in a source file, with its body (until the next top-level declaration). */
function functionBodies(source: string): { name: string; body: string }[] {
  const starts = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)];
  return starts.map((match, i) => ({
    name: match[1],
    body: source.slice(match.index, i + 1 < starts.length ? starts[i + 1].index : undefined),
  }));
}

async function checkLock(teacher: AssessmentTeacher, examId: string) {
  console.log("\n6. The lock helper (D-W08)");
  check("isAssessmentLocked is false in W2 (no attempts exist)", (await isAssessmentLocked(prisma, teacher.centerId, examId)) === false);
  const source = readSource(join(ROOT, "lib/db/assessments.ts"));
  // A direct write of a question or option row, or a delete of an assessment (its questions cascade).
  const directWrite =
    /\b(?:assessmentQuestion|assessmentOption)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\bassessment\.(?:deleteMany|delete)\(/;
  const bodies = functionBodies(source);
  const direct = bodies.filter((fn) => directWrite.test(fn.body));
  const viaReplace = bodies.filter((fn) => fn.name !== "replaceQuestions" && /replaceQuestions\(/.test(fn.body));
  const unlocked = direct.filter((fn) => !/isAssessmentLocked\(/.test(fn.body));
  check(
    `Every direct question/option writer asks isAssessmentLocked (${direct.map((fn) => fn.name).join(", ")})`,
    direct.some((fn) => fn.name === "replaceQuestions") && direct.some((fn) => fn.name === "deleteAssessment") && unlocked.length === 0,
    unlocked.map((fn) => fn.name).join(", "),
  );
  check(
    `Every other question writer goes through replaceQuestions (${viaReplace.map((fn) => fn.name).join(", ")})`,
    viaReplace.some((fn) => fn.name === "createAssessment") &&
      viaReplace.some((fn) => fn.name === "saveAssessmentDraft") &&
      direct.filter((fn) => /assessmentQuestion\./.test(fn.body)).every((fn) => fn.name === "replaceQuestions"),
  );
  const replace = functionBodies(source).find((fn) => fn.name === "replaceQuestions")?.body ?? "";
  check(
    "replaceQuestions asks the lock before its first write",
    replace.indexOf("isAssessmentLocked(") > -1 && replace.indexOf("isAssessmentLocked(") < replace.indexOf("assessmentQuestion.deleteMany("),
  );
  const outside = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "components"))]
    .filter((file) => !file.replace(/\\/g, "/").endsWith("lib/db/assessments.ts"))
    .filter((file) => /\b(?:assessment|assessmentQuestion|assessmentOption)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(readSource(file)));
  check("Nothing outside lib/db/assessments.ts writes an assessment, question or option", outside.length === 0, outside.map((f) => relative(ROOT, f)).join(", "));
}

// ── 7. Audit ───────────────────────────────────────────────────────────────

async function checkAudit(teacher: AssessmentTeacher, actor: { userId: string }, classGroupId: string) {
  console.log("\n7. Audit rows (ids and counts only, D-20)");
  const created = await createAssessment(prisma, actor, teacher, {
    type: "EXAM",
    classGroupId,
    draft: examDraft({ title: "Secret Title Text", instructions: "Private instructions", questions: [question(4, 0, { text: "Hidden question text" })] }),
  });
  if (!created.ok) return check("create for the audit check", false);
  await saveAssessmentDraft(prisma, actor, teacher, created.id, examDraft({ title: "Secret Title Two", questions: [question(), question()] }));
  const deleted = await deleteAssessment(prisma, actor, teacher, created.id);
  const rows = await prisma.auditLog.findMany({ where: { entityType: "Assessment", entityId: created.id }, orderBy: { createdAt: "asc" } });
  const actions = rows.map((row) => row.action);
  check(
    "assessment.create, assessment.update and assessment.delete each write one row, actor = the actor, on the branch",
    deleted.ok &&
      ["assessment.create", "assessment.update", "assessment.delete"].every((action) => actions.filter((a) => a === action).length === 1) &&
      rows.every((row) => row.actorUserId === actor.userId && row.centerId === teacher.centerId),
    actions.join(", "),
  );
  const payloads = JSON.stringify(rows.map((row) => [row.before, row.after]));
  check(
    "No row carries a forbidden key or any typed text (title, instructions, question)",
    rows.every((row) => forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null) &&
      !/Secret Title|Private instructions|Hidden question/.test(payloads),
  );
  check("The deleted draft and its questions are gone (cascade)", (await prisma.assessmentQuestion.count({ where: { assessmentId: created.id } })) === 0);
}

// ── 8. RLS, backfill, ceiling ──────────────────────────────────────────────

async function checkRlsAndGrants() {
  console.log("\n8. RLS, the backfill and the permission ceiling");
  const tables = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('Assessment', 'AssessmentQuestion', 'AssessmentOption')`;
  const policies = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Assessment', 'AssessmentQuestion', 'AssessmentOption')`;
  check("RLS is on for Assessment, AssessmentQuestion and AssessmentOption", tables.length === 3 && tables.every((t) => t.relrowsecurity), JSON.stringify(tables));
  check("…with zero policies", Number(policies[0]?.count ?? -1) === 0);

  const migration = readSource(join(ROOT, "prisma/migrations/20261104090000_w2_assessments/migration.sql"));
  check(
    "The migration backfills the TEACHER grant for every centre, idempotently (static)",
    /INSERT INTO "PermissionGrant"[\s\S]*'TEACHER'::"Role", 'assessment\.manage\.own', true[\s\S]*FROM "Center" c\s*ON CONFLICT \("centerId", "role", "action"\) DO NOTHING/.test(migration),
  );
  check("The migration drops nothing (additive)", !/\bDROP\b/i.test(migration.replace(/--.*$/gm, "")));
  const prefixes = gateSlugPrefixes();
  const missing = await prisma.center.findMany({
    where: {
      permissionGrants: { none: { role: "TEACHER", action: "assessment.manage.own" } },
      NOT: prefixes.map((prefix) => ({ slug: { startsWith: prefix } })),
    },
    select: { slug: true },
  });
  check("Every existing branch holds a TEACHER assessment.manage.own row (the backfill applied)", missing.length === 0, missing.map((c) => c.slug).join(", "));

  const allOpen = Object.fromEntries(PERMISSIONS.map((permission) => [permission, true])) as Record<Permission, boolean>;
  check("assessment.manage.own is in the catalogue and TEACHER's baseline", PERMISSIONS.includes("assessment.manage.own") && DEFAULT_ROLE_GRANTS.TEACHER.includes("assessment.manage.own"));
  check("No centre staff role's baseline holds it", (["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const).every((role) => !DEFAULT_ROLE_GRANTS[role].includes("assessment.manage.own")));
  check(
    "MANAGER, RECEPTIONIST and ACCOUNTANT can never hold it, with every cell open (the ceiling)",
    (["MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const).every((role) => !can(role, "assessment.manage.own", allOpen)),
  );
  check(
    "Only TEACHER's matrix cell is editable for it — the Owner's switch",
    editableActionsFor("TEACHER").includes("assessment.manage.own") &&
      (["MANAGER", "RECEPTIONIST", "ACCOUNTANT"] as const).every((role) => !editableActionsFor(role).includes("assessment.manage.own")),
  );
  check("TEACHER is denied without a stored row (deny-by-default)", !can("TEACHER", "assessment.manage.own", {}));
}

// ── The close route's origin check (SEC-52, fails closed) ──────────────────

function checkCloseRouteOrigin() {
  console.log("\nClose route — the origin check fails closed");
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });
  const app = "https://kayedu.example";
  const allowed = allowedOrigins(headers({}), app, "https:");
  const accepts = (values: Record<string, string>, list = allowed) =>
    isSameOriginRequest({ origin: values.origin ?? null, secFetchSite: values["sec-fetch-site"] ?? null }, list);

  check("The configured origin is the only allowed one", allowed.length === 1 && allowed[0] === app);
  check("Same origin is accepted", accepts({ origin: app }));
  check("Same origin with Sec-Fetch-Site same-origin is accepted", accepts({ origin: app, "sec-fetch-site": "same-origin" }));
  check("A missing Origin is refused", !accepts({}));
  check("A foreign origin is refused", !accepts({ origin: "https://evil.example" }));
  check("A lookalike host (suffix) is refused", !accepts({ origin: "https://kayedu.example.evil.example" }));
  check("A lookalike host (prefix) is refused", !accepts({ origin: "https://evil-kayedu.example" }));
  check("A subdomain is refused", !accepts({ origin: "https://a.kayedu.example" }));
  check("The wrong scheme is refused", !accepts({ origin: "http://kayedu.example" }));
  check("The wrong port is refused", !accepts({ origin: "https://kayedu.example:8443" }));
  check("An origin with a path is refused", !accepts({ origin: "https://kayedu.example/x" }));
  check("The literal Origin 'null' is refused", !accepts({ origin: "null" }));
  check("A non-http scheme is refused", !accepts({ origin: "chrome-extension://kayedu.example" }));
  check("Sec-Fetch-Site cross-site is refused even with the right Origin", !accepts({ origin: app, "sec-fetch-site": "cross-site" }));
  check("Sec-Fetch-Site same-site is refused", !accepts({ origin: app, "sec-fetch-site": "same-site" }));
  check("No allowed origin at all refuses everything", !accepts({ origin: app }, []));

  const own = allowedOrigins(headers({ host: "localhost:3000" }), undefined, "http:");
  check("Without a configured origin the request's own scheme and host are used", own.length === 1 && own[0] === "http://localhost:3000");
  check("…and a matching Origin is accepted there", accepts({ origin: "http://localhost:3000" }, own));
  check("…while the wrong scheme is not", !accepts({ origin: "https://localhost:3000" }, own));
  check("No host and no configured origin → nothing allowed", allowedOrigins(headers({}), undefined, "https:").length === 0);

  const route = readSource(join(ROOT, "app/api/assessment-attempts/[attemptId]/close/route.ts"));
  const guard = route.indexOf("isSameOriginRequest(");
  check(
    "The route runs the check before it reads the session or the attempt",
    guard > -1 && guard < route.indexOf("getCurrentUser(") && guard < route.indexOf("attemptIdSchema.safeParse") && /status: 403/.test(route),
  );
}

// ── 9. Statics ─────────────────────────────────────────────────────────────

function checkStatics() {
  console.log("\n9. Statics — who imports the module, and the action guards");
  const groups = ["(center)", "(student)", "(parent)", "(admin)"];
  const offenders = groups.flatMap((group) =>
    walk(join(ROOT, "app", "[locale]", group)).filter((file) => /lib\/db\/assessments|lib\/assessments"|teacher\/assessments\//.test(readSource(file))),
  );
  check("No centre, student, parent or admin file imports the assessment modules (D-W11)", offenders.length === 0, offenders.map((f) => relative(ROOT, f)).join(", "));
  const componentOffenders = walk(join(ROOT, "components"))
    .filter((file) => !/components[\\/]teacher[\\/]/.test(file))
    .filter((file) => /lib\/db\/assessments/.test(readSource(file)));
  check("Only teacher components read the assessment data module", componentOffenders.length === 0, componentOffenders.map((f) => relative(ROOT, f)).join(", "));

  const actions = readSource(join(ROOT, "app/[locale]/(teacher)/teacher/assessments/actions.ts"));
  const bodies = functionBodies(actions).filter((fn) => /Action$/.test(fn.name));
  check(
    `Every builder action re-resolves the branch, then the owning teacher (${bodies.map((fn) => fn.name).join(", ")})`,
    bodies.length === 2 &&
      bodies.every((fn) => {
        const branch = fn.body.indexOf("teacherBranchContext(");
        const teacher = fn.body.indexOf("resolveAssessmentTeacher(");
        return branch > -1 && teacher > branch && !/getTenantContext\(/.test(fn.body);
      }),
  );
  check("No builder action reads a teacher id from the form", !/formData\.get\("teacher|teacherMembershipId:\s*parsed/.test(actions));
}

// ── 10–19. Publishing and taking (W3a, D-W02, D-W05–D-W11, D-W31) ───────────

const HOUR = 60 * MINUTE;

let studentSeq = 0;
async function makeStudent(centerId: string, tag: string, classGroupId?: string) {
  studentSeq += 1;
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: tag, email: `${STEM}-${tag}-${studentSeq}@kayedu.test`, locale: "en" },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: `${tag}-${studentSeq}`, firstName: "S", lastName: tag }),
  });
  if (classGroupId) {
    await prisma.enrollment.create({ data: scopedData(centerId, { studentProfileId: profile.id, classGroupId }) });
  }
  const student: AssessmentStudent = { centerId, studentProfileId: profile.id, userId: user.id };
  return { user, profile, student };
}

/** 2 + 3 + 5 points; the first option of each question is the correct one. */
function scoredQuestions(): DraftQuestion[] {
  return [question(4, 0, { points: 2 }), question(4, 0, { points: 3 }), question(4, 0, { points: 5 })];
}

type Fixture = { teacher: AssessmentTeacher; actor: { userId: string }; classGroupId: string };

async function publishedExam(fx: Fixture, now: Date, extra: Partial<AssessmentDraft> = {}) {
  const created = await createAssessment(prisma, fx.actor, fx.teacher, {
    type: "EXAM",
    classGroupId: fx.classGroupId,
    draft: examDraft({
      windowStart: new Date(now.getTime() - 3 * HOUR),
      windowEnd: new Date(now.getTime() + 3 * HOUR),
      durationMinutes: 30,
      questions: scoredQuestions(),
      ...extra,
    }),
  });
  if (!created.ok) throw new Error(`fixture exam: ${JSON.stringify(created)}`);
  const published = await publishAssessment(prisma, fx.actor, fx.teacher, created.id, now);
  if (!published.ok) throw new Error(`fixture publish: ${JSON.stringify(published)}`);
  return created.id;
}

async function optionsOf(assessmentId: string) {
  const questions = await prisma.assessmentQuestion.findMany({
    where: { assessmentId },
    orderBy: { position: "asc" },
    include: { options: { orderBy: { position: "asc" } } },
  });
  return questions.map((row) => ({
    id: row.id,
    right: row.options.find((option) => option.isCorrect)!.id,
    wrong: row.options.find((option) => !option.isCorrect)!.id,
    points: row.points,
  }));
}

function checkTimeRules() {
  console.log("\n10. End-time derivation, due, state, reveal, grading (pure)");
  const start = new Date("2026-11-10T10:00:00Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);
  const exam: AssessmentTiming = { type: "EXAM", windowStart: at(-60), windowEnd: at(120), deadline: null, durationMinutes: 30, oneSitting: false };
  const lateStart: AssessmentTiming = { ...exam, windowEnd: at(10) };
  const untimed: AssessmentTiming = { type: "HOMEWORK", windowStart: null, windowEnd: null, deadline: at(600), durationMinutes: null, oneSitting: false };
  const timedHomework: AssessmentTiming = { ...untimed, durationMinutes: 45 };
  const tightHomework: AssessmentTiming = { ...untimed, durationMinutes: 45, deadline: at(5) };
  check("EXAM end = startedAt + duration when the window is later", attemptEnd(exam, start).getTime() === at(30).getTime());
  check("EXAM end = windowEnd when the window closes first", attemptEnd(lateStart, start).getTime() === at(10).getTime());
  check("HOMEWORK untimed end = the deadline", attemptEnd(untimed, start).getTime() === at(600).getTime());
  check("HOMEWORK timed end = startedAt + duration", attemptEnd(timedHomework, start).getTime() === at(45).getTime());
  check("HOMEWORK timed end = the deadline when it comes first", attemptEnd(tightHomework, start).getTime() === at(5).getTime());

  const seen = { startedAt: start, lastSeenAt: at(5) };
  check("Before its end an attempt is not due", finalisationDue(exam, seen, at(29)) === null);
  const due = finalisationDue(exam, seen, at(500));
  check("Past its end: DEADLINE, stamped at the end, not at the read", due?.finalisedBy === "DEADLINE" && due.submittedAt.getTime() === at(30).getTime(), JSON.stringify(due));
  const sitting: AssessmentTiming = { ...exam, oneSitting: true };
  check("One sitting, silent within the grace: not due", finalisationDue(sitting, seen, new Date(at(5).getTime() + ONE_SITTING_GRACE_SECONDS * 1_000)) === null);
  const gap = finalisationDue(sitting, seen, new Date(at(5).getTime() + (ONE_SITTING_GRACE_SECONDS + 1) * 1_000));
  check("One sitting, silent past the grace: ONE_SITTING_GAP, stamped at lastSeenAt", gap?.finalisedBy === "ONE_SITTING_GAP" && gap.submittedAt.getTime() === at(5).getTime(), JSON.stringify(gap));
  const presentToEnd = finalisationDue(sitting, { startedAt: start, lastSeenAt: at(29) }, at(500));
  check("One sitting, still there within the grace of its end: an ordinary DEADLINE", presentToEnd?.finalisedBy === "DEADLINE", JSON.stringify(presentToEnd));
  check("The grace is the one constant, 120 seconds", ONE_SITTING_GRACE_SECONDS === 120);

  check("Start before the exam window → notOpenYet", startRefusal(exam, at(-61)) === "notOpenYet");
  check("Start after the exam window → closed", startRefusal(exam, at(120)) === "closed");
  check("Start inside the window → allowed", startRefusal(exam, at(0)) === null);
  check("Start after the homework deadline → closed", startRefusal(untimed, at(600)) === "closed");

  const state = (attempt: { submittedAt: Date | null } | null, now: Date, row: AssessmentTiming = exam) => studentAssessmentState(row, attempt, now);
  check("State: Upcoming before the window", state(null, at(-61)) === "UPCOMING");
  check("State: Open inside it", state(null, at(0)) === "OPEN");
  check("State: In progress with an open attempt", state({ submittedAt: null }, at(0)) === "IN_PROGRESS");
  check("State: Submitted when final and still open", state({ submittedAt: at(1) }, at(2)) === "SUBMITTED");
  check("State: Missed when closed with no attempt", state(null, at(121)) === "MISSED");
  check("State: Closed when final and closed", state({ submittedAt: at(1) }, at(121)) === "CLOSED");

  const revealRow = { type: "EXAM" as const, windowEnd: at(120), deadline: null, showCorrectAnswers: true };
  const final = { submittedAt: at(1) };
  check("Reveal: all three hold → allowed", revealAllowed(revealRow, final, at(120)));
  check("Reveal: the attempt not final → refused", !revealAllowed(revealRow, { submittedAt: null }, at(121)));
  check("Reveal: not yet closed → refused", !revealAllowed(revealRow, final, at(119)));
  check("Reveal: showCorrectAnswers off → refused", !revealAllowed({ ...revealRow, showCorrectAnswers: false }, final, at(121)));

  const gradeQuestions = [
    { id: "a", points: 2, options: [{ id: "a1", isCorrect: true }, { id: "a2", isCorrect: false }] },
    { id: "b", points: 3, options: [{ id: "b1", isCorrect: true }, { id: "b2", isCorrect: false }] },
    { id: "c", points: 5, options: [{ id: "c1", isCorrect: true }, { id: "c2", isCorrect: false }] },
  ];
  const graded = gradeAnswers(gradeQuestions, [{ questionId: "a", optionId: "a1" }, { questionId: "b", optionId: "b2" }]);
  check("Grading: right scores its points, wrong and unanswered score 0", graded.score === 2 && graded.maxScore === 10 && graded.answers[2].pointsAwarded === 0 && graded.answers[2].optionId === null, JSON.stringify(graded));
  check("Grading: an option from another question scores 0", gradeAnswers(gradeQuestions, [{ questionId: "a", optionId: "b1" }]).score === 0);
  check("Percentage is derived", percentage(2, 10) === 20 && percentage(0, 0) === 0);

  const source = {
    questions: Array.from({ length: 10 }, (_, q) => ({
      id: `q${q}`,
      position: q,
      options: Array.from({ length: 5 }, (_, o) => ({ id: `q${q}o${o}`, position: o, text: "x" })),
      text: "x",
      points: 1,
    })),
  };
  check("Shuffle: the same attempt gets the same order", JSON.stringify(attemptOrder("attempt-a", source)) === JSON.stringify(attemptOrder("attempt-a", source)));
  check("Shuffle: another attempt gets another order", JSON.stringify(attemptOrder("attempt-a", source)) !== JSON.stringify(attemptOrder("attempt-b", source)));
  check("Shuffle: stable whatever order the rows arrive in", JSON.stringify(attemptOrder("attempt-a", source)) === JSON.stringify(attemptOrder("attempt-a", { questions: [...source.questions].reverse() })));
  check("Readiness: an exam whose window has closed is not ready", !isReady(readiness("EXAM", examDraft({ windowStart: at(-120), windowEnd: at(-60) }), start)));
  check("Readiness: an exam whose window is open now is ready", isReady(readiness("EXAM", examDraft({ windowStart: at(-60), windowEnd: at(60) }), start)));
}

async function checkPublishRules(fx: Fixture, otherTeacher: AssessmentTeacher, inactiveClassId: string) {
  console.log("\n11. Publish, unpublish, delete");
  const now = new Date();
  const later = new Date(now.getTime() + DAY);
  const earlier = new Date(now.getTime() - DAY);
  const draftOf = async (extra: Partial<AssessmentDraft>, classGroupId = fx.classGroupId) => {
    const created = await createAssessment(prisma, fx.actor, fx.teacher, { type: "EXAM", classGroupId, draft: examDraft(extra) });
    if (!created.ok) throw new Error(JSON.stringify(created));
    return created.id;
  };

  const empty = await draftOf({ questions: [], windowStart: now, windowEnd: later });
  const notReady = await publishAssessment(prisma, fx.actor, fx.teacher, empty, now);
  check("Publish is refused with no questions", !notReady.ok && notReady.error === "notReady", JSON.stringify(notReady));
  const noCorrect = await draftOf({ questions: [question(4, -1)], windowStart: now, windowEnd: later });
  const noCorrectResult = await publishAssessment(prisma, fx.actor, fx.teacher, noCorrect, now);
  check("Publish is refused with a question that has no correct option", !noCorrectResult.ok && noCorrectResult.error === "notReady");
  const past = await draftOf({ windowStart: new Date(earlier.getTime() - HOUR), windowEnd: earlier });
  const pastResult = await publishAssessment(prisma, fx.actor, fx.teacher, past, now);
  check("Publish is refused once the exam window has closed", !pastResult.ok && pastResult.error === "notReady");

  const open = await draftOf({ windowStart: earlier, windowEnd: later });
  const foreign = await publishAssessment(prisma, { userId: otherTeacher.userId }, otherTeacher, open, now);
  check("Another teacher cannot publish it", !foreign.ok && foreign.error === "notFound");
  const published = await publishAssessment(prisma, fx.actor, fx.teacher, open, now);
  const openRow = await prisma.assessment.findUniqueOrThrow({ where: { id: open } });
  check("An exam can be published while its window is already open", published.ok && openRow.status === "PUBLISHED" && openRow.publishedAt !== null, JSON.stringify(published));
  const again = await publishAssessment(prisma, fx.actor, fx.teacher, open, now);
  check("Publishing twice is refused", !again.ok && again.error === "notDraft");
  const edit = await saveAssessmentDraft(prisma, fx.actor, fx.teacher, open, examDraft({ windowStart: earlier, windowEnd: later }));
  check("A published assessment cannot be saved as a draft", !edit.ok && edit.error === "notDraft");

  const inactive = await draftOf({ windowStart: earlier, windowEnd: later });
  await prisma.assessment.update({ where: { id: inactive }, data: { classGroupId: inactiveClassId } });
  const inactiveResult = await publishAssessment(prisma, fx.actor, fx.teacher, inactive, now);
  check("Publish is refused on an inactive class", !inactiveResult.ok && inactiveResult.error === "classInactive", JSON.stringify(inactiveResult));

  const session = await makeSession(fx.teacher.centerId, fx.classGroupId, fx.teacher.userId, 40, "09:00");
  const pastHomework = await createAssessment(prisma, fx.actor, fx.teacher, { type: "HOMEWORK", sessionId: session.id, draft: homeworkDraft(earlier) });
  const pastHomeworkResult = pastHomework.ok ? await publishAssessment(prisma, fx.actor, fx.teacher, pastHomework.id, now) : pastHomework;
  check("Publish is refused with a homework deadline in the past", !pastHomeworkResult.ok && pastHomeworkResult.error === "notReady", JSON.stringify(pastHomeworkResult));

  const foreignBack = await unpublishAssessment(prisma, { userId: otherTeacher.userId }, otherTeacher, open);
  check("Another teacher cannot unpublish it", !foreignBack.ok && foreignBack.error === "notFound");
  const back = await unpublishAssessment(prisma, fx.actor, fx.teacher, open);
  const backRow = await prisma.assessment.findUniqueOrThrow({ where: { id: open } });
  check("Unpublish with no attempt returns it to DRAFT", back.ok && backRow.status === "DRAFT" && backRow.publishedAt === null);
  const backAgain = await unpublishAssessment(prisma, fx.actor, fx.teacher, open);
  check("Unpublishing a draft is refused", !backAgain.ok && backAgain.error === "notPublished");

  await publishAssessment(prisma, fx.actor, fx.teacher, open, now);
  const removed = await deleteAssessment(prisma, fx.actor, fx.teacher, open);
  check("A published assessment with no attempt can be deleted", removed.ok && (await prisma.assessment.count({ where: { id: open } })) === 0, JSON.stringify(removed));
  const removedDraft = await deleteAssessment(prisma, fx.actor, fx.teacher, empty);
  check("A draft can be deleted", removedDraft.ok);
  for (const id of [noCorrect, past, inactive]) await prisma.assessment.delete({ where: { id } });
  if (pastHomework.ok) await prisma.assessment.delete({ where: { id: pastHomework.id } });
  await prisma.session.delete({ where: { id: session.id } });
}

async function checkStartAndEligibility(fx: Fixture, centerB: string, now: Date) {
  console.log("\n12. Start, eligibility, one attempt");
  const { centerId } = fx.teacher;
  const examId = await publishedExam(fx, now);
  const enrolled = await makeStudent(centerId, "enrolled", fx.classGroupId);

  const before = await startAttempt(prisma, enrolled.student, examId, new Date(now.getTime() - 4 * HOUR));
  check("Start is refused before the window", !before.ok && before.error === "notOpenYet", JSON.stringify(before));
  const after = await startAttempt(prisma, enrolled.student, examId, new Date(now.getTime() + 4 * HOUR));
  check("Start is refused after the window", !after.ok && after.error === "closed", JSON.stringify(after));
  check("A refused start writes no row", (await prisma.assessmentAttempt.count({ where: { assessmentId: examId } })) === 0);

  const [one, two] = await Promise.all([
    startAttempt(prisma, enrolled.student, examId, now),
    startAttempt(prisma, enrolled.student, examId, now),
  ]);
  check("A double start: both answer with the same attempt", one.ok && two.ok && one.attemptId === two.attemptId, JSON.stringify([one, two]));
  check("…and exactly one row exists", (await prisma.assessmentAttempt.count({ where: { assessmentId: examId } })) === 1);
  check("…and one attempt.start audit row", one.ok && (await prisma.auditLog.count({ where: { action: "attempt.start", entityId: one.attemptId } })) === 1);
  const resumed = await startAttempt(prisma, enrolled.student, examId, new Date(now.getTime() + MINUTE));
  check("Starting again resumes the same attempt", resumed.ok && one.ok && resumed.attemptId === one.attemptId && resumed.resumed);
  const row = await prisma.assessmentAttempt.findFirstOrThrow({ where: { assessmentId: examId } });
  check("A resume never moves startedAt", row.startedAt.getTime() === now.getTime());

  const stranger = await makeStudent(centerId, "stranger");
  const strangerStart = await startAttempt(prisma, stranger.student, examId, now);
  check("A student not enrolled is refused by direct call", !strangerStart.ok && strangerStart.error === "notEligible", JSON.stringify(strangerStart));
  check("…and reads nothing", (await readStudentAssessment(prisma, stranger.student, examId, now)) === null);

  const left = await makeStudent(centerId, "left", fx.classGroupId);
  await prisma.enrollment.updateMany({ where: { studentProfileId: left.profile.id }, data: { status: "REMOVED", leftByStudentAt: now } });
  const leftStart = await startAttempt(prisma, left.student, examId, now);
  check("A student who left is refused", !leftStart.ok && leftStart.error === "notEligible", JSON.stringify(leftStart));
  check("…and no longer lists it", !(await listStudentAssessments(prisma, left.student, now)).some((item) => item.id === examId));

  const blocked = await makeStudent(centerId, "blocked", fx.classGroupId);
  await prisma.enrollment.updateMany({ where: { studentProfileId: blocked.profile.id }, data: { status: "BLOCKED" } });
  const blockedStart = await startAttempt(prisma, blocked.student, examId, now);
  check("A blocked student is refused", !blockedStart.ok && blockedStart.error === "notEligible");

  const keeper = await makeStudent(centerId, "keeper", fx.classGroupId);
  const kept = await startAttempt(prisma, keeper.student, examId, now);
  await prisma.enrollment.updateMany({ where: { studentProfileId: keeper.profile.id }, data: { status: "REMOVED" } });
  const keptResume = await startAttempt(prisma, keeper.student, examId, new Date(now.getTime() + MINUTE));
  check("Eligibility is checked at start only: leaving keeps the attempt", kept.ok && keptResume.ok && keptResume.attemptId === kept.attemptId, JSON.stringify(keptResume));

  const other = await makeStudent(centerB, "other-centre");
  const otherStart = await startAttempt(prisma, other.student, examId, now);
  check("Another centre's student is refused", !otherStart.ok && otherStart.error === "notFound", JSON.stringify(otherStart));
  check("…and reads nothing", (await readStudentAssessment(prisma, other.student, examId, now)) === null);
  check("A profile from one centre resolves nothing at another", (await resolveAssessmentStudent(prisma, centerB, enrolled.user.id)) === null);

  const staff = await prisma.membership.findFirstOrThrow({ where: { centerId, role: "RECEPTIONIST" }, select: { userId: true } });
  check("Centre staff have no student identity", (await resolveAssessmentStudent(prisma, centerId, staff.userId)) === null);
  const parent = await prisma.user.create({ data: { firstName: "P", lastName: "parent", email: `${STEM}-parent@kayedu.test`, locale: "en" } });
  check("A parent has no student identity", (await resolveAssessmentStudent(prisma, centerId, parent.id)) === null);
  await prisma.studentProfile.updateMany({ where: { id: stranger.profile.id }, data: { active: false } });
  check("An inactive profile has no student identity", (await resolveAssessmentStudent(prisma, centerId, stranger.user.id)) === null);

  const draft = await createAssessment(prisma, fx.actor, fx.teacher, { type: "EXAM", classGroupId: fx.classGroupId, draft: examDraft({ windowStart: new Date(now.getTime() - HOUR), windowEnd: new Date(now.getTime() + HOUR) }) });
  if (draft.ok) {
    const draftStart = await startAttempt(prisma, enrolled.student, draft.id, now);
    check("A draft cannot be started", !draftStart.ok && draftStart.error === "notFound");
    check("…or read", (await readStudentAssessment(prisma, enrolled.student, draft.id, now)) === null);
  }

  const inactive = await makeClass(centerId, fx.teacher.userId);
  const inactiveFx = { ...fx, classGroupId: inactive.id };
  const inactiveExam = await publishedExam(inactiveFx, now);
  const inactiveStudent = await makeStudent(centerId, "inactive-class", inactive.id);
  const inactiveKeeper = await makeStudent(centerId, "inactive-keeper", inactive.id);
  const startedBefore = await startAttempt(prisma, inactiveKeeper.student, inactiveExam, now);
  await prisma.classGroup.update({ where: { id: inactive.id }, data: { active: false } });
  const inactiveStart = await startAttempt(prisma, inactiveStudent.student, inactiveExam, now);
  check("An inactive class blocks new attempts", !inactiveStart.ok && inactiveStart.error === "notFound", JSON.stringify(inactiveStart));
  check("…and hides the assessment from its students", (await readStudentAssessment(prisma, inactiveStudent.student, inactiveExam, now)) === null && !(await listStudentAssessments(prisma, inactiveKeeper.student, now)).some((item) => item.id === inactiveExam));
  check("…and the teacher keeps it and its attempts", startedBefore.ok && (await findTeacherAssessment(prisma, fx.teacher, inactiveExam))?._count.attempts === 1);

  return { examId, enrolled };
}

async function checkLocking(fx: Fixture, otherTeacher: AssessmentTeacher, examId: string, now: Date) {
  console.log("\n13. Locking after the first attempt, and extending");
  const { centerId } = fx.teacher;
  check("isAssessmentLocked is true once an attempt exists", await isAssessmentLocked(prisma, centerId, examId));
  const del = await deleteAssessment(prisma, fx.actor, fx.teacher, examId);
  check("Delete is refused once an attempt exists", !del.ok && del.error === "locked", JSON.stringify(del));
  const back = await unpublishAssessment(prisma, fx.actor, fx.teacher, examId);
  check("Unpublish is refused once an attempt exists", !back.ok && back.error === "locked", JSON.stringify(back));
  check("…and it stays published", (await prisma.assessment.findUniqueOrThrow({ where: { id: examId } })).status === "PUBLISHED");

  const row = await prisma.assessment.findUniqueOrThrow({ where: { id: examId } });
  const end = row.windowEnd!;
  const shorter = await extendAssessment(prisma, fx.actor, fx.teacher, examId, new Date(end.getTime() - MINUTE), now);
  check("Extend is refused to an earlier time", !shorter.ok && shorter.error === "notLater", JSON.stringify(shorter));
  const same = await extendAssessment(prisma, fx.actor, fx.teacher, examId, end, now);
  check("Extend is refused to the same time", !same.ok && same.error === "notLater");
  const passed = await extendAssessment(prisma, fx.actor, fx.teacher, examId, new Date(end.getTime() + HOUR), new Date(end.getTime() + MINUTE));
  check("Extend is refused once it has passed", !passed.ok && passed.error === "passed", JSON.stringify(passed));
  const foreign = await extendAssessment(prisma, { userId: otherTeacher.userId }, otherTeacher, examId, new Date(end.getTime() + HOUR), now);
  check("Another teacher cannot extend it", !foreign.ok && foreign.error === "notFound");
  const later = new Date(end.getTime() + HOUR);
  const forward = await extendAssessment(prisma, fx.actor, fx.teacher, examId, later, now);
  check("Extend moves the end later", forward.ok && (await prisma.assessment.findUniqueOrThrow({ where: { id: examId } })).windowEnd?.getTime() === later.getTime(), JSON.stringify(forward));
  const stillDraft = await createAssessment(prisma, fx.actor, fx.teacher, { type: "EXAM", classGroupId: fx.classGroupId, draft: examDraft() });
  if (stillDraft.ok) {
    const draftExtend = await extendAssessment(prisma, fx.actor, fx.teacher, stillDraft.id, new Date(now.getTime() + 9 * DAY), now);
    check("A draft cannot be extended", !draftExtend.ok && draftExtend.error === "notPublished");
  }

  // Overdue: a 30-minute attempt started 2 hours ago, in a window still open.
  const overdueExam = await publishedExam(fx, now);
  const overdue = await makeStudent(centerId, "overdue", fx.classGroupId);
  const startedAt = new Date(now.getTime() - 2 * HOUR);
  const started = await startAttempt(prisma, overdue.student, overdueExam, startedAt);
  const overdueQuestions = await optionsOf(overdueExam);
  if (started.ok) await saveAnswer(prisma, overdue.student, started.attemptId, { questionId: overdueQuestions[0].id, optionId: overdueQuestions[0].right }, startedAt);
  const overdueRow = await prisma.assessment.findUniqueOrThrow({ where: { id: overdueExam } });
  const extended = await extendAssessment(prisma, fx.actor, fx.teacher, overdueExam, new Date(overdueRow.windowEnd!.getTime() + 2 * DAY), now);
  const attempt = await prisma.assessmentAttempt.findFirstOrThrow({ where: { assessmentId: overdueExam } });
  check(
    "Extending first finalises an attempt already past its end, at its old end, so it cannot be revived",
    extended.ok && attempt.submittedAt?.getTime() === startedAt.getTime() + 30 * MINUTE && attempt.finalisedBy === "DEADLINE" && attempt.score === 2,
    JSON.stringify(attempt),
  );
  const revived = started.ok ? await saveAnswer(prisma, overdue.student, started.attemptId, { questionId: overdueQuestions[1].id, optionId: overdueQuestions[1].right }, now) : null;
  check("…and an autosave after the extension is refused", revived !== null && !revived.ok && revived.error === "submitted");
  const extendAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "assessment.extend", entityId: overdueExam } });
  check("assessment.extend records the actor, the owning teacher and the count", extendAudit.actorUserId === fx.actor.userId && (extendAudit.after as { teacherMembershipId: string; finalisedAttempts: number }).teacherMembershipId === fx.teacher.membershipId && (extendAudit.after as { finalisedAttempts: number }).finalisedAttempts === 1, JSON.stringify(extendAudit.after));
}

async function checkAutosave(fx: Fixture, now: Date) {
  console.log("\n14. Autosave");
  const { centerId } = fx.teacher;
  const examId = await publishedExam(fx, now);
  const otherExamId = await publishedExam(fx, now);
  const student = await makeStudent(centerId, "autosave", fx.classGroupId);
  const intruder = await makeStudent(centerId, "intruder", fx.classGroupId);
  const started = await startAttempt(prisma, student.student, examId, now);
  if (!started.ok) {
    check("Autosave fixture started", false, JSON.stringify(started));
    return;
  }
  const questions = await optionsOf(examId);
  const otherQuestions = await optionsOf(otherExamId);
  const save = (questionId: string, optionId: string | null, at = now, who = student.student) =>
    saveAnswer(prisma, who, started.attemptId, { questionId, optionId }, at);

  const saved = await save(questions[0].id, questions[0].wrong);
  check("An answer saves", saved.ok && (await prisma.assessmentAnswer.count({ where: { attemptId: started.attemptId } })) === 1, JSON.stringify(saved));
  check("The autosave answer says nothing about correctness", !/correct|score|points/i.test(JSON.stringify(saved)), JSON.stringify(saved));
  const stored = await prisma.assessmentAnswer.findFirstOrThrow({ where: { attemptId: started.attemptId } });
  check("isCorrect and pointsAwarded stay null until finalisation", stored.isCorrect === null && stored.pointsAwarded === null);
  await save(questions[0].id, questions[0].right);
  check("A second save overwrites its own row", (await prisma.assessmentAnswer.findMany({ where: { attemptId: started.attemptId } })).length === 1);
  const cleared = await save(questions[0].id, null);
  check("Null clears the answer", cleared.ok && (await prisma.assessmentAnswer.findFirstOrThrow({ where: { attemptId: started.attemptId } })).optionId === null);
  const crossOption = await save(questions[0].id, questions[1].right);
  check("An option from another question is refused", !crossOption.ok && crossOption.error === "invalidOption", JSON.stringify(crossOption));
  const crossQuestion = await save(otherQuestions[0].id, otherQuestions[0].right);
  check("A question from another assessment is refused", !crossQuestion.ok && crossQuestion.error === "invalidOption", JSON.stringify(crossQuestion));
  const stranger = await save(questions[0].id, questions[0].right, now, intruder.student);
  check("Another student's attempt is not found", !stranger.ok && stranger.error === "notFound", JSON.stringify(stranger));
  const heartbeat = await attemptHeartbeat(prisma, intruder.student, started.attemptId, now);
  check("…for a heartbeat too", !heartbeat.ok && heartbeat.error === "notFound");
  const foreignSubmit = await submitAttempt(prisma, intruder.student, started.attemptId, now);
  check("…and a submit", !foreignSubmit.ok && foreignSubmit.error === "notFound");

  const submitted = await submitAttempt(prisma, student.student, started.attemptId, new Date(now.getTime() + MINUTE));
  check("The student's submit finalises as STUDENT", submitted.ok && submitted.finalisedBy === "STUDENT", JSON.stringify(submitted));
  const final = await save(questions[1].id, questions[1].right, new Date(now.getTime() + 2 * MINUTE));
  check("An autosave on a final attempt is refused with \"submitted\"", !final.ok && final.error === "submitted", JSON.stringify(final));
  const again = await submitAttempt(prisma, student.student, started.attemptId, new Date(now.getTime() + 2 * MINUTE));
  const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  check("A second submit changes nothing", again.ok && row.submittedAt?.getTime() === now.getTime() + MINUTE);
  check("…and one attempt.submit audit row, with the student as actor", (await prisma.auditLog.findMany({ where: { action: "attempt.submit", entityId: started.attemptId } })).every((audit) => audit.actorUserId === student.user.id) && (await prisma.auditLog.count({ where: { action: "attempt.submit", entityId: started.attemptId } })) === 1);

  const dueStudent = await makeStudent(centerId, "autosave-due", fx.classGroupId);
  const dueStart = await startAttempt(prisma, dueStudent.student, examId, now);
  if (dueStart.ok) {
    const late = new Date(now.getTime() + 31 * MINUTE);
    const dueSave = await saveAnswer(prisma, dueStudent.student, dueStart.attemptId, { questionId: questions[0].id, optionId: questions[0].right }, late);
    const dueRow = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: dueStart.attemptId } });
    check("An autosave past the end is refused and finalises the attempt", !dueSave.ok && dueSave.error === "submitted" && dueRow.finalisedBy === "DEADLINE" && dueRow.score === 0, JSON.stringify(dueRow));
  }
}

async function checkLazyFinalisation(fx: Fixture, now: Date) {
  console.log("\n15. Lazy finalisation");
  const { centerId } = fx.teacher;
  const examId = await publishedExam(fx, now);
  const student = await makeStudent(centerId, "lazy", fx.classGroupId);
  const started = await startAttempt(prisma, student.student, examId, now);
  if (!started.ok) {
    check("Lazy fixture started", false);
    return;
  }
  const questions = await optionsOf(examId);
  await saveAnswer(prisma, student.student, started.attemptId, { questionId: questions[0].id, optionId: questions[0].right }, now);
  await saveAnswer(prisma, student.student, started.attemptId, { questionId: questions[1].id, optionId: questions[1].wrong }, now);

  check("Before its end nothing happens", (await finaliseIfDue(prisma, centerId, started.attemptId, new Date(now.getTime() + 29 * MINUTE))) === false);
  const read = new Date(now.getTime() + 2 * HOUR);
  const [a, b] = await Promise.all([
    finaliseIfDue(prisma, centerId, started.attemptId, read),
    finaliseIfDue(prisma, centerId, started.attemptId, read),
  ]);
  check("Two concurrent calls: exactly one finalises", [a, b].filter(Boolean).length === 1, JSON.stringify([a, b]));
  const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  check("Grades the saved answers; unanswered scores 0", row.score === 2 && row.maxScore === 10, JSON.stringify(row));
  check("Time taken is capped: stamped at the end, not the read", row.submittedAt?.getTime() === now.getTime() + 30 * MINUTE && row.finalisedBy === "DEADLINE");
  const answers = await prisma.assessmentAnswer.findMany({ where: { attemptId: started.attemptId } });
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  check(
    "isCorrect and pointsAwarded freeze per answer, the unanswered one included",
    answers.length === 3 &&
      byQuestion.get(questions[0].id)?.isCorrect === true && byQuestion.get(questions[0].id)?.pointsAwarded === 2 &&
      byQuestion.get(questions[1].id)?.isCorrect === false && byQuestion.get(questions[1].id)?.pointsAwarded === 0 &&
      byQuestion.get(questions[2].id)?.optionId === null && byQuestion.get(questions[2].id)?.pointsAwarded === 0,
    JSON.stringify(answers),
  );
  const audits = await prisma.auditLog.findMany({ where: { action: "attempt.submit", entityId: started.attemptId } });
  check("One audit row, with no invented actor", audits.length === 1 && audits[0].actorUserId === null && (audits[0].after as { finalisedBy: string }).finalisedBy === "DEADLINE", JSON.stringify(audits));
  check("Idempotent afterwards", (await finaliseIfDue(prisma, centerId, started.attemptId, new Date(read.getTime() + HOUR))) === false);

  // Frozen: the questions are locked and the score is never recomputed.
  const refused = await saveAssessmentDraft(prisma, fx.actor, fx.teacher, examId, examDraft());
  check("The questions can't change after attempts", !refused.ok);
  await prisma.assessmentOption.updateMany({ where: { id: questions[0].right }, data: { isCorrect: false } });
  await finaliseIfDue(prisma, centerId, started.attemptId, new Date(read.getTime() + 2 * HOUR));
  const frozen = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  check("A frozen score does not move even if a correct mark did", frozen.score === 2 && frozen.maxScore === 10);
  await prisma.assessmentOption.updateMany({ where: { id: questions[0].right }, data: { isCorrect: true } });

  // Every read that touches attempts finalises: the list, and the page.
  const listStudent = await makeStudent(centerId, "lazy-list", fx.classGroupId);
  const listStart = await startAttempt(prisma, listStudent.student, examId, now);
  const listed = await listStudentAssessments(prisma, listStudent.student, read);
  check("The student's list finalises what is due, and reads it as submitted", listStart.ok && listed.find((item) => item.id === examId)?.state === "SUBMITTED", JSON.stringify(listed.map((item) => item.state)));
  const pageStudent = await makeStudent(centerId, "lazy-page", fx.classGroupId);
  await startAttempt(prisma, pageStudent.student, examId, now);
  const page = await readStudentAssessment(prisma, pageStudent.student, examId, read);
  check("The assessment page finalises too", page?.state === "SUBMITTED" && page.finished?.finalisedBy === "DEADLINE" && page.taking === null, JSON.stringify(page?.state));
}

async function checkOneSitting(fx: Fixture, now: Date) {
  console.log("\n16. One sitting");
  const { centerId } = fx.teacher;
  const examId = await publishedExam(fx, now, { oneSitting: true });
  const defaultExam = await publishedExam(fx, now);
  const student = await makeStudent(centerId, "sitting", fx.classGroupId);
  const started = await startAttempt(prisma, student.student, examId, now);
  if (!started.ok) {
    check("One-sitting fixture started", false);
    return;
  }
  const inGrace = new Date(now.getTime() + 60_000);
  const beat = await attemptHeartbeat(prisma, student.student, started.attemptId, inGrace);
  check("A heartbeat within the grace keeps it open and answers the clock", beat.ok && beat.endsAtMs === now.getTime() + 30 * MINUTE && beat.serverNowMs === inGrace.getTime(), JSON.stringify(beat));
  check("…and refreshes lastSeenAt", (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } })).lastSeenAt.getTime() === inGrace.getTime());
  const rejoin = await startAttempt(prisma, student.student, examId, new Date(inGrace.getTime() + 100_000));
  check("Re-entry within the grace resumes", rejoin.ok && rejoin.resumed);

  const seen = new Date(inGrace.getTime() + 100_000);
  const gapRead = new Date(seen.getTime() + 121_000);
  const gone = await attemptHeartbeat(prisma, student.student, started.attemptId, gapRead);
  const row = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  check("The next request past the grace is refused", !gone.ok && gone.error === "submitted", JSON.stringify(gone));
  check("…finalised at lastSeenAt as ONE_SITTING_GAP", row.finalisedBy === "ONE_SITTING_GAP" && row.submittedAt?.getTime() === seen.getTime(), JSON.stringify(row));
  const back = await startAttempt(prisma, student.student, examId, new Date(gapRead.getTime() + MINUTE));
  check("…and the server never reopens it", !back.ok && back.error === "submitted", JSON.stringify(back));

  const closer = await makeStudent(centerId, "closer", fx.classGroupId);
  const closeStart = await startAttempt(prisma, closer.student, examId, now);
  if (closeStart.ok) {
    const closed = await submitAttempt(prisma, closer.student, closeStart.attemptId, new Date(now.getTime() + MINUTE), { onlyOneSitting: true });
    check("The close signal submits a one-sitting exam as STUDENT", closed.ok && closed.finalisedBy === "STUDENT");
  }
  const defaultStudent = await makeStudent(centerId, "default-close", fx.classGroupId);
  const defaultStart = await startAttempt(prisma, defaultStudent.student, defaultExam, now);
  if (defaultStart.ok) {
    const closed = await submitAttempt(prisma, defaultStudent.student, defaultStart.attemptId, new Date(now.getTime() + MINUTE), { onlyOneSitting: true });
    const stillOpen = await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: defaultStart.attemptId } });
    check("The close signal does nothing to a default exam, which allows re-entry", !closed.ok && closed.error === "notOneSitting" && stillOpen.submittedAt === null);
    const longGap = await startAttempt(prisma, defaultStudent.student, defaultExam, new Date(now.getTime() + 10 * MINUTE));
    check("A default exam ignores a long gap and resumes", longGap.ok && longGap.resumed);
  }
}

async function checkRevealAndPayloads(fx: Fixture, now: Date) {
  console.log("\n17. Reveal, score and the student payloads (rule 11)");
  const { centerId } = fx.teacher;
  const closes = new Date(now.getTime() + 3 * HOUR);
  const afterClose = new Date(closes.getTime() + MINUTE);
  const noLeak = (value: unknown) => !/isCorrect|correctOptionId|pointsAwarded/.test(JSON.stringify(value));

  const showing = await publishedExam(fx, now, { showScore: true, showCorrectAnswers: true });
  const student = await makeStudent(centerId, "reveal", fx.classGroupId);

  const beforeStart = await readStudentAssessment(prisma, student.student, showing, now);
  const questionText = (await prisma.assessmentQuestion.findFirstOrThrow({ where: { assessmentId: showing } })).text;
  check("Before start the page read carries no question", beforeStart?.taking === null && !JSON.stringify(beforeStart).includes(questionText) && beforeStart?.canStart === true);

  const started = await startAttempt(prisma, student.student, showing, now);
  if (!started.ok) {
    check("Reveal fixture started", false);
    return;
  }
  const questions = await optionsOf(showing);
  const saved = await saveAnswer(prisma, student.student, started.attemptId, { questionId: questions[0].id, optionId: questions[0].right }, now);
  const take = await readStudentAssessment(prisma, student.student, showing, now);
  const allOptionIds = take?.taking?.questions.flatMap((q) => q.options.map((o) => o.id)) ?? [];
  check("The taking payload has its questions and options", take?.taking?.questions.length === 3 && allOptionIds.length === 12);
  check("The taking payload never contains isCorrect or a correct option id", noLeak(take), JSON.stringify(take?.taking).slice(0, 300));
  check("Its option objects carry only id and text", take?.taking?.questions.every((q) => q.options.every((o) => Object.keys(o).sort().join() === "id,text")) === true);
  check("It names the saved option, and nothing about it", take?.taking?.answers[questions[0].id] === questions[0].right);
  check("The autosave answer never contains isCorrect", noLeak(saved));
  check("The heartbeat answer never contains isCorrect", noLeak(await attemptHeartbeat(prisma, student.student, started.attemptId, now)));
  check("The list never contains isCorrect", noLeak(await listStudentAssessments(prisma, student.student, now)));

  const inProgressReveal = await readAttemptReveal(prisma, student.student, started.attemptId, now);
  check("Reveal is refused while in progress", inProgressReveal === null);
  await submitAttempt(prisma, student.student, started.attemptId, new Date(now.getTime() + MINUTE));
  const submittedView = await readStudentAssessment(prisma, student.student, showing, new Date(now.getTime() + 2 * MINUTE));
  check("After submit, showScore on: the score and percentage show", submittedView?.finished?.score?.score === 2 && submittedView.finished.score.maxScore === 10 && submittedView.finished.score.percentage === 20, JSON.stringify(submittedView?.finished));
  check("…and the state is Submitted", submittedView?.state === "SUBMITTED");
  check("After submit, before close: still no correctness", noLeak(submittedView));
  check("Reveal is refused before it closes", (await readAttemptReveal(prisma, student.student, started.attemptId, new Date(now.getTime() + 2 * MINUTE))) === null);

  const revealed = await readAttemptReveal(prisma, student.student, started.attemptId, afterClose);
  const first = revealed?.find((row) => row.id === questions[0].id);
  check(
    "After close, with showCorrectAnswers on: isCorrect and the correct option",
    first?.isCorrect === true && first.correctOptionId === questions[0].right && first.chosenOptionId === questions[0].right && first.pointsAwarded === 2 && revealed?.length === 3,
    JSON.stringify(first),
  );
  const unanswered = revealed?.find((row) => row.id === questions[1].id);
  check("An unanswered question reveals as not correct, with its correct option", unanswered?.isCorrect === false && unanswered.chosenOptionId === null && unanswered.correctOptionId === questions[1].right);
  check("The state after close is Closed", (await readStudentAssessment(prisma, student.student, showing, afterClose))?.state === "CLOSED");

  const intruder = await makeStudent(centerId, "reveal-intruder", fx.classGroupId);
  check("Another student's attempt reveals nothing", (await readAttemptReveal(prisma, intruder.student, started.attemptId, afterClose)) === null);

  const extendTo = new Date(afterClose.getTime() + HOUR);
  await extendAssessment(prisma, fx.actor, fx.teacher, showing, extendTo, now);
  check("An extension moves the reveal", (await readAttemptReveal(prisma, student.student, started.attemptId, afterClose)) === null && (await readAttemptReveal(prisma, student.student, started.attemptId, new Date(extendTo.getTime() + MINUTE))) !== null);

  const hidden = await publishedExam(fx, now, { showScore: false, showCorrectAnswers: false });
  const hiddenStudent = await makeStudent(centerId, "reveal-hidden", fx.classGroupId);
  const hiddenStart = await startAttempt(prisma, hiddenStudent.student, hidden, now);
  if (hiddenStart.ok) {
    await submitAttempt(prisma, hiddenStudent.student, hiddenStart.attemptId, new Date(now.getTime() + MINUTE));
    const hiddenView = await readStudentAssessment(prisma, hiddenStudent.student, hidden, afterClose);
    check("showScore off: no score in the page read", hiddenView?.finished !== null && hiddenView?.finished?.score === null, JSON.stringify(hiddenView?.finished));
    check("showScore off: no score in the list", (await listStudentAssessments(prisma, hiddenStudent.student, afterClose)).find((item) => item.id === hidden)?.score === null);
    check("showCorrectAnswers off: no reveal even after close", (await readAttemptReveal(prisma, hiddenStudent.student, hiddenStart.attemptId, afterClose)) === null);
  }

  // The order the page uses: stable per attempt, different between attempts.
  const many = Array.from({ length: 8 }, () => question());
  const shuffled = await publishedExam(fx, now, { shuffle: true, questions: many });
  const a = await makeStudent(centerId, "shuffle-a", fx.classGroupId);
  const b = await makeStudent(centerId, "shuffle-b", fx.classGroupId);
  await startAttempt(prisma, a.student, shuffled, now);
  await startAttempt(prisma, b.student, shuffled, now);
  const order = (view: StudentAssessmentView | null) => JSON.stringify(view?.taking?.questions.map((q) => [q.id, q.options.map((o) => o.id)]));
  const firstRead = order(await readStudentAssessment(prisma, a.student, shuffled, now));
  const secondRead = order(await readStudentAssessment(prisma, a.student, shuffled, new Date(now.getTime() + MINUTE)));
  check("The shuffled order survives a refresh", firstRead === secondRead && firstRead !== undefined);
  check("…and differs between attempts", firstRead !== order(await readStudentAssessment(prisma, b.student, shuffled, now)));
  const plain = await publishedExam(fx, now, { shuffle: false, questions: many });
  await startAttempt(prisma, a.student, plain, now);
  const stored = await optionsOf(plain);
  const plainView = await readStudentAssessment(prisma, a.student, plain, now);
  check("With shuffle off the stored order stands", plainView?.taking?.questions.map((q) => q.id).join() === stored.map((q) => q.id).join());
}

async function checkHomework(fx: Fixture, now: Date) {
  console.log("\n18. Homework, and the class engine (OD-18 → D-W31)");
  const { centerId } = fx.teacher;
  const session = await makeSession(centerId, fx.classGroupId, fx.teacher.userId, 45, "09:00");
  const deadline = new Date(now.getTime() + 2 * DAY);
  const created = await createAssessment(prisma, fx.actor, fx.teacher, { type: "HOMEWORK", sessionId: session.id, draft: homeworkDraft(deadline) });
  if (!created.ok) {
    check("Homework fixture created", false, JSON.stringify(created));
    return;
  }

  // A draft is enough: any assessment makes its session non-pristine.
  const state = await prisma.session.findUniqueOrThrow({ where: { id: session.id }, select: { isManual: true, status: true, closedAt: true, teacherId: true, centerShareType: true, centerShareValue: true, description: true, rescheduledToId: true, rescheduledFrom: { select: { id: true } }, _count: { select: { attendees: true, payments: true, settlements: true, ratings: true, assessments: true } } } });
  check("A draft homework makes its session non-pristine, reason `assessments`", sessionDisqualifiers(state, [], { teacherId: fx.teacher.userId, roomIds: [] }).includes("assessments"));
  await prisma.session.update({ where: { id: session.id }, data: { isManual: true } });
  const sessionDelete = await deleteManualSession(prisma, centerId, session.id, { now });
  check("Deleting that session by direct call is refused", !sessionDelete.ok && sessionDelete.error === "sessionInUse" && sessionDelete.blockers.includes("assessments") && (await prisma.session.count({ where: { id: session.id } })) === 1, JSON.stringify(sessionDelete));
  await prisma.session.update({ where: { id: session.id }, data: { isManual: false } });

  const classDelete = await deleteClass(prisma, centerId, fx.classGroupId, { now });
  check("Deleting the class by direct call is refused", !classDelete.ok && classDelete.error === "classInUse" && classDelete.blockers.assessments > 0 && (await prisma.classGroup.count({ where: { id: fx.classGroupId } })) === 1, JSON.stringify(classDelete));

  const published = await publishAssessment(prisma, fx.actor, fx.teacher, created.id, now);
  check("A homework with a future deadline publishes", published.ok, JSON.stringify(published));
  const student = await makeStudent(centerId, "homework", fx.classGroupId);
  const started = await startAttempt(prisma, student.student, created.id, now);
  const view = await readStudentAssessment(prisma, student.student, created.id, now);
  check("An untimed homework ends at its deadline", started.ok && view?.taking?.clock.endsAtMs === deadline.getTime());
  const reentry = await startAttempt(prisma, student.student, created.id, new Date(now.getTime() + DAY));
  check("Homework allows re-entry after a long gap", reentry.ok && reentry.resumed);
  const late = await makeStudent(centerId, "homework-late", fx.classGroupId);
  const lateStart = await startAttempt(prisma, late.student, created.id, new Date(deadline.getTime() + MINUTE));
  check("Start is refused after the deadline", !lateStart.ok && lateStart.error === "closed");

  const cancelled = await cancelSession(prisma, centerId, session.id, { now });
  check(
    "Cancelling the session does not touch its homework",
    cancelled.ok && (await prisma.assessment.findUniqueOrThrow({ where: { id: created.id } })).status === "PUBLISHED",
    JSON.stringify(cancelled),
  );
  const afterCancel = await startAttempt(prisma, late.student, created.id, now);
  check("…students can still start it", afterCancel.ok);
}

async function checkAttemptAudit(centerId: string) {
  console.log("\n19. Audit rows: ids only");
  const rows = await prisma.auditLog.findMany({
    where: { centerId, action: { in: ["assessment.publish", "assessment.unpublish", "assessment.extend", "attempt.start", "attempt.submit"] } },
  });
  const actions = new Set(rows.map((row) => row.action));
  check("Every new action wrote rows", ["assessment.publish", "assessment.unpublish", "assessment.extend", "attempt.start", "attempt.submit"].every((action) => actions.has(action)), [...actions].join(", "));
  check(`No row carries a name, contact or free text (${rows.length} rows)`, rows.every((row) => forbiddenAuditKey(row.before) === null && forbiddenAuditKey(row.after) === null));
  const start = rows.find((row) => row.action === "attempt.start");
  check("attempt.start names only ids", start !== undefined && Object.keys(start.after as object).sort().join() === "assessmentId,studentProfileId", JSON.stringify(start?.after));
  const feed = await loadAuditFeed(prisma, centerId, "all", { take: 200, skip: 0 });
  check("The centre's audit trail shows none of it (D-W11)", !feed.entries.some((entry) => entry.entityType === "Assessment" || entry.entityType === "AssessmentAttempt"));
}

async function checkAttemptTablesAndStatics() {
  console.log("\n20. RLS and statics (W3a)");
  const tables = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('AssessmentAttempt', 'AssessmentAnswer')`;
  const policies = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('AssessmentAttempt', 'AssessmentAnswer')`;
  check("RLS is on for AssessmentAttempt and AssessmentAnswer", tables.length === 2 && tables.every((t) => t.relrowsecurity), JSON.stringify(tables));
  check("…with zero policies", Number(policies[0]?.count ?? -1) === 0);

  const attempts = readSource(join(ROOT, "lib/db/assessment-attempts.ts"));
  // Code only: no comments, and not the reveal's own result type.
  const attemptsCode = attempts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^export type RevealedQuestion = \{[\s\S]*?^\};$/m, "");
  const readers = functionBodies(attemptsCode).filter((fn) => /isCorrect/.test(fn.body)).map((fn) => fn.name).sort();
  check("Only finaliseAttemptTx and revealOf name isCorrect in the attempts module", readers.join() === "finaliseAttemptTx,revealOf", readers.join());
  check("revealOf is called only behind revealAllowed", /revealAllowed\([\s\S]*?\)\) return null;\s*return revealOf\(/.test(attempts) && (attempts.match(/revealOf\(/g) ?? []).length === 2);

  const studentDir = join(ROOT, "app/[locale]/(student)/student/assessments");
  const taker = readSource(join(studentDir, "taker.tsx"));
  const actions = readSource(join(studentDir, "actions.ts"));
  check("The taking screen and the student actions never name isCorrect", !/isCorrect/.test(taker) && !/isCorrect/.test(actions) && !/isCorrect/.test(readSource(join(studentDir, "start-attempt.tsx"))));
  check("Only the student page's reveal branch reads correctness", (readSource(join(studentDir, "[id]/page.tsx")).match(/readAttemptReveal\(/g) ?? []).length === 1);
  const studentActions = functionBodies(actions).filter((fn) => /Action$/.test(fn.name));
  check(
    `Every student action resolves the person's own profiles (${studentActions.map((fn) => fn.name).join(", ")})`,
    studentActions.length === 4 && studentActions.every((fn) => /getCurrentUser\(\)/.test(fn.body) && /studentBranches\(user\.id\)/.test(fn.body)),
  );
  check("No student action takes a centre, profile or time from the client", !/centerId|studentProfileId|startedAt|parsed\.data\.now/.test(actions));
  check("Autosave and start use the rate limiter", /withinLimit\(user\.id\)/.test(functionBodies(actions).find((fn) => fn.name === "saveAnswerAction")?.body ?? "") && /withinLimit\(user\.id\)/.test(functionBodies(actions).find((fn) => fn.name === "startAttemptAction")?.body ?? ""));

  const publishActions = functionBodies(readSource(join(ROOT, "app/[locale]/(teacher)/teacher/assessments/publish-actions.ts"))).filter((fn) => /Action$/.test(fn.name));
  check(
    `Every publish action re-resolves the branch, then the owning teacher (${publishActions.map((fn) => fn.name).join(", ")})`,
    publishActions.length === 3 && publishActions.every((fn) => fn.body.indexOf("teacherBranchContext(") > -1 && fn.body.indexOf("resolveAssessmentTeacher(") > fn.body.indexOf("teacherBranchContext(")),
  );

  const groups = ["(center)", "(parent)", "(admin)"];
  const offenders = groups.flatMap((group) => walk(join(ROOT, "app", "[locale]", group)).filter((file) => /assessment-attempts|student\/assessments/.test(readSource(file))));
  check("No centre, parent or admin file reaches the attempts module (D-W11)", offenders.length === 0, offenders.map((f) => relative(ROOT, f)).join(", "));

  const route = readSource(join(ROOT, "app/api/assessment-attempts/[attemptId]/close/route.ts"));
  check("The close route checks the origin and submits only the signed-in student's own one-sitting attempt", /request\.headers\.get\("origin"\)/.test(route) && /studentBranches\(user\.id\)/.test(route) && /onlyOneSitting: true/.test(route) && !/export (async )?function GET/.test(route));
  const vercel = readSource(join(ROOT, "vercel.json"));
  check("No cron exists for assessments (D-W10, rule 12)", !/assessment|attempt/i.test(vercel));
  const routes = walk(join(ROOT, "app", "api")).filter((file) => /assessment|attempt/i.test(relative(ROOT, file)));
  check("The close route is the only assessment route handler", routes.length === 1, routes.map((f) => relative(ROOT, f)).join(", "));
  check("One grace constant: it is named once, in lib/assessments.ts", walk(join(ROOT, "lib")).concat(walk(join(ROOT, "app"))).filter((file) => /ONE_SITTING_GRACE_SECONDS\s*=/.test(readSource(file))).length === 1);
}

// ── 21–23. The calendar and the notices (W3b, D-W32) ────────────────────────

function checkCalendarRules() {
  console.log("\n21. Where an assessment sits on the calendar (pure)");
  const november = { start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-11-30T00:00:00.000Z") };
  const december = { start: new Date("2026-12-01T00:00:00.000Z"), end: new Date("2026-12-31T00:00:00.000Z") };
  const lateUtc = new Date("2026-11-30T22:30:00.000Z");
  const exam = { type: "EXAM" as const, windowStart: lateUtc, deadline: null };
  const homework = { type: "HOMEWORK" as const, windowStart: null, deadline: lateUtc };
  const cairo = assessmentOnCalendar(exam, "Africa/Cairo", december);
  check("An exam sits on the day of windowStart in its zone (Cairo: the next day)", cairo?.day === "2026-12-01" && cairo.startTime === "00:30", JSON.stringify(cairo));
  check("The same instant is outside November in Cairo", assessmentOnCalendar(exam, "Africa/Cairo", november) === null);
  check("In UTC it is still November", assessmentOnCalendar(exam, "UTC", november)?.day === "2026-11-30");
  check("A homework sits on the day of its deadline", assessmentOnCalendar(homework, "Africa/Cairo", december)?.day === "2026-12-01");
  check("A draft exam with no window has no day", assessmentOnCalendar({ type: "EXAM", windowStart: null, deadline: null }, "Africa/Cairo", november) === null);
  check("An exam ignores a deadline", assessmentOnCalendar({ type: "EXAM", windowStart: null, deadline: lateUtc }, "UTC", november) === null);
  const window = assessmentCalendarWindow(november);
  check(
    "The read reaches past the month, so no zone loses a row",
    window.from.getTime() < november.start.getTime() && window.to.getTime() > november.end.getTime() + 86_400_000,
  );
  check("The parent's tones hold neither", !STUDENT_CALENDAR_TONES.includes("exam") && !STUDENT_CALENDAR_TONES.includes("homework"));
  check("The legend has an entry for each", ASSESSMENT_CALENDAR_TONES.join() === "exam,homework");
  for (const locale of ["en", "ar"]) {
    const tone = (JSON.parse(readSource(`${ROOT}/messages/${locale}.json`)) as { Calendar: { tone: Record<string, string> } }).Calendar.tone;
    check(`${locale}: the legend names Exam and Homework`, Boolean(tone.exam) && Boolean(tone.homework));
  }
}

async function checkCalendarReads(fx: Fixture, otherTeacher: AssessmentTeacher, now: Date) {
  console.log("\n22. The calendar's reads");
  const { centerId } = fx.teacher;
  const classId = (await makeClass(centerId, fx.teacher.userId)).id;
  const local: Fixture = { ...fx, classGroupId: classId };
  const student = await makeStudent(centerId, "cal", classId);
  const stranger = await makeStudent(centerId, "cal-stranger");
  const leftWithout = await makeStudent(centerId, "cal-left", classId);
  const leftWith = await makeStudent(centerId, "cal-left-att", classId);

  const inRange = await publishedExam(local, now);
  const started = await startAttempt(prisma, leftWith.student, inRange, now);
  if (!started.ok) throw new Error(`fixture start: ${JSON.stringify(started)}`);
  for (const row of [leftWithout, leftWith]) {
    await prisma.enrollment.updateMany({ where: { studentProfileId: row.profile.id, classGroupId: classId }, data: { status: "REMOVED" } });
  }
  const future = new Date(now.getTime() + 60 * DAY);
  const outOfRange = await publishedExam(local, now, { windowStart: future, windowEnd: new Date(future.getTime() + 3 * HOUR) });

  const session = await makeSession(centerId, classId, fx.teacher.userId, 1, "10:00", { timezone: "Asia/Dubai" });
  const homeworkCreated = await createAssessment(prisma, fx.actor, fx.teacher, {
    type: "HOMEWORK",
    sessionId: session.id,
    draft: homeworkDraft(new Date(now.getTime() + 2 * DAY), { questions: scoredQuestions() }),
  });
  if (!homeworkCreated.ok) throw new Error(`fixture homework: ${JSON.stringify(homeworkCreated)}`);
  await publishAssessment(prisma, fx.actor, fx.teacher, homeworkCreated.id, now);
  const draftCreated = await createAssessment(prisma, fx.actor, fx.teacher, {
    type: "EXAM",
    classGroupId: classId,
    draft: examDraft({ windowStart: new Date(now.getTime() + DAY), windowEnd: new Date(now.getTime() + DAY + 3 * HOUR), durationMinutes: 30, questions: scoredQuestions() }),
  });
  if (!draftCreated.ok) throw new Error(`fixture draft: ${JSON.stringify(draftCreated)}`);

  const within = { from: new Date(now.getTime() - 5 * DAY), to: new Date(now.getTime() + 10 * DAY) };
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const shown = await listStudentAssessments(prisma, student.student, now, { within });
  check("The student sees the exam and the homework inside the range", ids(shown).includes(inRange) && ids(shown).includes(homeworkCreated.id), JSON.stringify(ids(shown)));
  check("One outside the range is left out", !ids(shown).includes(outOfRange));
  check("The range changes nothing else: the unfiltered list still has it", ids(await listStudentAssessments(prisma, student.student, now)).includes(outOfRange));
  check("A draft never reaches a student", !ids(shown).includes(draftCreated.id));
  check("A homework carries its session's frozen timezone", shown.find((item) => item.id === homeworkCreated.id)?.timeZone === "Asia/Dubai");
  check("An exam with no session has none, so the branch's is used", shown.find((item) => item.id === inRange)?.timeZone === null);
  check("The state comes from the list's own rule", shown.find((item) => item.id === inRange)?.state === "OPEN");
  check("A student not enrolled sees nothing", (await listStudentAssessments(prisma, stranger.student, now, { within })).length === 0);
  check("A student who left with no attempt sees nothing", (await listStudentAssessments(prisma, leftWithout.student, now, { within })).length === 0);
  check("A student who left with an attempt keeps theirs", ids(await listStudentAssessments(prisma, leftWith.student, now, { within })).includes(inRange));
  const payload = JSON.stringify(shown);
  check("The calendar's read carries no correct answer (rule 11)", !payload.includes("isCorrect") && !payload.includes("questions"));

  const closedExam = await publishedExam(local, now, { windowStart: new Date(now.getTime() - 3 * HOUR), windowEnd: new Date(now.getTime() + HOUR) });
  const afterClose = new Date(now.getTime() + 2 * HOUR);
  check("A closed one stays on its day, as Missed", (await listStudentAssessments(prisma, student.student, afterClose, { within })).find((item) => item.id === closedExam)?.state === "MISSED");

  const teacherRows = await listTeacherAssessments(prisma, fx.teacher, { within });
  check("The teacher sees their own rows in the range, drafts included", ids(teacherRows).includes(draftCreated.id) && ids(teacherRows).includes(inRange) && ids(teacherRows).includes(homeworkCreated.id));
  check("Their rows outside the range are left out", !ids(teacherRows).includes(outOfRange));
  check("Another teacher sees none of them", (await listTeacherAssessments(prisma, otherTeacher, { within })).every((row) => !ids(teacherRows).includes(row.id)));

  const timedClass = (await makeClass(centerId, fx.teacher.userId)).id;
  const a = await makeStudent(centerId, "cnt-a", timedClass);
  const b = await makeStudent(centerId, "cnt-b", timedClass);
  const c = await makeStudent(centerId, "cnt-c", timedClass);
  await makeStudent(centerId, "cnt-none", timedClass);
  const countedExam = await publishedExam({ ...fx, classGroupId: timedClass }, now);
  const startedA = await startAttempt(prisma, a.student, countedExam, now);
  const startedB = await startAttempt(prisma, b.student, countedExam, now);
  const startedC = await startAttempt(prisma, c.student, countedExam, new Date(now.getTime() - HOUR));
  if (!startedA.ok || !startedB.ok || !startedC.ok) throw new Error("fixture counts");
  await submitAttempt(prisma, a.student, startedA.attemptId, now);
  const counts = await assessmentAttemptCounts(prisma, fx.teacher, [countedExam], now);
  check("Started counts every attempt; submitted counts the final and the overdue", counts.get(countedExam)?.started === 3 && counts.get(countedExam)?.submitted === 2, JSON.stringify(counts.get(countedExam)));
  check(
    "Reading them finalised the overdue attempt (D-W10), and left the open one open",
    (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: startedC.attemptId } })).submittedAt !== null &&
      (await prisma.assessmentAttempt.findUniqueOrThrow({ where: { id: startedB.attemptId } })).submittedAt === null,
  );
  check("Another teacher reads no counts", (await assessmentAttemptCounts(prisma, otherTeacher, [countedExam], now)).size === 0);
  check("No ids, no read", (await assessmentAttemptCounts(prisma, fx.teacher, [], now)).size === 0);
}

async function checkNoticesFromWriters(fx: Fixture, now: Date) {
  console.log("\n23. Publish, extend and delete write their notices");
  const classId = (await makeClass(fx.teacher.centerId, fx.teacher.userId)).id;
  const local: Fixture = { ...fx, classGroupId: classId };
  const student = await makeStudent(fx.teacher.centerId, "ntc", classId);
  const prefix = (id: string) => ({ userId: student.user.id, dedupeKey: { startsWith: `assessment:${id}:` } });
  const id = await publishedExam(local, now);
  check("Publishing notified the enrolled student", (await prisma.notification.count({ where: prefix(id) })) === 1);
  const newEnd = new Date(now.getTime() + 5 * HOUR);
  await extendAssessment(prisma, fx.actor, fx.teacher, id, newEnd, now);
  check("Extending notified them too", (await prisma.notification.count({ where: { ...prefix(id), kind: "ASSESSMENT_EXTENDED" } })) === 1);
  await unpublishAssessment(prisma, fx.actor, fx.teacher, id);
  check("Unpublishing deletes nothing", (await prisma.notification.count({ where: prefix(id) })) === 2);
  const removed = await deleteAssessment(prisma, fx.actor, fx.teacher, id);
  check("Deleting it succeeds and leaves no notice row", removed.ok && (await prisma.notification.count({ where: { dedupeKey: { startsWith: `assessment:${id}:` } } })) === 0);

  const pageSource = (path: string) => readSource(`${ROOT}/${path}`);
  const studentCalendar = pageSource("app/[locale]/(student)/student/calendar/page.tsx");
  const teacherCalendar = pageSource("app/[locale]/(teacher)/teacher/calendar/page.tsx");
  const parentCalendar = pageSource("app/[locale]/(parent)/parent/calendar/page.tsx");
  check("The student calendar reuses the assessment list's read", /listStudentAssessments\(/.test(studentCalendar) && !/prisma\.assessment/.test(studentCalendar));
  check("The teacher calendar reuses the list's read", /listTeacherAssessments\(/.test(teacherCalendar) && !/prisma\.assessment/.test(teacherCalendar));
  check("The teacher calendar keeps the history floor for them", /assessmentCalendarWindow\(\{ start: from, end: to \}\)/.test(teacherCalendar));
  check("The parent's calendar is untouched: no assessment read, no assessment tone", !/assessment/i.test(parentCalendar));
  check("One shared calendar component", /<SessionCalendar/.test(studentCalendar) && /<SessionCalendar/.test(teacherCalendar) && /<SessionCalendar/.test(parentCalendar));
}

async function checkTaking(ids: { fx: Fixture; otherTeacher: AssessmentTeacher; centerB: string }) {
  const { fx, otherTeacher, centerB } = ids;
  const inactive = await makeClass(fx.teacher.centerId, fx.teacher.userId);
  await prisma.classGroup.update({ where: { id: inactive.id }, data: { active: false } });
  await checkPublishRules(fx, otherTeacher, inactive.id);
  const now = new Date();
  const started = await checkStartAndEligibility(fx, centerB, now);
  await checkLocking(fx, otherTeacher, started.examId, now);
  await checkAutosave(fx, now);
  await checkLazyFinalisation(fx, now);
  await checkOneSitting(fx, now);
  await checkRevealAndPayloads(fx, now);
  await checkHomework(fx, now);
  await checkAttemptAudit(fx.teacher.centerId);
  await checkCalendarReads(fx, otherTeacher, now);
  await checkNoticesFromWriters(fx, now);
}

async function main() {
  await cleanup();
  checkDefaults();
  checkLimits();
  checkTimeRules();
  checkCloseRouteOrigin();
  checkCalendarRules();

  const centerA = await makeCenter(SLUG_A);
  const centerB = await makeCenter(SLUG_B);
  const teacherA = await makeMember(centerA.id, "teacher-a", "TEACHER");
  const teacherA2 = await makeMember(centerA.id, "teacher-a2", "TEACHER");
  const teacherB = await makeMember(centerB.id, "teacher-b", "TEACHER");
  const owner = await makeMember(centerA.id, "owner", "OWNER");
  const manager = await makeMember(centerA.id, "manager", "MANAGER");
  const receptionist = await makeMember(centerA.id, "receptionist", "RECEPTIONIST");
  const accountant = await makeMember(centerA.id, "accountant", "ACCOUNTANT");

  await checkDeadline(centerA.id, teacherA.user.id);
  const constraintClass = await makeClass(centerA.id, teacherA.user.id);
  await checkDatabaseConstraints(centerA.id, teacherA.membership.id, constraintClass.id, teacherA.user.id);

  const who = await checkWhoCan({
    centerA: centerA.id,
    centerB: centerB.id,
    teacherA: { userId: teacherA.user.id, membershipId: teacherA.membership.id },
    teacherA2: { userId: teacherA2.user.id, membershipId: teacherA2.membership.id },
    teacherB: { userId: teacherB.user.id, membershipId: teacherB.membership.id },
    ownerUserId: owner.user.id,
    staffUserIds: { MANAGER: manager.user.id, RECEPTIONIST: receptionist.user.id, ACCOUNTANT: accountant.user.id },
  });
  if (who) {
    await checkSerializer(who.teacher, who.examId, who.actor);
    await checkLock(who.teacher, who.examId);
    await checkAudit(who.teacher, who.actor, constraintClass.id);
    await checkTaking({
      fx: { teacher: who.teacher, actor: who.actor, classGroupId: (await makeClass(centerA.id, teacherA.user.id)).id },
      otherTeacher: { centerId: centerA.id, membershipId: teacherA2.membership.id, userId: teacherA2.user.id },
      centerB: centerB.id,
    });
  } else {
    check("Who-can fixtures resolved (later sections depend on them)", false);
  }
  await checkRlsAndGrants();
  checkStatics();
  await checkAttemptTablesAndStatics();
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => {
      console.error("cleanup failed:", error);
      failures += 1;
    });
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assessments check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll assessments checks passed.");
  });
