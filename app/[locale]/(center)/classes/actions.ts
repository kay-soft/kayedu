"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { PICK_BRANCH, isPickBranch, requireBranchScope, type PickBranch } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { isPairOffered } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import {
  createClassWithNewTeacher,
  createClassWithSessions,
  deactivateClass,
  deleteClass,
  reactivateClass,
  removeSessionsOnHoliday,
  updateClassWithSessions,
  type RepriceReport,
  writeClassSlot,
  type ClassMoneyError,
  type ConflictRefusal,
  type SessionSyncReport,
} from "@/lib/db/class-sessions";
import { claimClassSeat } from "@/lib/db/reservations";
import type { RoomSetError } from "@/lib/db/room-sets";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { describeConflicts } from "@/lib/db/slot-conflicts";
import { scopedData } from "@/lib/db/tenant-scope";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import {
  type ClassPeriodError,
  type ScheduleConflict,
  type WeeklySlotsError,
} from "@/lib/scheduling";
import { redirect } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { blockRemoveSchema, teacherCreateSchema } from "@/lib/validation/people";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  classActiveSchema,
  classBlockCreateSchema,
  classGroupSchema,
  classGroupUpdateSchema,
  classRecordSchema,
  classScheduleDeleteSchema,
  classSlotsSchema,
  classScheduleSchema,
  classScheduleUpdateSchema,
  enrollmentActionSchema,
  enrollmentCreateSchema,
  holidayDeleteSchema,
  slotConfirmationSchema,
  holidaySchema,
  type ClassActionState,
} from "@/lib/validation/classes";
import { boundSearchArgs, parseActionArgs } from "@/lib/validation/action-args";
import { runInTransaction } from "@/lib/db/session-lifecycle";

/**
 * Classes, schedules, enrollment and the holiday calendar (M4). Every action
 * follows docs/02 §7: getTenantContext() → permission check → zod → scoped
 * write → audit if sensitive → revalidate.
 *
 * R4: every write that shapes a class's sessions — create, edit, a weekly
 * slot, deactivate, reactivate, delete — is one call into
 * `lib/db/class-sessions.ts`, which writes the class and its sessions in one
 * transaction and audits both. Conflicts are checked across the class's
 * whole period as ONE decision (R3's contract, docs/02 §11): under DENY the
 * write is refused outright; under WARN it is refused **with the full
 * conflict list** until the person ticks "I understand" (`confirmConflicts`,
 * passed through explicitly), then everything is written and the confirmed
 * conflicts audited. Nothing is ever partly written.
 */

const FORBIDDEN: ClassActionState = { error: "forbidden" };
const NOT_FOUND: ClassActionState = { error: "notFound" };

/** How many conflicts a form is shown — enough to act on, never a wall. */
const MAX_SHOWN_CONFLICTS = 30;

/** A room-set, period or money refusal, attached to the field that caused it. */
function classFieldError(
  error: RoomSetError | ClassPeriodError | WeeklySlotsError | ClassMoneyError,
): ClassActionState {
  if (error === "endBeforeStart" || error === "periodTooLong") {
    return { fieldErrors: { endDate: error } };
  }
  // D-15 / D-17 — the one money rule (lib/money.ts), by direct call too.
  if (error === "invalidPrice") return { fieldErrors: { price: "invalidAmount" } };
  if (error === "invalidPercent" || error === "invalidAmount" || error === "fixedAbovePrice") {
    return { fieldErrors: { shareValue: error } };
  }
  if (
    error === "slotsRequired" ||
    error === "slotOverlap" ||
    error === "invalidDay" ||
    error === "invalidTime" ||
    error === "invalidTimeRange"
  ) {
    return { fieldErrors: { slots: error } };
  }
  if (error === "noPrimary") return { fieldErrors: { roomId: "roomRequired" } };
  if (error === "roomNotFound" || error === "roomInactive") {
    return { fieldErrors: { roomId: error } };
  }
  return { fieldErrors: { extraRoomIds: error } };
}

