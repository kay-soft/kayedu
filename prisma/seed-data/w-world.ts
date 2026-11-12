/**
 * X1 — the W1–W10 world of the demo seed: premium teachers, assistants,
 * PERSONAL workspaces (students, invitations, share code, check-in, money,
 * Earnings), exams and homework at a branch and in a workspace, notices, and
 * the one multi-experience account for the role switcher. Called once by
 * `prisma/seed.ts`, after the branches, their history and the families exist.
 *
 * **How it writes.** Through the W writers, never a copy of them:
 * `grantPremium` (as the seeded platform admin), `createAssistantInvite` /
 * `redeemAssistantCode` / `updateAssistantPermissions`, `createWorkspace` /
 * `createWorkspaceClass` / `createWorkspaceSession`, `addWorkspaceStudent` /
 * `acceptWorkspaceInvitation` / `enrolWorkspaceStudent`, `workspaceCheckIn` /
 * `workspaceRecordPayment` (the live session, real clock), the class engine,
 * and `createAssessment` / `publishAssessment` / `startAttempt` /
 * `saveAnswer` / `submitAttempt`. The direct writes — each commented where it
 * happens — are the ones with no writer: the two fixed-plaintext dev codes
 * (and the renewal of their expiry), past workspace sessions, the student
 * profiles and enrolments a desk would type, and multi.experience's family
 * link (a fixture the writer would refuse).
 *
 * **Backdated clocks** (teacher.expired, the closed exams) are passed
 * explicitly to each writer call as `now`; nothing sets a global clock. Audit
 * rows those writers write carry the real time.
 *
 * **Idempotent and resumable**, like the rest of the seed: every step finds
 * what it would create and skips it; premium is never re-granted or
 * re-expired; nothing is deleted to make a re-run work.
 */
import type { PrismaClient, Room, User } from "@prisma/client";

import { isPremium } from "../../lib/auth/premium.ts";
import { assessmentDefaults, type AssessmentDraft, type AssessmentSettings } from "../../lib/assessments.ts";
import { ASSISTANT_LIMITS, detectPreset, sortPermissions, type AssistantPermission } from "../../lib/assistant-catalog.ts";
import { createAssessment, homeworkDeadlineFor, publishAssessment, type AssessmentTeacher } from "../../lib/db/assessments.ts";
import { resolveAssessmentStudent, saveAnswer, startAttempt, submitAttempt } from "../../lib/db/assessment-attempts.ts";
import {
  ASSISTANT_AUDIT_ACTIONS,
  assistantSlotsInUse,
  createAssistantInvite,
  hashAssistantCode,
  redeemAssistantCode,
  revokeAssistantInvite,
  updateAssistantPermissions,
} from "../../lib/db/assistants.ts";
import { createAttendance } from "../../lib/db/attendance.ts";
import { auditRowData, writeAuditRow } from "../../lib/db/audit-row.ts";
import { createClassWithSessions } from "../../lib/db/class-sessions.ts";
import { createPerson } from "../../lib/db/identity.ts";
import { recordPayment, voidPayment } from "../../lib/db/payments.ts";
import { grantPremium } from "../../lib/db/premium.ts";
import { refundPayment } from "../../lib/db/refunds.ts";
import { closeSession, WRITE_TRANSACTION_OPTIONS } from "../../lib/db/session-lifecycle.ts";
import { claimStudentCode } from "../../lib/db/students.ts";
import { workspaceCheckIn, workspacePaymentMethod, workspaceRecordPayment } from "../../lib/db/workspace-attendance.ts";
import { WORKSPACE_CODE_AUDIT } from "../../lib/db/workspace-share-codes.ts";
import {
  acceptWorkspaceInvitation,
  addWorkspaceStudent,
  enrolWorkspaceStudent,
  inviteWorkspaceStudentAgain,
} from "../../lib/db/workspace-students.ts";
import {
  createWorkspace,
  createWorkspaceClass,
  createWorkspaceSession,
  ownedWorkspaceWhere,
  workspaceRoomId,
} from "../../lib/db/workspaces.ts";
import { DEFAULT_TIMEZONE, addDays, dateKey, todayInTimezone, zonedClock, zonedDateTimeToUtc } from "../../lib/scheduling.ts";
import { WORKSPACE_SHARE_CODE_DAYS } from "../../lib/workspace-share-code.ts";

import type { Catalog } from "./catalog.ts";
import { SEED_EMAIL_DOMAIN } from "./domain.ts";
import { hashString, hhmm, makeRng, pool, toMinutes, type PhoneBook } from "./helpers.ts";
import { generatePerson, parentFirstName } from "./names.ts";
import {
  DEV_W_CODES,
  DISCOVER_STUDENT,
  EXPIRED_WORKSPACE,
  PREMIUM_DOWNTOWN_CLASS,
  PREMIUM_SEED_DAYS,
  PREMIUM_WORKSPACE,
  W_PEOPLE,
  type PersonDef,
  type WorkspaceClassDef,
} from "./plan.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TZ = DEFAULT_TIMEZONE;

/** The custom check-in assistant's exact grants (X1 decision 2). */
export const CHECKIN_ASSISTANT_PERMISSIONS: readonly AssistantPermission[] = ["checkin.workspace", "payments.workspace"];

export type WWorldDeps = {
  prisma: PrismaClient;
  phones: PhoneBook;
  line: (text?: string) => void;
  ensurePerson: (def: PersonDef) => Promise<User>;
  addTeacher: (centerId: string, def: PersonDef, actorUserId: string) => Promise<string>;
  catalog: Catalog;
  adminId: string;
  downtown: {
    centerId: string;
    actorId: string;
    rooms: Room[];
    /** student.downtown's profile at Downtown. */
    youssefProfileId: string;
  };
  today: Date;
  fullYearEnd: Date;
  /** A throwaway local database: accounts have no login, so login-only steps are reported and skipped. */
  local: boolean;
};

type Ctx = WWorldDeps & { now: Date };

function failed(label: string, result: { ok: boolean; error?: unknown }): never {
  throw new Error(`${label}: ${String(result.error)}`);
}

function skipFriday(date: Date): Date {
  return date.getUTCDay() === 5 ? addDays(date, 1) : date;
}

async function hasLogin(ctx: Ctx, userId: string): Promise<boolean> {
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { authId: true } });
  return Boolean(user?.authId);
}

// ── Premium ─────────────────────────────────────────────────────────────────

/**
 * teacher.premium: granted once, through the W6 writer acting as the seeded
 * platform admin, about a year ahead of this run. Any stored end (a re-run,
 * or an admin's change while testing) is left alone — never re-granted.
 */
async function ensureSeedPremium(ctx: Ctx, userId: string): Promise<string> {
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { premiumUntil: true } });
  if (user.premiumUntil !== null) {
    return `premium already set (until ${user.premiumUntil.toISOString().slice(0, 10)}${isPremium(user, ctx.now) ? "" : ", lapsed"}) — left as it is`;
  }
  const endDay = dateKey(addDays(todayInTimezone(TZ, ctx.now), PREMIUM_SEED_DAYS));
  const granted = await grantPremium(ctx.prisma, { actorUserId: ctx.adminId, userId, endDay });
  if (!granted.ok) failed("grant premium to teacher.premium", granted);
  return `premium granted through ${endDay}`;
}

// ── People and Downtown records ─────────────────────────────────────────────

type DowntownStudent = { key: string; userId: string; profileId: string; login: boolean };

