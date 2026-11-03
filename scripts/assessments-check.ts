/**
 * Assessments check — the W2 acceptance gate (docs/03-build-order.md W2
 * "Gates"; D-W01–D-W06, D-W08, D-W11, D-W30 in docs/00 §5.1 "W-batch").
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
import {
  ASSESSMENT_LIMITS,
  STUDENT_ASSESSMENT_SELECT,
  assessmentDefaults,
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
  createAssessment,
  deleteAssessment,
  findTeacherAssessment,
  homeworkDeadlineFor,
  isAssessmentLocked,
  listTeacherAssessments,
  resolveAssessmentTeacher,
  saveAssessmentDraft,
  type AssessmentTeacher,
} from "../lib/db/assessments.ts";
import { forbiddenAuditKey } from "../lib/db/audit-row.ts";
import { loadPermissionGrants, savePermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { scopedData } from "../lib/db/tenant-scope.ts";
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

async function main() {
  await cleanup();
  checkDefaults();
  checkLimits();

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
  } else {
    check("Who-can fixtures resolved (later sections depend on them)", false);
  }
  await checkRlsAndGrants();
  checkStatics();
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