/**
 * The refusal a conflicting class write returns (R3/R4) — never a generic
 * error: the described conflict list (from the whole period), the policy,
 * and which refusal it is.
 */
async function conflictRefusal(
  ctx: TenantContext,
  refusal: ConflictRefusal,
): Promise<ClassActionState> {
  return {
    error: refusal.error === "conflict" ? "scheduleConflict" : "conflictsNeedConfirmation",
    conflicts: await describeConflicts(
      prisma,
      ctx.center.id,
      refusal.conflicts.slice(0, MAX_SHOWN_CONFLICTS),
    ),
    conflictPolicy: refusal.error === "conflict" ? "DENY" : "WARN",
  };
}

/**
 * What a class write did to its sessions, for the form's success notice —
 * and, for a price edit, how many open sessions took the new price and how
 * many kept theirs (SYS price decision, docs/00 §5.1).
 */
async function sessionsOutcome(
  ctx: TenantContext,
  report: SessionSyncReport | null,
  reprice: RepriceReport | null = null,
): Promise<Pick<ClassActionState, "sessions" | "conflicts">> {
  if (!report && !reprice) return {};
  const priceCounts = reprice
    ? { repriced: reprice.repriced, priceKept: reprice.keptWithPayments + reprice.keptCutAbovePrice }
    : {};
  if (!report) return { sessions: { created: 0, deleted: 0, updated: 0, kept: 0, ...priceCounts } };
  return {
    sessions: {
      created: report.created,
      deleted: report.deleted,
      updated: report.updated,
      kept: report.kept.length,
      ...priceCounts,
    },
    conflicts:
      report.conflicts.length > 0
        ? await describeConflicts(prisma, ctx.center.id, shownConflicts(report.conflicts))
        : undefined,
  };
}

function shownConflicts(conflicts: readonly ScheduleConflict[]): ScheduleConflict[] {
  return conflicts.slice(0, MAX_SHOWN_CONFLICTS);
}

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

/**
 * Candidates for enrolling a student into this class — not already ACTIVE/
 * BLOCKED on it. Bound to `classGroupId` via `.bind(null, classGroup.id)`.
 * Selecting a result re-navigates to this same class page with `?q=<exact
 * student code>`, reusing the existing candidate-rendering (`ClassRoster`)
 * unchanged.
 */
export async function searchEnrollCandidatesAction(
  classGroupId: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await classScope();
  if (isPickBranch(scope)) return [];
  if (!scope) return [];
  const args = parseActionArgs(boundSearchArgs, [classGroupId, query]);
  if (!args) return [];
  const [classId, trimmed] = args;
  if (trimmed.length < 2) return [];

  const enrollments = await scope.db.enrollments.listForClass(classId);
  const excludedStudentIds = new Set(
    enrollments
      .filter((enrollment) => enrollment.status !== "REMOVED")
      .map((enrollment) => enrollment.studentProfileId),
  );

  const rows = await scope.db.students.search({
    where: {
      ...studentSearchWhere(trimmed),
      active: true,
      ...(excludedStudentIds.size > 0
        ? { NOT: { id: { in: [...excludedStudentIds] } } }
        : {}),
    },
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: `${ROUTES.centerClass(classGroupId)}?q=${encodeURIComponent(row.studentCode)}`,
  }));
}

type Scope = { ctx: TenantContext; db: ScopedDb };

async function classScope(): Promise<Scope | PickBranch | null> {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  if (!ctxCan(ctx, "class.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateClassList(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerClasses}`);
}

function revalidateClassDetail(locale: string, classGroupId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerClass(classGroupId)}`);
}

function revalidateStudentDetail(locale: string, studentProfileId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerStudent(studentProfileId)}`);
}