/**
 * A Downtown StudentProfile, written in the exact shape the main seed's
 * `ensureStudents` writes one — direct, because a desk-typed student record
 * has no lib/db writer the seed can call (the desk path is a Server Action).
 */
async function ensureDowntownProfile(
  ctx: Ctx,
  spec: { key: string; userId: string; first: string; last: string; email: string | null; gradeId: string; phone: string | null; parentFirst: string; parentLast: string },
): Promise<string> {
  const centerId = ctx.downtown.centerId;
  const existing = await ctx.prisma.studentProfile.findFirst({ where: { centerId, userId: spec.userId }, select: { id: true } });
  if (existing) return existing.id;
  const parentPhone = ctx.phones.forKey(`${spec.key}:parent`);
  const profile = await ctx.prisma.$transaction(async (tx) => {
    const studentCode = await claimStudentCode(tx, centerId);
    return tx.studentProfile.create({
      data: {
        userId: spec.userId,
        centerId,
        studentCode,
        gradeId: spec.gradeId,
        firstName: spec.first,
        lastName: spec.last,
        email: spec.email?.toLowerCase() ?? null,
        phone: spec.phone,
        parentFirstName: spec.parentFirst,
        parentLastName: spec.parentLast,
        parentPhone: parentPhone.canonical,
        profileCompletedAt: new Date(),
      },
    });
  }, WRITE_TRANSACTION_OPTIONS);
  await writeAuditRow(ctx.prisma, {
    centerId,
    actorUserId: ctx.downtown.actorId,
    action: "student.create",
    entityType: "StudentProfile",
    entityId: profile.id,
    after: { userId: spec.userId, studentCode: profile.studentCode, via: "seed" },
  });
  return profile.id;
}

/** The new non-login Secondary 2 students of teacher.premium's Downtown class (generated, deterministic). */
async function ensureNewDowntownStudents(ctx: Ctx, gradeId: string): Promise<DowntownStudent[]> {
  const rng = makeRng(hashString("x1:downtown-physics"));
  const taken = new Set<string>();
  const out: DowntownStudent[] = [];
  for (let index = 1; index <= PREMIUM_DOWNTOWN_CLASS.newStudents; index += 1) {
    const person = generatePerson(rng, taken, { arabic: index === 4 });
    const parent = parentFirstName(rng, person.arabicScript, person.firstName);
    const nn = String(index).padStart(2, "0");
    const key = `downtown:wstudent:${nn}`;
    const email = `${person.slug}.dw${nn}@${SEED_EMAIL_DOMAIN}`;
    const phone = ctx.phones.forKey(key);
    const user =
      (await ctx.prisma.user.findUnique({ where: { email } })) ??
      (await createPerson(
        { firstName: person.firstName, lastName: person.lastName, email, phone: phone.raw, altPhone: null, locale: person.arabicScript ? "ar" : "en" },
        ctx.prisma,
      ));
    const profileId = await ensureDowntownProfile(ctx, {
      key,
      userId: user.id,
      first: person.firstName,
      last: person.lastName,
      email,
      gradeId,
      phone: phone.canonical,
      parentFirst: parent.name,
      parentLast: person.lastName,
    });
    out.push({ key, userId: user.id, profileId, login: false });
  }
  return out;
}

// ── teacher.premium's Downtown class (FIXED cut, no history) ───────────────

async function ensurePremiumDowntownClass(ctx: Ctx, teacherId: string): Promise<{ id: string; gradeId: string }> {
  const def = PREMIUM_DOWNTOWN_CLASS;
  const centerId = ctx.downtown.centerId;
  const { subjectId, gradeId } = ctx.catalog.pair(def.system, def.grade, def.subject);
  const existing = await ctx.prisma.classGroup.findFirst({ where: { centerId, subjectId, gradeId, teacherId }, select: { id: true } });
  if (existing) return { id: existing.id, gradeId };
  // Sessions from tomorrow on: nothing of it is history, nothing is paid.
  const created = await createClassWithSessions(
    ctx.prisma,
    centerId,
    {
      teacherId,
      subjectId,
      gradeId,
      educationSystemId: ctx.catalog.systemIds[def.system],
      roomId: ctx.downtown.rooms[def.room].id,
      extraRoomIds: [],
      price: def.price,
      centerShareType: def.share.type,
      centerShareValue: def.share.value,
      lateThresholdMinutes: 10,
      acceptsNewStudents: true,
      requiresConfirmation: false,
      sessionBookingMode: "OFF",
      maxBookingSeats: null,
      startDate: addDays(ctx.today, 1),
      endDate: ctx.fullYearEnd,
      slots: [{ dayOfWeek: def.day, startTime: def.start, endTime: def.end }],
    },
    { confirmConflicts: true, actorUserId: ctx.downtown.actorId, now: ctx.now },
  );
  if (!created.ok) failed("teacher.premium's Downtown class", created);
  return { id: created.classGroupId, gradeId };
}

/**
 * Enrolments in that class — direct, in the shape the main seed's
 * `ensureClasses` writes them (a desk enrolment is a Server Action, not a
 * lib/db writer the seed can call), backdated a month so the closed exams'
 * windows fall inside each student's enrolment (D-W31).
 */