/** Re-resolves a form-supplied foreign key inside the active center. */
async function resolveRef(
  lookup: (id: string) => Promise<{ catalogActive: boolean } | null>,
  id: string | null,
  currentId: string | null = null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (id === null) return { ok: true, id: null };
  const row = await lookup(id);
  if (!row) return { ok: false };
  // An entry the platform has deactivated cannot be newly chosen (R8); a class
  // that already has one keeps it (`currentId`) and can still be saved.
  if (!row.catalogActive && id !== currentId) return { ok: false };
  return { ok: true, id };
}

// ── Class group ─────────────────────────────────────────────────────────────

/**
 * The create form's class half, parsed once for both create actions (R6):
 * the class fields (`classGroupSchema`) and the weekly rows (`classSlotsSchema`
 * — at least one, none overlapping on a weekday). A new teacher has no id yet,
 * so the combined action parses with a placeholder the data layer never sees.
 */
const NEW_TEACHER_PLACEHOLDER_ID = "new-teacher";

function parseNewClass(raw: Record<string, FormDataEntryValue>, teacherPending: boolean) {
  const classResult = classGroupSchema.safeParse(
    teacherPending ? { ...raw, teacherId: NEW_TEACHER_PLACEHOLDER_ID } : raw,
  );
  const slotsResult = classSlotsSchema.safeParse(raw.slots);
  const fieldErrors: Record<string, string> = {};
  if (!classResult.success) Object.assign(fieldErrors, fieldErrorsFrom(classResult.error));
  if (!slotsResult.success) {
    fieldErrors.slots = slotsResult.error.issues[0]?.message ?? "invalidTime";
  }
  if (!classResult.success || !slotsResult.success) {
    return { ok: false as const, fieldErrors };
  }
  return { ok: true as const, data: classResult.data, slots: slotsResult.data };
}

/** The foreign keys a class names, re-resolved inside this centre (docs/02 §5). */
async function resolveClassRefs(
  scope: Scope,
  ids: { subjectId: string | null; gradeId: string | null; educationSystemId: string | null },
): Promise<
  | { ok: true; subjectId: string | null; gradeId: string | null; educationSystemId: string | null }
  | { ok: false; fieldErrors: Record<string, string> }
> {
  const [subject, grade, educationSystem] = await Promise.all([
    resolveRef((id) => scope.db.subjects.findById(id), ids.subjectId),
    resolveRef((id) => scope.db.grades.findById(id), ids.gradeId),
    resolveRef((id) => scope.db.educationSystems.findById(id), ids.educationSystemId),
  ]);
  if (!subject.ok) return { ok: false, fieldErrors: { subjectId: "notFound" } };
  if (!grade.ok) return { ok: false, fieldErrors: { gradeId: "notFound" } };
  if (!educationSystem.ok) return { ok: false, fieldErrors: { educationSystemId: "notFound" } };
  if (!(await pairAllowed(scope, grade.id, subject.id))) {
    return { ok: false, fieldErrors: { subjectId: "subjectNotInGrade" } };
  }
  return { ok: true, subjectId: subject.id, gradeId: grade.id, educationSystemId: educationSystem.id };
}

/**
 * U3 — a class's (grade, subject) pair must be offered here: both picked and
 * active, and linked in the catalog (`isPairOffered`). Checked on create and
 * whenever an edit changes the pair; a pair with no grade or no subject has
 * nothing to check.
 */
async function pairAllowed(scope: Scope, gradeId: string | null, subjectId: string | null): Promise<boolean> {
  if (!gradeId || !subjectId) return true;
  return isPairOffered(prisma, scope.ctx.center.id, gradeId, subjectId);
}

export async function createClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = parseNewClass(Object.fromEntries(formData), false);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const {
    locale,
    teacherId,
    subjectId,
    gradeId,
    educationSystemId,
    roomId,
    extraRoomIds,
    price,
    centerShareType,
    centerShareValue,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    sessionBookingMode,
    maxBookingSeats,
    startDate,
    endDate,
    confirmConflicts,
  } = parsed.data;

  // Every foreign key is re-resolved inside this center — an id from
  // elsewhere (or a stale form) simply does not exist as far as we're
  // concerned (docs/02 §5).
  const teacher = await scope.db.teachers.findByUserId(teacherId);
  if (!teacher) return { fieldErrors: { teacherId: "notFound" } };

  const refs = await resolveClassRefs(scope, { subjectId, gradeId, educationSystemId });
  if (!refs.ok) return { fieldErrors: refs.fieldErrors };

  // R4/R6: the class, its room set (validated there — R3), its weekly rows
  // and every session of its period, in one transaction with one conflict
  // decision.
  const result = await createClassWithSessions(
    prisma,
    scope.ctx.center.id,
    {
      teacherId,
      subjectId: refs.subjectId,
      gradeId: refs.gradeId,
      educationSystemId: refs.educationSystemId,
      roomId,
      extraRoomIds,
      price,
      centerShareType,
      centerShareValue,
      lateThresholdMinutes,
      acceptsNewStudents,
      requiresConfirmation,
      sessionBookingMode,
      maxBookingSeats,
      startDate,
      endDate,
      slots: parsed.slots,
    },
    { confirmConflicts, actorUserId: scope.ctx.user.id, locale },
  );
  if (!result.ok) {
    if ("conflicts" in result) return conflictRefusal(scope.ctx, result);
    return classFieldError(result.error);
  }

  revalidateClassList(locale);
  return { status: "created", ...(await sessionsOutcome(scope.ctx, result.report)) };
}

/**
 * Create a class **and its brand-new teacher** in one go (R6, docs/00 §5.1).
 * One data-layer call (`createClassWithNewTeacher`) runs the teacher, then
 * the class + weekly rows + every session, in ONE transaction — if any part
 * fails nothing is written, and the answer says which part (`part`). Needs
 * both `teacher.manage` and `class.manage`; the data layer checks them again
 * by direct call. The teacher half is the Add teacher form's own schema and
 * the one teacher-creation path, including the "Use this person" match step
 * (`linkUserId`) — a phone that already belongs to someone comes back as a
 * match, never as a second identity.
 */
export async function createClassWithNewTeacherAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope || !ctxCan(scope.ctx, "teacher.manage")) return FORBIDDEN;

  const raw = Object.fromEntries(formData);
  const parsedClass = parseNewClass(raw, true);
  const parsedTeacher = teacherCreateSchema.safeParse(raw);
  if (!parsedClass.ok || !parsedTeacher.success) {
    return {
      ...(parsedClass.ok ? {} : { fieldErrors: parsedClass.fieldErrors }),
      ...(parsedTeacher.success ? {} : { teacherFieldErrors: fieldErrorsFrom(parsedTeacher.error) }),
    };
  }

  const classData = parsedClass.data;
  const refs = await resolveClassRefs(scope, {
    subjectId: classData.subjectId,
    gradeId: classData.gradeId,
    educationSystemId: classData.educationSystemId,
  });
  if (!refs.ok) return { fieldErrors: refs.fieldErrors };

  const { firstName, lastName, email, phone, altPhone, linkUserId, isTrustedTeacher } = parsedTeacher.data;
  const result = await createClassWithNewTeacher(
    prisma,
    scope.ctx.center.id,
    {
      teacher: { firstName, lastName, email, phone, altPhone, locale: classData.locale },
      linkUserId,
      isTrustedTeacher,
      class: {
        subjectId: refs.subjectId,
        gradeId: refs.gradeId,
        educationSystemId: refs.educationSystemId,
        roomId: classData.roomId,
        extraRoomIds: classData.extraRoomIds,
        price: classData.price,
        centerShareType: classData.centerShareType,
        centerShareValue: classData.centerShareValue,
        lateThresholdMinutes: classData.lateThresholdMinutes,
        acceptsNewStudents: classData.acceptsNewStudents,
        requiresConfirmation: classData.requiresConfirmation,
        sessionBookingMode: classData.sessionBookingMode,
        maxBookingSeats: classData.maxBookingSeats,
        startDate: classData.startDate,
        endDate: classData.endDate,
      },
      slots: parsedClass.slots,
    },
    {
      confirmConflicts: classData.confirmConflicts,
      actorUserId: scope.ctx.user.id,
      locale: classData.locale,
      can: (permission) => ctxCan(scope.ctx, permission),
    },
  );

  if (!result.ok) {
    if (result.part === "permission") return FORBIDDEN;
    if (result.part === "teacher") {
      return result.error === "matchFound" && result.match
        ? { status: "matchFound", part: "teacher", match: result.match }
        : { part: "teacher", error: result.error, ...(result.match ? { match: result.match } : {}) };
    }
    if ("conflicts" in result) {
      return {
        part: "class",
        ...(await conflictRefusal(scope.ctx, { ok: false, error: result.error, conflicts: result.conflicts })),
      };
    }
    return { part: "class", ...classFieldError(result.error) };
  }

  revalidateClassList(classData.locale);
  revalidatePath(`/${classData.locale}${ROUTES.centerTeachers}`);
  return { status: "created", ...(await sessionsOutcome(scope.ctx, result.report)) };
}