async function enrolDowntown(ctx: Ctx, classGroupId: string, profileIds: string[]): Promise<number> {
  const result = await ctx.prisma.enrollment.createMany({
    data: profileIds.map((studentProfileId) => ({
      centerId: ctx.downtown.centerId,
      studentProfileId,
      classGroupId,
      status: "ACTIVE" as const,
      enrolledAt: addDays(ctx.today, -30),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

// ── Assessments ─────────────────────────────────────────────────────────────

type AssessmentSpec = {
  title: string;
  type: "EXAM" | "HOMEWORK";
  classGroupId: string;
  sessionId?: string;
  windowStart?: Date;
  windowEnd?: Date;
  deadline?: Date;
  settings?: Partial<AssessmentSettings>;
  publish: boolean;
  /** The clock the create and publish run on (backdated for a closed exam). */
  clock: Date;
};

const QUESTION_BANK = [
  { text: "Which unit measures force?", options: ["Newton", "Joule", "Watt", "Pascal"] },
  { text: "What stays constant in uniform motion?", options: ["Velocity", "Acceleration", "Force", "Mass only"] },
  { text: "Which quantity is a vector?", options: ["Displacement", "Distance", "Speed", "Time"] },
];

function draftFor(spec: AssessmentSpec): AssessmentDraft {
  return {
    ...assessmentDefaults(spec.type),
    ...spec.settings,
    title: spec.title,
    instructions: null,
    windowStart: spec.type === "EXAM" ? (spec.windowStart ?? null) : null,
    windowEnd: spec.type === "EXAM" ? (spec.windowEnd ?? null) : null,
    deadline: spec.type === "HOMEWORK" ? (spec.deadline ?? null) : null,
    // The first option is the correct one; `shuffle` (an exam's default) reorders it for the student.
    questions: QUESTION_BANK.map((question) => ({
      text: question.text,
      points: 1,
      options: question.options.map((text, index) => ({ text, isCorrect: index === 0 })),
    })),
  };
}

/** One assessment, found by (class, title) or created — and published when wanted — through the W2/W3 writers. */
async function ensureAssessment(ctx: Ctx, teacher: AssessmentTeacher, spec: AssessmentSpec): Promise<{ id: string; state: string }> {
  const actor = { userId: teacher.userId };
  let row = await ctx.prisma.assessment.findFirst({
    where: { centerId: teacher.centerId, classGroupId: spec.classGroupId, title: spec.title },
    select: { id: true, status: true },
  });
  if (!row) {
    const input =
      spec.type === "EXAM"
        ? { type: "EXAM" as const, classGroupId: spec.classGroupId, sessionId: spec.sessionId ?? null, draft: draftFor(spec) }
        : { type: "HOMEWORK" as const, sessionId: spec.sessionId!, draft: draftFor(spec) };
    const created = await createAssessment(ctx.prisma, actor, teacher, input, spec.clock);
    if (!created.ok) failed(`create "${spec.title}"`, created);
    row = { id: created.id, status: "DRAFT" };
  }
  if (spec.publish && row.status === "DRAFT") {
    const published = await publishAssessment(ctx.prisma, actor, teacher, row.id, new Date(spec.clock.getTime() + MINUTE));
    if (!published.ok) failed(`publish "${spec.title}"`, published);
    return { id: row.id, state: "published" };
  }
  return { id: row.id, state: row.status === "DRAFT" ? "draft" : "present" };
}

/**
 * One student's submitted attempt, on the clock it was taken at (inside the
 * window) — start, an answer per question (`right` of them correct), submit.
 * A student with no active profile at the centre (an unlinked account) is skipped.
 */
async function ensureAttempt(ctx: Ctx, centerId: string, assessmentId: string, userId: string, startedAt: Date, right: number): Promise<boolean> {
  const student = await resolveAssessmentStudent(ctx.prisma, centerId, userId);
  if (!student) return false;
  const existing = await ctx.prisma.assessmentAttempt.findUnique({
    where: { assessmentId_studentProfileId: { assessmentId, studentProfileId: student.studentProfileId } },
    select: { submittedAt: true },
  });
  if (existing?.submittedAt) return false;
  const started = await startAttempt(ctx.prisma, student, assessmentId, startedAt);
  if (!started.ok) failed("start attempt", started);
  const questions = await ctx.prisma.assessmentQuestion.findMany({
    where: { centerId, assessmentId },
    orderBy: { position: "asc" },
    include: { options: { orderBy: { position: "asc" } } },
  });
  for (const [index, question] of questions.entries()) {
    const correct = question.options.find((option) => option.isCorrect) ?? question.options[0];
    const wrong = question.options.find((option) => !option.isCorrect) ?? question.options[0];
    const saved = await saveAnswer(
      ctx.prisma,
      student,
      started.attemptId,
      { questionId: question.id, optionId: (index < right ? correct : wrong).id },
      new Date(startedAt.getTime() + (index + 1) * MINUTE),
    );
    if (!saved.ok) failed("save answer", saved);
  }
  const submitted = await submitAttempt(ctx.prisma, student, started.attemptId, new Date(startedAt.getTime() + 10 * MINUTE));
  if (!submitted.ok) failed("submit attempt", submitted);
  return true;
}

/** The class's first SCHEDULED session after now — what a homework attaches to. */
async function firstUpcomingSession(ctx: Ctx, centerId: string, classGroupId: string) {
  return ctx.prisma.session.findFirst({
    where: { centerId, classGroupId, status: "SCHEDULED", rescheduledToId: null, date: { gt: ctx.today } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    select: { id: true, classGroupId: true, date: true, startTime: true, endTime: true, timezone: true },
  });
}

async function homeworkSpec(ctx: Ctx, centerId: string, classGroupId: string, title: string): Promise<AssessmentSpec | null> {
  const session = await firstUpcomingSession(ctx, centerId, classGroupId);
  if (!session?.classGroupId) return null;
  const { deadline } = await homeworkDeadlineFor(ctx.prisma, centerId, { ...session, classGroupId: session.classGroupId }, TZ);
  return { title, type: "HOMEWORK", classGroupId, sessionId: session.id, deadline, publish: true, clock: ctx.now };
}

// ── Assistants ──────────────────────────────────────────────────────────────

/**
 * A live link teacher → assistant through the real invite and redeem paths,
 * on `now` (backdated for teacher.expired). A refused redemption revokes the
 * invite it made (so no slot is held by a code nobody has) and fails the
 * seed — except on a local database, where it is reported.
 */
async function ensureAssistantLink(
  ctx: Ctx,
  teacherUserId: string,
  assistantUserId: string,
  preset: "FULL" | "CO_TEACHER",
  now: Date,
): Promise<{ linkId: string | null; state: string }> {
  const existing = await ctx.prisma.teacherAssistant.findFirst({
    where: { teacherUserId, assistantUserId, revokedAt: null },
    select: { id: true },
  });
  if (existing) return { linkId: existing.id, state: "already linked" };
  const invite = await createAssistantInvite(ctx.prisma, { actorUserId: teacherUserId, preset, now });
  if (!invite.ok) failed("assistant invite", invite);
  const redeemed = await redeemAssistantCode(ctx.prisma, {
    userId: assistantUserId,
    code: invite.code,
    ip: "seed",
    now: new Date(now.getTime() + MINUTE),
  });
  if (!redeemed.ok) {
    await revokeAssistantInvite(ctx.prisma, { actorUserId: teacherUserId, inviteId: invite.inviteId, now });
    if (ctx.local) return { linkId: null, state: `not linked (${redeemed.error} — local database)` };
    failed("assistant redeem", redeemed);
  }
  return { linkId: redeemed.linkId, state: `linked (${preset})` };
}

/**
 * The renewal rule for both fixed dev codes: a code that is still waiting —
 * unused and unrevoked — gets a fresh expiry (a direct update of `expiresAt`
 * only); a used or revoked one is never touched, never resurrected.
 */
function waiting(row: { usedAt: Date | null; revokedAt: Date | null }): boolean {
  return row.usedAt === null && row.revokedAt === null;
}

async function ensureFixedAssistantInvite(ctx: Ctx, teacherUserId: string): Promise<string> {
  const code = DEV_W_CODES.assistantInvite;
  const codeHash = hashAssistantCode(code);
  const label = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  const expiresAt = new Date(ctx.now.getTime() + ASSISTANT_LIMITS.inviteDays * DAY);
  const found = await ctx.prisma.assistantInvite.findUnique({ where: { codeHash } });
  if (found) {
    if (!waiting(found)) return `${label}: ${found.usedAt ? "used" : "revoked"} — left as it is`;
    // An expired one counts toward no slot; renewing it must not make a sixth.
    const expired = found.expiresAt.getTime() <= ctx.now.getTime();
    if (expired && (await assistantSlotsInUse(ctx.prisma, teacherUserId, ctx.now)) >= ASSISTANT_LIMITS.slotsPerTeacher) {
      return `${label}: expired, not renewed — the teacher's five slots are in use`;
    }
    // Direct update of the expiry only (the renewal of a waiting dev code; no writer renews an invite).
    await ctx.prisma.assistantInvite.update({ where: { id: found.id }, data: { expiresAt } });
    return `${label}: waiting, expiry renewed to ${expiresAt.toISOString().slice(0, 10)}`;
  }
  if ((await assistantSlotsInUse(ctx.prisma, teacherUserId, ctx.now)) >= ASSISTANT_LIMITS.slotsPerTeacher) {
    return `${label}: skipped — the teacher's five slots are in use`;
  }
  // Direct write: `createAssistantInvite` always draws a random code, and this
  // one must have a fixed, documented plaintext. Same row and audit shape as
  // the writer; stored only as the writer's own sha256 (hashing is unchanged).
  const invite = await ctx.prisma.assistantInvite.create({
    data: { teacherUserId, codeHash, preset: "CO_TEACHER", expiresAt, createdAt: ctx.now },
    select: { id: true },
  });
  await writeAuditRow(ctx.prisma, {
    centerId: null,
    actorUserId: teacherUserId,
    action: ASSISTANT_AUDIT_ACTIONS.inviteCreate,
    entityType: "AssistantInvite",
    entityId: invite.id,
    after: { preset: "CO_TEACHER", expiresAt: expiresAt.toISOString() },
  });
  return `${label}: created (CO_TEACHER), waiting until ${expiresAt.toISOString().slice(0, 10)}`;
}

async function ensureFixedShareCode(ctx: Ctx, teacherUserId: string, centerId: string, studentProfileId: string): Promise<string> {
  const code = DEV_W_CODES.shareCode;
  const codeHash = hashAssistantCode(code);
  const label = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
  const expiresAt = new Date(ctx.now.getTime() + WORKSPACE_SHARE_CODE_DAYS * DAY);
  const found = await ctx.prisma.workspaceShareCode.findUnique({ where: { codeHash } });
  if (found) {
    if (!waiting(found)) return `${label}: ${found.usedAt ? "used" : "revoked"} — left as it is`;
    // Direct update of the expiry only (the renewal of a waiting dev code).
    await ctx.prisma.workspaceShareCode.update({ where: { id: found.id }, data: { expiresAt } });
    return `${label}: waiting, expiry renewed to ${expiresAt.toISOString().slice(0, 10)}`;
  }
  const profile = await ctx.prisma.studentProfile.findFirst({
    where: { centerId, id: studentProfileId },
    select: { user: { select: { authId: true } } },
  });
  if (!profile || profile.user.authId) return `${label}: skipped — the profile is already linked to an account`;
  // One waiting code per profile (a partial unique index): a code a tester made stays.
  const clash = await ctx.prisma.workspaceShareCode.count({ where: { centerId, studentProfileId, usedAt: null, revokedAt: null } });
  if (clash > 0) return `${label}: skipped — another code for this profile is waiting`;
  // Direct write: `createWorkspaceShareCode` always draws a random code, and
  // this one must have a fixed, documented plaintext. Same row and audit shape
  // as the writer; stored only as the writer's own sha256 (hashing is unchanged).
  const row = await ctx.prisma.workspaceShareCode.create({
    data: { centerId, studentProfileId, createdByUserId: teacherUserId, codeHash, expiresAt, createdAt: ctx.now },
    select: { id: true },
  });
  await writeAuditRow(ctx.prisma, {
    centerId,
    actorUserId: teacherUserId,
    action: WORKSPACE_CODE_AUDIT.create,
    entityType: "WorkspaceShareCode",
    entityId: row.id,
    after: { studentProfileId, expiresAt: expiresAt.toISOString() },
  });
  return `${label}: created, waiting until ${expiresAt.toISOString().slice(0, 10)}`;
}

// ── Workspaces ──────────────────────────────────────────────────────────────

async function ensureWorkspace(ctx: Ctx, ownerId: string, name: string, now: Date): Promise<string> {
  const existing = await ctx.prisma.center.findFirst({ where: { ...ownedWorkspaceWhere(ownerId), name }, select: { id: true } });
  if (existing) return existing.id;
  const created = await createWorkspace(ctx.prisma, ownerId, { name }, now);
  if (!created.ok) failed(`workspace "${name}"`, created);
  return created.workspaceId;
}

async function ensureWorkspaceClass(
  ctx: Ctx,
  ownerId: string,
  workspaceId: string,
  def: Pick<WorkspaceClassDef, "system" | "grade" | "subject" | "price" | "start" | "end">,
  period: { startDate: Date; endDate: Date; day: number },
  now: Date,
): Promise<{ id: string; gradeId: string; price: number }> {
  const { subjectId, gradeId } = ctx.catalog.pair(def.system, def.grade, def.subject);
  const existing = await ctx.prisma.classGroup.findFirst({ where: { centerId: workspaceId, subjectId, gradeId }, select: { id: true } });
  if (existing) return { id: existing.id, gradeId, price: def.price };
  // The cut is never posted: the writer forces PERCENTAGE 0 (D-W24, rule 15).
  const created = await createWorkspaceClass(
    ctx.prisma,
    ownerId,
    workspaceId,
    {
      educationSystemId: ctx.catalog.systemIds[def.system],
      gradeId,
      subjectId,
      price: def.price,
      lateThresholdMinutes: 10,
      startDate: period.startDate,
      endDate: period.endDate,
      slots: [{ dayOfWeek: period.day, startTime: def.start, endTime: def.end }],
    },
    { confirmConflicts: true, now },
  );
  if (!created.ok) failed(`workspace class ${def.subject} ${def.grade}`, created);
  return { id: created.classGroupId, gradeId, price: def.price };
}

/** A typed workspace student, found by its phone in this workspace, or added through the W8b writer. */
async function ensureWorkspaceStudent(
  ctx: Ctx,
  ownerId: string,
  workspaceId: string,
  input: { first: string; last: string; phone: { raw: string; canonical: string }; gradeId: string },
  now: Date,
): Promise<string> {
  const existing = await ctx.prisma.studentProfile.findFirst({
    where: { centerId: workspaceId, phone: input.phone.canonical },
    select: { id: true },
  });
  if (existing) return existing.id;
  const added = await addWorkspaceStudent(
    ctx.prisma,
    ownerId,
    workspaceId,
    { firstName: input.first, lastName: input.last, phone: input.phone.raw, gradeId: input.gradeId },
    { now },
  );
  if (!added.ok) failed(`workspace student ${input.first}`, added);
  return added.studentProfileId;
}

async function ensureWorkspaceEnrolment(ctx: Ctx, ownerId: string, workspaceId: string, classGroupId: string, studentProfileId: string, now: Date) {
  const live = await ctx.prisma.enrollment.count({
    where: { centerId: workspaceId, classGroupId, studentProfileId, status: "ACTIVE" },
  });
  if (live > 0) return;
  const enrolled = await enrolWorkspaceStudent(ctx.prisma, ownerId, workspaceId, classGroupId, studentProfileId, now);
  if (!enrolled.ok) failed("workspace enrolment", enrolled);
}

/**
 * The invitation of a typed profile whose phone is a seed account's
 * User.phone. `addWorkspaceStudent` invites on its own when the account has
 * a login; a profile added while it had none (a local run) is invited again
 * once it has one. `accept` accepts it as the account (student.workspace).
 */
async function settleInvitation(ctx: Ctx, ownerId: string, workspaceId: string, profileId: string, accountId: string, accept: boolean): Promise<string> {
  const profile = await ctx.prisma.studentProfile.findUniqueOrThrow({ where: { id: profileId }, select: { userId: true } });
  if (profile.userId === accountId) return "linked (accepted)";
  if (!(await hasLogin(ctx, accountId))) return "not invited — the account has no login (local database)";
  let pending = await ctx.prisma.workspaceInvitation.findFirst({
    where: { centerId: workspaceId, studentProfileId: profileId, targetUserId: accountId, status: "PENDING" },
    select: { id: true },
  });
  if (!pending) {
    const answered = await ctx.prisma.workspaceInvitation.count({ where: { centerId: workspaceId, studentProfileId: profileId, targetUserId: accountId } });
    if (answered > 0) return "invitation already answered — left as it is";
    const again = await inviteWorkspaceStudentAgain(ctx.prisma, ownerId, workspaceId, profileId);
    if (!again.ok) return `not invited (${again.error})`;
    pending = await ctx.prisma.workspaceInvitation.findFirst({
      where: { centerId: workspaceId, studentProfileId: profileId, targetUserId: accountId, status: "PENDING" },
      select: { id: true },
    });
    if (!pending) return "not invited (no match)";
  }
  if (!accept) return "invitation PENDING";
  const accepted = await acceptWorkspaceInvitation(ctx.prisma, accountId, pending.id);
  if (!accepted.ok) failed("accept workspace invitation", accepted);
  return "linked (invitation accepted)";
}

type HistoryTotals = { sessions: number; checkIns: number; payments: number; voids: number; refunds: number };

/**
 * One closed past session of a workspace class, with check-ins and payments.
 * Past sessions are a direct write (as the main seed's and the W8d gate's
 * history): the class engine only makes sessions from today on. Check-ins,
 * payments, the void and the refund go through the core engine with
 * `historicalBackfill` (the W8c workspace writers have no past mode), then the
 * receipt-time adjustment the main seed makes, then the real `closeSession`.
 */
async function seedWorkspaceSession(
  ctx: Ctx,
  workspaceId: string,
  ownerId: string,
  roomId: string,
  klass: { id: string; price: number; start: string; end: string },
  date: Date,
  options: { roll: string; reversal?: "void" | "refund"; attendance?: "all" | "rolled" },
  totals: HistoryTotals,
) {
  const dayKey = dateKey(date);
  let session = await ctx.prisma.session.findFirst({
    where: { centerId: workspaceId, classGroupId: klass.id, date, startTime: klass.start },
  });
  if (session && (session.closedAt || session.status === "CANCELLED")) return;
  if (!session) {
    session = await ctx.prisma.session.create({
      data: { centerId: workspaceId, classGroupId: klass.id, teacherId: ownerId, roomId, date, startTime: klass.start, endTime: klass.end, priceSnapshot: klass.price },
    });
    totals.sessions += 1;
  }
  const sessionId = session.id;
  const startAt = zonedDateTimeToUtc(dayKey, toMinutes(klass.start), TZ);
  const checkInAt = new Date(startAt.getTime() + 5 * MINUTE);
  const method = await workspacePaymentMethod(ctx.prisma, workspaceId);
  if (!method) throw new Error("The workspace has no Cash method");
  const roster = await ctx.prisma.enrollment.findMany({
    where: { centerId: workspaceId, classGroupId: klass.id, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const rng = makeRng(hashString(`${options.roll}:${dayKey}`));
  const rolls = roster.map(() => rng.next());
  const paymentAudit: ReturnType<typeof auditRowData>[] = [];
  await pool(roster, 1, async (enrollment, position) => {
    const roll = rolls[position];
    if (options.attendance !== "all" && roll < 0.12) return;
    const status = options.attendance !== "all" && roll < 0.22 ? "LATE" : "PRESENT";
    let attendee = await ctx.prisma.sessionAttendee.findFirst({
      where: { centerId: workspaceId, sessionId, studentProfileId: enrollment.studentProfileId },
    });
    if (!attendee) {
      attendee = await createAttendance(
        ctx.prisma,
        { centerId: workspaceId, sessionId, studentProfileId: enrollment.studentProfileId, enrollmentId: enrollment.id, isDropIn: false, recordedBy: ownerId },
        { historicalBackfill: true, status },
      );
      totals.checkIns += 1;
    }
    if (attendee.attendanceStatus === "ABSENT") return;
    if ((await ctx.prisma.payment.count({ where: { centerId: workspaceId, sessionAttendeeId: attendee.id } })) > 0) return;
    const attendeeId = attendee.id;
    const paid = await ctx.prisma.$transaction(
      (tx) => recordPayment(tx, workspaceId, attendeeId, method.id, ownerId, { historicalBackfill: true }),
      WRITE_TRANSACTION_OPTIONS,
    );
    if (!paid.ok) failed(`workspace payment ${attendeeId}`, paid);
    totals.payments += 1;
    paymentAudit.push(
      auditRowData({
        centerId: workspaceId,
        actorUserId: ownerId,
        action: "payment.record",
        entityType: "Payment",
        entityId: paid.payment.id,
        after: {
          amount: paid.payment.amount,
          sessionId: paid.payment.sessionId,
          paymentMethodId: paid.payment.paymentMethodId,
          centerShareSnapshot: paid.payment.centerShareSnapshot,
          teacherShareSnapshot: paid.payment.teacherShareSnapshot,
        },
      }),
    );
  });
  if (paymentAudit.length > 0) await ctx.prisma.auditLog.createMany({ data: paymentAudit });

  // The one void and the one refund of the workspace, once each (a re-run of
  // an interrupted session finds it already done).
  if (options.reversal) {
    const reversed = await ctx.prisma.payment.count({ where: { centerId: workspaceId, sessionId, OR: [{ voided: true }, { refunded: true }] } });
    const target = await ctx.prisma.payment.findFirst({
      where: { centerId: workspaceId, sessionId, voided: false, refunded: false },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    });
    if (reversed === 0 && target) {
      const at = { historicalBackfill: true as const, now: new Date(startAt.getTime() + 30 * MINUTE) };
      if (options.reversal === "void") {
        const voided = await ctx.prisma.$transaction(
          (tx) => voidPayment(tx, workspaceId, target.id, "Recorded twice by mistake", ownerId, at),
          WRITE_TRANSACTION_OPTIONS,
        );
        if (!voided.ok) failed("workspace void", voided);
        await writeAuditRow(ctx.prisma, {
          centerId: workspaceId,
          actorUserId: ownerId,
          action: "payment.void",
          entityType: "Payment",
          entityId: target.id,
          before: { amount: target.amount, voided: false },
          after: { voided: true, sessionId },
        });
        totals.voids += 1;
      } else {
        const refunded = await ctx.prisma.$transaction(
          (tx) => refundPayment(tx, workspaceId, target.id, "Left early — money returned", ownerId, at),
          WRITE_TRANSACTION_OPTIONS,
        );
        if (!refunded.ok) failed("workspace refund", refunded);
        await writeAuditRow(ctx.prisma, {
          centerId: workspaceId,
          actorUserId: ownerId,
          action: "payment.refund",
          entityType: "Payment",
          entityId: target.id,
          before: { refunded: false },
          after: {
            refunded: true,
            refundId: refunded.refund.id,
            sessionId,
            amount: refunded.refund.amount,
            centerShareReversed: refunded.refund.centerShareReversed,
            teacherShareReversed: refunded.refund.teacherShareReversed,
          },
        });
        totals.refunds += 1;
      }
    }
  }

  // Receipts read as the day they ran (the main seed's adjustment: clock stamps only, never money).
  await ctx.prisma.sessionAttendee.updateMany({ where: { sessionId, attendanceStatus: { not: "ABSENT" } }, data: { recordedAt: checkInAt } });
  await ctx.prisma.payment.updateMany({ where: { sessionId }, data: { recordedAt: checkInAt } });

  const closed = await closeSession(ctx.prisma, workspaceId, sessionId, {
    closedBy: ownerId,
    now: zonedDateTimeToUtc(dayKey, toMinutes(klass.end) + 5, TZ),
  });
  if (!closed.ok) failed(`close workspace session ${sessionId}`, closed);
  await writeAuditRow(ctx.prisma, {
    centerId: workspaceId,
    actorUserId: ownerId,
    action: "session.close",
    entityType: "Session",
    entityId: sessionId,
    after: {
      status: closed.session.status,
      closeMode: closed.session.closeMode,
      closedAt: closed.session.closedAt?.toISOString() ?? null,
      absentCreated: closed.absentCreated,
    },
  });
}

/**
 * Today's live workspace session (W8c): an extra session that started about
 * 20 minutes ago, partly checked in and partly paid — through the real
 * workspace writers on the real clock, so check-in, pay and End session can
 * be tried. Skipped before 00:40 Cairo, like the branch live session.
 */
async function seedLiveWorkspaceSession(ctx: Ctx, ownerId: string, workspaceId: string, classGroupId: string): Promise<string> {
  const clock = zonedClock(ctx.now, TZ);
  const existing = await ctx.prisma.session.findFirst({
    where: { centerId: workspaceId, classGroupId, date: ctx.today, isManual: true },
    select: { id: true, startTime: true, endTime: true, closedAt: true },
  });
  if (!existing && clock.minutes < 40) return "too early in the day for a live session — skipped";
  let sessionId: string;
  let window: string;
  if (existing) {
    if (existing.closedAt) return `live session ${existing.startTime}–${existing.endTime}: already ended`;
    sessionId = existing.id;
    window = `${existing.startTime}–${existing.endTime}`;
  } else {
    const start = Math.max(0, Math.floor((clock.minutes - 20) / 5) * 5);
    const end = Math.min(23 * 60 + 55, start + 90);
    const created = await createWorkspaceSession(
      ctx.prisma,
      ownerId,
      workspaceId,
      { kind: "extra", classGroupId, date: ctx.today, startTime: hhmm(start), endTime: hhmm(end) },
      { confirmConflicts: true },
    );
    if (!created.ok) failed("live workspace session", created);
    sessionId = created.sessionId;
    window = `${hhmm(start)}–${hhmm(end)}`;
  }
  const actor = { actorUserId: ownerId, teacherUserId: ownerId };
  const roster = await ctx.prisma.enrollment.findMany({
    where: { centerId: workspaceId, classGroupId, status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let checkedIn = 0;
  let paid = 0;
  for (const [index, enrollment] of roster.entries()) {
    if (index % 3 === 2) continue; // not here yet
    let attendee = await ctx.prisma.sessionAttendee.findFirst({
      where: { centerId: workspaceId, sessionId, studentProfileId: enrollment.studentProfileId },
    });
    if (!attendee) {
      const result = await workspaceCheckIn(ctx.prisma, actor, workspaceId, { sessionId, studentProfileId: enrollment.studentProfileId });
      if (!result.ok) failed("live workspace check-in", result);
      attendee = result.attendee;
    }
    checkedIn += 1;
    if (index % 2 === 1 || attendee.attendanceStatus === "ABSENT") continue; // left to pay by hand
    if ((await ctx.prisma.payment.count({ where: { centerId: workspaceId, sessionAttendeeId: attendee.id } })) > 0) {
      paid += 1;
      continue;
    }
    const payment = await workspaceRecordPayment(ctx.prisma, actor, workspaceId, { attendeeId: attendee.id });
    if (!payment.ok) failed("live workspace payment", payment);
    paid += 1;
  }
  return `live session ${window}: ${checkedIn}/${roster.length} checked in, ${paid} paid`;
}

/**
 * A Downtown TEACHER through the identity-aware teacher path
 * (`createTeacherMembership`) the first time; on a re-run the membership is
 * found and only the login is re-linked (`ensurePerson`) — the teacher path
 * spends the actor's identity-lookup budget (20 a minute), and a fast re-run
 * of the whole seed would otherwise run out of it.
 */
async function ensureDowntownTeacher(ctx: Ctx, def: PersonDef): Promise<string> {
  const user = def.email ? await ctx.prisma.user.findUnique({ where: { email: def.email.toLowerCase() }, select: { id: true } }) : null;
  if (user) {
    const membership = await ctx.prisma.membership.count({ where: { userId: user.id, centerId: ctx.downtown.centerId, role: "TEACHER" } });
    if (membership > 0) return (await ctx.ensurePerson(def)).id;
  }
  return ctx.addTeacher(ctx.downtown.centerId, def, ctx.downtown.actorId);
}

// ── The phase ───────────────────────────────────────────────────────────────

export async function seedWWorld(deps: WWorldDeps): Promise<void> {
  const ctx: Ctx = { ...deps, now: new Date() };
  const { prisma, line } = ctx;
  line("\n■ Premium, assistants and workspaces (X1)");

  // People. teacher.premium and multi.experience take the identity-aware
  // teacher path at Downtown (createTeacherMembership); the rest are global
  // Users through the seed's own ensurePerson (each with a User.phone).
  const downtownId = ctx.downtown.centerId;
  const premiumId = await ensureDowntownTeacher(ctx, W_PEOPLE.premium);
  const multiId = await ensureDowntownTeacher(ctx, W_PEOPLE.multi);
  const expiredId = (await ctx.ensurePerson(W_PEOPLE.expired)).id;
  const fullId = (await ctx.ensurePerson(W_PEOPLE.assistantFull)).id;
  const checkinId = (await ctx.ensurePerson(W_PEOPLE.assistantCheckin)).id;
  const wsStudentId = (await ctx.ensurePerson(W_PEOPLE.wsStudent)).id;
  const invitedId = (await ctx.ensurePerson(W_PEOPLE.invited)).id;
  line(`  teacher.premium: ${await ensureSeedPremium(ctx, premiumId)}`);

  // ── teacher.premium at Downtown: the FIXED-cut class, its roster ─────────
  const downtownClass = await ensurePremiumDowntownClass(ctx, premiumId);
  const newStudents = await ensureNewDowntownStudents(ctx, downtownClass.gradeId);
  const invitedProfileId = await ensureDowntownProfile(ctx, {
    key: W_PEOPLE.invited.key,
    userId: invitedId,
    first: W_PEOPLE.invited.first,
    last: W_PEOPLE.invited.last,
    email: W_PEOPLE.invited.email,
    gradeId: downtownClass.gradeId,
    phone: ctx.phones.forKey(W_PEOPLE.invited.key).canonical,
    parentFirst: "Hoda",
    parentLast: W_PEOPLE.invited.last,
  });
  const multiProfileId = await ensureDowntownProfile(ctx, {
    key: W_PEOPLE.multi.key,
    userId: multiId,
    first: W_PEOPLE.multi.first,
    last: W_PEOPLE.multi.last,
    email: W_PEOPLE.multi.email,
    gradeId: downtownClass.gradeId,
    phone: ctx.phones.forKey(W_PEOPLE.multi.key).canonical,
    parentFirst: "Sherif",
    parentLast: W_PEOPLE.multi.last,
  });
  const roster = [ctx.downtown.youssefProfileId, ...newStudents.map((s) => s.profileId), invitedProfileId, multiProfileId];
  const enrolled = await enrolDowntown(ctx, downtownClass.id, roster);
  line(`  Downtown: Physics · Secondary 2 (teacher.premium, FIXED 30 EGP of 150): ${roster.length} enrolled (${enrolled} new), upcoming sessions only`);

  // ── multi.experience: student.new's parent (a FIXTURE) ────────────────────
  // FIXTURE the writer would refuse: `acceptFamilyCode` refuses a student
  // account (`studentAccount`), and this account holds a Downtown student
  // profile. Inserted directly, in the exact shape e2e/experience-switcher.spec.ts
  // inserts its own multi-kind account's link.
  const child = await prisma.user.findUniqueOrThrow({ where: { email: DISCOVER_STUDENT.email!.toLowerCase() }, select: { id: true } });
  const link = await prisma.familyLink.findUnique({ where: { parentUserId_studentUserId: { parentUserId: multiId, studentUserId: child.id } } });
  if (!link) {
    await prisma.familyLink.create({ data: { parentUserId: multiId, studentUserId: child.id, status: "ACTIVE", source: "STUDENT_INVITE" } });
  }
  line(`  multi.experience: TEACHER + student at Downtown, parent of student.new (${link ? `link ${link.status}` : "link created"})`);

  // ── teacher.premium's workspace ───────────────────────────────────────────
  const wsId = await ensureWorkspace(ctx, premiumId, PREMIUM_WORKSPACE.name, ctx.now);
  const wsRoomId = await workspaceRoomId(prisma, wsId);
  if (!wsRoomId) throw new Error("The workspace has no hidden room");
  const historyStart = addDays(ctx.today, -PREMIUM_WORKSPACE.historyDays);
  const wsClasses = new Map<string, { id: string; gradeId: string; price: number; def: WorkspaceClassDef }>();
  for (const def of PREMIUM_WORKSPACE.classes) {
    const row = await ensureWorkspaceClass(ctx, premiumId, wsId, def, { startDate: historyStart, endDate: ctx.fullYearEnd, day: def.day }, ctx.now);
    wsClasses.set(def.key, { ...row, def });
  }
  const accounts: Record<string, string> = { wsStudent: wsStudentId, invited: invitedId };
  const wsProfiles = new Map<string, string>();
  const invitationStates: string[] = [];
  for (const def of PREMIUM_WORKSPACE.students) {
    const klass = wsClasses.get(def.classKey)!;
    const accountId = def.kind === "account" ? accounts[def.account!] : null;
    let phone = ctx.phones.forKey(def.key);
    if (accountId) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: accountId }, select: { phone: true } });
      if (!user.phone) throw new Error(`${def.account} has no User.phone to be invited by`);
      phone = { raw: user.phone, canonical: user.phone };
    }
    const profileId = await ensureWorkspaceStudent(ctx, premiumId, wsId, { first: def.first, last: def.last, phone, gradeId: klass.gradeId }, ctx.now);
    wsProfiles.set(def.key, profileId);
    if (accountId) {
      const state = await settleInvitation(ctx, premiumId, wsId, profileId, accountId, def.account === "wsStudent");
      invitationStates.push(`${W_PEOPLE[def.account!].email}: ${state}`);
    }
    await ensureWorkspaceEnrolment(ctx, premiumId, wsId, klass.id, profileId, ctx.now);
  }
  line(`  workspace "${PREMIUM_WORKSPACE.name}": ${wsClasses.size} classes (PERCENTAGE 0), ${wsProfiles.size} students`);
  for (const state of invitationStates) line(`    ${state}`);

  // History: every class day of the last 45 days, closed, paid; one void, one refund.
  const totals: HistoryTotals = { sessions: 0, checkIns: 0, payments: 0, voids: 0, refunds: 0 };
  for (const [classIndex, def] of PREMIUM_WORKSPACE.classes.entries()) {
    const klass = wsClasses.get(def.key)!;
    const dates: Date[] = [];
    for (let day = historyStart; day < ctx.today; day = addDays(day, 1)) if (day.getUTCDay() === def.day) dates.push(day);
    for (const [dateIndex, date] of dates.entries()) {
      const reversal = classIndex === 0 && dateIndex === 1 ? "void" : classIndex === 1 && dateIndex === 2 ? "refund" : undefined;
      await seedWorkspaceSession(ctx, wsId, premiumId, wsRoomId, { id: klass.id, price: klass.price, start: def.start, end: def.end }, date, { roll: `${wsId}:${def.key}`, reversal }, totals);
    }
  }
  line(`  workspace history: ${totals.sessions} new past sessions, ${totals.checkIns} check-ins, ${totals.payments} payments, ${totals.voids} void, ${totals.refunds} refund`);
  const firstClass = wsClasses.get(PREMIUM_WORKSPACE.classes[0].key)!;
  const secondClass = wsClasses.get(PREMIUM_WORKSPACE.classes[1].key)!;
  line(`  workspace today: ${await seedLiveWorkspaceSession(ctx, premiumId, wsId, firstClass.id)}`);
  line(`  share code ${await ensureFixedShareCode(ctx, premiumId, wsId, wsProfiles.get("ws:coded")!)}`);

  // ── Assistants of teacher.premium (the branch and the workspace) ─────────
  const full = await ensureAssistantLink(ctx, premiumId, fullId, "FULL", ctx.now);
  line(`  assistant.premium: ${full.state}`);
  const checkin = await ensureAssistantLink(ctx, premiumId, checkinId, "CO_TEACHER", ctx.now);
  if (checkin.linkId) {
    const grants = await prisma.assistantPermissionGrant.findMany({ where: { assistantId: checkin.linkId }, select: { permission: true } });
    const names = grants.map((grant) => grant.permission);
    // Invited as CO_TEACHER, then cut down to exactly check-in + payments
    // through the teacher's own permission writer — it then reads "Custom".
    if (detectPreset(names) === "CO_TEACHER") {
      const cut = await updateAssistantPermissions(prisma, {
        actorUserId: premiumId,
        linkId: checkin.linkId,
        change: { permissions: [...CHECKIN_ASSISTANT_PERMISSIONS] },
      });
      if (!cut.ok) failed("cut assistant.checkin down", cut);
    }
    const after = sortPermissions((await prisma.assistantPermissionGrant.findMany({ where: { assistantId: checkin.linkId } })).map((g) => g.permission));
    line(`  assistant.checkin: ${checkin.state}; grants ${after.join(" + ")} (${detectPreset(after)})`);
  } else line(`  assistant.checkin: ${checkin.state}`);
  line(`  assistant invite ${await ensureFixedAssistantInvite(ctx, premiumId)}`);

  // ── Assessments at Downtown (teacher.premium) ─────────────────────────────
  const downtownMembership = await prisma.membership.findFirstOrThrow({
    where: { centerId: downtownId, userId: premiumId, role: "TEACHER", active: true },
    select: { id: true },
  });
  const branchTeacher: AssessmentTeacher = { centerId: downtownId, membershipId: downtownMembership.id, userId: premiumId };
  const now = ctx.now.getTime();
  const at = (days: number) => new Date(now + days * DAY);
  const branch: string[] = [];
  branch.push(
    `open exam ${(await ensureAssessment(ctx, branchTeacher, { title: "Electricity quiz", type: "EXAM", classGroupId: downtownClass.id, windowStart: at(-1 / 24), windowEnd: at(4), publish: true, clock: ctx.now })).state}`,
  );
  const branchHomework = await homeworkSpec(ctx, downtownId, downtownClass.id, "Homework: circuits");
  if (branchHomework) branch.push(`homework ${(await ensureAssessment(ctx, branchTeacher, branchHomework)).state}`);
  // Closed exams, on a backdated clock passed to each call: created and
  // published before their window, taken inside it.
  const waves = await ensureAssessment(ctx, branchTeacher, {
    title: "Waves exam",
    type: "EXAM",
    classGroupId: downtownClass.id,
    windowStart: at(-10),
    windowEnd: at(-8),
    settings: { showScore: true, showCorrectAnswers: true },
    publish: true,
    clock: at(-11),
  });
  const optics = await ensureAssessment(ctx, branchTeacher, {
    title: "Optics exam",
    type: "EXAM",
    classGroupId: downtownClass.id,
    windowStart: at(-6),
    windowEnd: at(-5),
    settings: { showScore: false, showCorrectAnswers: false },
    publish: true,
    clock: at(-7),
  });
  const youssefUserId = (await prisma.studentProfile.findUniqueOrThrow({ where: { id: ctx.downtown.youssefProfileId }, select: { userId: true } })).userId;
  let attempts = 0;
  const takers = [youssefUserId, ...newStudents.map((s) => s.userId)];
  for (const [index, userId] of takers.slice(0, 4).entries()) {
    if (await ensureAttempt(ctx, downtownId, waves.id, userId, new Date(at(-9).getTime() + index * 20 * MINUTE), [3, 2, 1, 3][index])) attempts += 1;
  }
  for (const [index, userId] of [takers[0], takers[4], takers[5]].entries()) {
    if (await ensureAttempt(ctx, downtownId, optics.id, userId, new Date(at(-5.5).getTime() + index * 20 * MINUTE), [2, 1, 3][index])) attempts += 1;
  }
  branch.push(`closed "Waves exam" (revealed) ${waves.state}`, `closed "Optics exam" (hidden) ${optics.state}`, `${attempts} new attempt(s)`);
  line(`  Downtown assessments: ${branch.join("; ")}`);

  // ── Assessments in the workspace (W9) ─────────────────────────────────────
  const wsMembership = await prisma.membership.findFirstOrThrow({ where: { centerId: wsId, userId: premiumId, role: "TEACHER" }, select: { id: true } });
  const wsTeacher: AssessmentTeacher = { centerId: wsId, membershipId: wsMembership.id, userId: premiumId };
  const ws: string[] = [];
  ws.push(
    `open exam ${(await ensureAssessment(ctx, wsTeacher, { title: "Kinematics quiz", type: "EXAM", classGroupId: firstClass.id, windowStart: at(-1 / 24), windowEnd: at(5), publish: true, clock: ctx.now })).state}`,
  );
  const forces = await ensureAssessment(ctx, wsTeacher, {
    title: "Forces test",
    type: "EXAM",
    classGroupId: firstClass.id,
    windowStart: at(-12),
    windowEnd: at(-10),
    settings: { showScore: true, showCorrectAnswers: true },
    publish: true,
    clock: at(-13),
  });
  // Only a linked student takes a workspace exam (an unlinked typed profile is
  // not eligible — it has no login): student.workspace, once linked.
  const wsAttempt = await ensureAttempt(ctx, wsId, forces.id, wsStudentId, at(-11), 2);
  ws.push(`closed "Forces test" (revealed) ${forces.state}, ${wsAttempt ? "student.workspace's attempt submitted" : "no new attempt"}`);
  const wsHomework = await homeworkSpec(ctx, wsId, firstClass.id, "Homework: motion graphs");
  if (wsHomework) ws.push(`homework ${(await ensureAssessment(ctx, wsTeacher, wsHomework)).state}`);
  ws.push(
    `unpublished exam ${(await ensureAssessment(ctx, wsTeacher, { title: "Energy exam (draft)", type: "EXAM", classGroupId: secondClass.id, windowStart: at(3), windowEnd: at(5), publish: false, clock: ctx.now })).state}`,
  );
  line(`  workspace assessments: ${ws.join("; ")}`);

  // ── teacher.expired: everything on one backdated clock ───────────────────
  await seedExpiredTeacher(ctx, expiredId, fullId);
}

/**
 * teacher.expired (X1 decision 5): premium granted, the workspace, its class,
 * the student, the invite and its redemption — each writer called with an
 * explicit `now` on one clock 50 days back, so the granted end (40 days after
 * that clock) is already in the past. Only while the account has no stored
 * premium and no workspace is premium granted: a re-run never re-grants or
 * re-expires it.
 */
async function seedExpiredTeacher(ctx: Ctx, expiredId: string, assistantId: string) {
  const { prisma, line } = ctx;
  const def = EXPIRED_WORKSPACE;
  const clock = new Date(ctx.now.getTime() - def.clockDaysAgo * DAY);
  const tick = (minutes: number) => new Date(clock.getTime() + minutes * MINUTE);
  const clockDay = todayInTimezone(TZ, clock);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: expiredId }, select: { premiumUntil: true } });
  const ownsOne = (await prisma.center.count({ where: ownedWorkspaceWhere(expiredId) })) > 0;
  let premiumState: string;
  if (user.premiumUntil === null && !ownsOne) {
    const endDay = dateKey(addDays(clockDay, def.premiumDays));
    const granted = await grantPremium(prisma, { actorUserId: ctx.adminId, userId: expiredId, endDay, now: clock });
    if (!granted.ok) failed("grant premium to teacher.expired", granted);
    premiumState = `premium granted on a backdated clock, ended ${endDay}`;
  } else if (user.premiumUntil === null) {
    line("  teacher.expired: premium was revoked by hand — nothing more is written");
    return;
  } else {
    premiumState = `premium ${isPremium(user, ctx.now) ? "active (changed by hand)" : `lapsed (ended ${user.premiumUntil.toISOString().slice(0, 10)})`} — left as it is`;
  }

  const wsId = await ensureWorkspace(ctx, expiredId, def.name, tick(1));
  const sessionDay = skipFriday(addDays(clockDay, 5));
  const klass = await ensureWorkspaceClass(
    ctx,
    expiredId,
    wsId,
    def.class,
    { startDate: sessionDay, endDate: sessionDay, day: sessionDay.getUTCDay() },
    tick(2),
  );
  const phone = ctx.phones.forKey(def.student.key);
  const profileId = await ensureWorkspaceStudent(ctx, expiredId, wsId, { first: def.student.first, last: def.student.last, phone, gradeId: klass.gradeId }, tick(3));
  await ensureWorkspaceEnrolment(ctx, expiredId, wsId, klass.id, profileId, tick(4));

  // Its one past session (the class engine made it on the backdated clock): checked in, paid, closed.
  const session = await prisma.session.findFirst({ where: { centerId: wsId, classGroupId: klass.id }, orderBy: { date: "asc" } });
  const roomId = await workspaceRoomId(prisma, wsId);
  if (session && roomId) {
    const totals: HistoryTotals = { sessions: 0, checkIns: 0, payments: 0, voids: 0, refunds: 0 };
    await seedWorkspaceSession(
      ctx,
      wsId,
      expiredId,
      roomId,
      { id: klass.id, price: klass.price, start: session.startTime, end: session.endTime },
      session.date,
      { roll: `${wsId}:expired`, attendance: "all" },
      totals,
    );
  }
  const link = await ensureAssistantLink(ctx, expiredId, assistantId, "CO_TEACHER", tick(5));
  line(`  teacher.expired: ${premiumState}; workspace "${def.name}" (1 class, 1 student, past session ${session ? dateKey(session.date) : "missing"}); assistant.premium ${link.state} — inert while lapsed`);
}