export async function updateClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = classGroupUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    id,
    teacherId,
    subjectId,
    gradeId,
    educationSystemId,
    roomId,
    extraRoomIds,
    price,
    centerShareType,
    centerShareValue,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    sessionBookingMode,
    maxBookingSeats,
    startDate,
    endDate,
    confirmConflicts,
  } = parsed.data;

  const existing = await scope.db.classGroups.findById(id);
  if (!existing) return NOT_FOUND;

  const teacher = await scope.db.teachers.findByUserId(teacherId);
  if (!teacher) return { fieldErrors: { teacherId: "notFound" } };

  const [subject, grade, educationSystem] = await Promise.all([
    resolveRef((refId) => scope.db.subjects.findById(refId), subjectId, existing.subjectId),
    resolveRef((refId) => scope.db.grades.findById(refId), gradeId, existing.gradeId),
    resolveRef(
      (refId) => scope.db.educationSystems.findById(refId),
      educationSystemId,
      existing.educationSystemId,
    ),
  ]);
  if (!subject.ok) return { fieldErrors: { subjectId: "notFound" } };
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };
  if (!educationSystem.ok) {
    return { fieldErrors: { educationSystemId: "notFound" } };
  }
  // U3: an unchanged pair saves as it is, even if no longer offered.
  const pairChanged = subject.id !== existing.subjectId || grade.id !== existing.gradeId;
  if (pairChanged && !(await pairAllowed(scope, grade.id, subject.id))) {
    return { fieldErrors: { subjectId: "subjectNotInGrade" } };
  }
  // R4: changing the period, teacher or room set resyncs the class's future
  // sessions in the same transaction (resolves OD-9) — pristine ones follow
  // the class, the rest are kept and reported. One conflict decision for the
  // whole period; a refusal rolls the edit back too.
  const result = await updateClassWithSessions(
    prisma,
    scope.ctx.center.id,
    id,
    {
      teacherId,
      subjectId: subject.id,
      gradeId: grade.id,
      educationSystemId: educationSystem.id,
      roomId,
      extraRoomIds,
      price,
      centerShareType,
      centerShareValue,
      lateThresholdMinutes,
      acceptsNewStudents,
      requiresConfirmation,
      sessionBookingMode,
      maxBookingSeats,
      startDate,
      endDate,
    },
    { confirmConflicts, actorUserId: scope.ctx.user.id, locale },
  );
  if (!result.ok) {
    if ("conflicts" in result) return conflictRefusal(scope.ctx, result);
    if (result.error === "notFound") return NOT_FOUND;
    return classFieldError(result.error);
  }

  revalidateClassDetail(locale, id);
  revalidateClassList(locale);
  return { status: "saved", ...(await sessionsOutcome(scope.ctx, result.report, result.reprice)) };
}

export async function setClassActiveAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = classActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, active, locale, confirmConflicts } = parsed.data;
  const existing = await scope.db.classGroups.findById(id);
  if (!existing) return NOT_FOUND;
  if (existing.active === active) return { status: "saved" };

  if (!active) {
    // R4: one transaction — inactive, pristine future sessions deleted, any
    // other future session cancelled (attendance and payments untouched).
    // Enrolments stay ACTIVE so reactivating restores the class.
    const result = await deactivateClass(prisma, scope.ctx.center.id, id, {
      actorUserId: scope.ctx.user.id,
    });
    if (!result.ok) return result.error === "notFound" ? NOT_FOUND : { status: "saved" };
    revalidateClassList(locale);
    revalidateClassDetail(locale, id);
    return {
      status: "saved",
      sessions: { created: 0, deleted: result.deleted, updated: 0, kept: 0, cancelled: result.cancelled },
    };
  }

  // Reactivating regenerates the period's sessions from today — refused once
  // the period has ended (extend the end date first), and under the same
  // whole-range confirmation contract as any other class write.
  const result = await reactivateClass(prisma, scope.ctx.center.id, id, {
    confirmConflicts,
    actorUserId: scope.ctx.user.id,
    locale,
  });
  if (!result.ok) {
    if ("conflicts" in result) return conflictRefusal(scope.ctx, result);
    if (result.error === "notFound") return NOT_FOUND;
    if (result.error === "alreadyActive") return { status: "saved" };
    return { error: "periodEnded" };
  }

  revalidateClassList(locale);
  revalidateClassDetail(locale, id);
  return { status: "saved", ...(await sessionsOutcome(scope.ctx, result.report)) };
}

export async function deleteClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = classRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale } = parsed.data;

  // R4: deletable only if the class never ran — otherwise it can only be
  // deactivated, and the refusal says why (lib/db/class-sessions.ts).
  const result = await deleteClass(prisma, scope.ctx.center.id, id, {
    actorUserId: scope.ctx.user.id,
  });
  if (!result.ok) {
    if (result.error === "notFound") return NOT_FOUND;
    return { error: "classInUse", blockers: result.blockers };
  }

  revalidateClassList(locale);
  // Same fix as deleteStudentAction (M18, docs/00 §7.1): the delete control
  // lives on /classes/[id] itself, so without a redirect the implicit
  // post-action refresh re-fetches the deleted row and 404s.
  redirect({ href: ROUTES.centerClasses, locale });
  return { status: "deleted" };
}

// ── Class schedule (Schedule Builder, docs/04 §9) ──────────────────────────
// R4: adding, moving or removing a weekly slot resyncs the class's future
// sessions in the same transaction (`writeClassSlot`), with one conflict
// decision over the whole period.

async function slotResult(
  scope: Scope,
  locale: string,
  classGroupId: string,
  result: Awaited<ReturnType<typeof writeClassSlot>>,
  status: "created" | "saved" | "deleted",
): Promise<ClassActionState> {
  if (!result.ok) {
    if ("conflicts" in result) return conflictRefusal(scope.ctx, result);
    return NOT_FOUND;
  }
  revalidateClassDetail(locale, classGroupId);
  revalidateClassList(locale);
  return { status, ...(await sessionsOutcome(scope.ctx, result.report)) };
}

export async function createScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const input = Object.fromEntries(formData);
  const parsed = classScheduleSchema.safeParse(input);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, classGroupId, dayOfWeek, startTime, endTime } = parsed.data;
  const confirmConflicts = slotConfirmationSchema.safeParse(input).data?.confirmConflicts ?? false;
  const classGroup = await scope.db.classGroups.findById(classGroupId);
  if (!classGroup) return NOT_FOUND;

  const result = await writeClassSlot(
    prisma,
    scope.ctx.center.id,
    { kind: "add", classGroupId, slot: { dayOfWeek, startTime, endTime } },
    { confirmConflicts, actorUserId: scope.ctx.user.id, locale },
  );
  return slotResult(scope, locale, classGroupId, result, "created");
}

export async function updateScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const input = Object.fromEntries(formData);
  const parsed = classScheduleUpdateSchema.safeParse(input);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, id, classGroupId, dayOfWeek, startTime, endTime } = parsed.data;
  const confirmConflicts = slotConfirmationSchema.safeParse(input).data?.confirmConflicts ?? false;

  const result = await writeClassSlot(
    prisma,
    scope.ctx.center.id,
    { kind: "update", scheduleId: id, classGroupId, slot: { dayOfWeek, startTime, endTime } },
    { confirmConflicts, actorUserId: scope.ctx.user.id, locale },
  );
  return slotResult(scope, locale, classGroupId, result, "saved");
}

export async function removeScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = classScheduleDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale, confirmConflicts } = parsed.data;
  const schedule = await scope.db.classSchedules.findById(id);
  if (!schedule) return NOT_FOUND;

  const result = await writeClassSlot(
    prisma,
    scope.ctx.center.id,
    { kind: "remove", scheduleId: id },
    { confirmConflicts, actorUserId: scope.ctx.user.id, locale },
  );
  return slotResult(scope, locale, schedule.classGroupId, result, "deleted");
}

// ── Enrollment (add / remove / block a student to/from a class) ───────────

export async function enrollStudentAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = enrollmentCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { locale, classGroupId, studentProfileId } = parsed.data;

  const classGroup = await scope.db.classGroups.findById(classGroupId);
  if (!classGroup) return NOT_FOUND;
  // R4: a deactivated class takes no new students — reactivate it first.
  if (!classGroup.active) return { error: "classInactive" };

  const student = await scope.db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  // Blocking (spec §5 "Blocking", M15: both StudentBlock scopes, checked here
  // exactly as at request/approval time) — a student blocked from this class
  // OR from its teacher cannot be enrolled, full stop, staff override or not.
  const [classBlocked, teacherBlocked] = await Promise.all([
    scope.db.studentBlocks.isBlocked("CLASS", classGroupId, student.userId),
    scope.db.studentBlocks.isBlocked("TEACHER", classGroup.teacherId, student.userId),
  ]);
  if (classBlocked || teacherBlocked) {
    return { error: "studentBlocked" };
  }

  if (await scope.db.enrollments.findExisting(classGroupId, studentProfileId)) {
    return { error: "alreadyEnrolled" };
  }

  // Hard-capped by the class's room set — the summed capacity of its primary
  // and extra rooms (M15, revised R3, spec §5.1 "Capacity") — staff cannot
  // manually add past the cap. Enrolments already above a reduced cap stay.
  // SEC-13: the seat is claimed under the class's row lock, in a transaction,
  // through the one function every enrolment path shares (reactivating this
  // pair's removed row, if any, rather than inserting a second one).
  const seat = await runInTransaction(prisma, (tx) =>
    claimClassSeat(tx, scope.ctx.center.id, classGroupId, studentProfileId),
  );
  if (!seat.ok) {
    if (seat.error === "sessionFull") return { error: "sessionFull", errorDate: formatDate(seat.date, locale) };
    return seat.error === "classFull" ? { error: "classFull" } : NOT_FOUND;
  }

  revalidateClassDetail(locale, classGroupId);
  revalidateStudentDetail(locale, studentProfileId);
  return { status: "created" };
}

export async function removeEnrollmentAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = enrollmentActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { enrollmentId, locale } = parsed.data;
  const enrollment = await scope.db.enrollments.findById(enrollmentId);
  if (!enrollment) return NOT_FOUND;

  await scope.db.enrollments.setStatus(enrollmentId, "REMOVED");

  revalidateClassDetail(locale, enrollment.classGroupId);
  revalidateStudentDetail(locale, enrollment.studentProfileId);
  return { status: "deleted" };
}

export async function blockEnrollmentAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = classBlockCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, classGroupId, studentProfileId, reason } = parsed.data;

  const classGroup = await scope.db.classGroups.findById(classGroupId);
  if (!classGroup) return NOT_FOUND;

  const student = await scope.db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  if (
    await scope.db.studentBlocks.isBlocked("CLASS", classGroupId, student.userId)
  ) {
    return { error: "alreadyBlocked" };
  }

  const block = await scope.db.studentBlocks.create({
    scope: "CLASS",
    refId: classGroupId,
    blockedUserId: student.userId,
    reason,
  });

  // If they were on the roster, blocking takes them off it — the block and
  // the enrollment status move together.
  const enrollment = await scope.db.enrollments.findExisting(
    classGroupId,
    studentProfileId,
  );
  if (enrollment && enrollment.status === "ACTIVE") {
    await scope.db.enrollments.setStatus(enrollment.id, "BLOCKED");
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "student.block",
    entityType: "StudentBlock",
    entityId: block.id,
    // D-20: the block's reason stays on the StudentBlock row, not in the audit.
    after: { scope: "CLASS", classGroupId, studentProfileId },
  });

  revalidateClassDetail(locale, classGroupId);
  revalidateStudentDetail(locale, studentProfileId);
  return { status: "created" };
}

export async function unblockEnrollmentAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = blockRemoveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const block = await scope.db.studentBlocks.findById(parsed.data.blockId);
  if (!block || block.scope !== "CLASS") return NOT_FOUND;

  await scope.db.studentBlocks.remove(block.id);

  // Restore the roster row a block put on hold — never a fresh enrollment.
  const student = await scope.db.students.findByUserId(block.blockedUserId);
  if (student) {
    const enrollment = await scope.db.enrollments.findExisting(
      block.refId,
      student.id,
    );
    if (enrollment && enrollment.status === "BLOCKED") {
      await scope.db.enrollments.setStatus(enrollment.id, "ACTIVE");
    }
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "student.unblock",
    entityType: "StudentBlock",
    entityId: block.id,
    before: { scope: "CLASS", classGroupId: block.refId, blockedUserId: block.blockedUserId },
  });

  revalidateClassDetail(parsed.data.locale, block.refId);
  if (student) revalidateStudentDetail(parsed.data.locale, student.id);
  return { status: "deleted" };
}

// ── Holiday calendar ─────────────────────────────────────────────────────

export async function createHolidayAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = holidaySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, date, name } = parsed.data;
  const centerId = scope.ctx.center.id;

  // R4: sessions already exist for whole class periods, so a new holiday
  // also removes that day's pristine sessions (same transaction); sessions
  // with records or custom changes are kept and counted for staff to cancel.
  let outcome: { deleted: number; kept: number };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await tx.holiday.create({ data: scopedData(centerId, { date, name }) });
      return removeSessionsOnHoliday(tx, centerId, date);
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { fieldErrors: { date: "duplicateDate" } };
    }
    throw error;
  }

  revalidateClassList(locale);
  return {
    status: "created",
    sessions: { created: 0, deleted: outcome.deleted, updated: 0, kept: outcome.kept },
  };
}

export async function removeHolidayAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (isPickBranch(scope)) return scope;
  if (!scope) return FORBIDDEN;

  const parsed = holidayDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const holiday = await scope.db.holidays.findById(parsed.data.id);
  if (!holiday) return NOT_FOUND;

  await scope.db.holidays.remove(holiday.id);
  revalidateClassList(parsed.data.locale);
  return { status: "deleted" };
}
