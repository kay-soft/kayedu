"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { classDeleteBlockers, toExistingScheduleSlots } from "@/lib/db/classes";
import { enrollmentCap, isAtCapacity } from "@/lib/capacity";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { generateSessions } from "@/lib/db/sessions";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { findScheduleConflicts } from "@/lib/scheduling";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { blockRemoveSchema } from "@/lib/validation/people";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  classActiveSchema,
  classBlockCreateSchema,
  classGroupSchema,
  classGroupUpdateSchema,
  classRecordSchema,
  classScheduleDeleteSchema,
  classScheduleSchema,
  classScheduleUpdateSchema,
  enrollmentActionSchema,
  enrollmentCreateSchema,
  generateSessionsSchema,
  holidayDeleteSchema,
  holidaySchema,
  type ClassActionState,
} from "@/lib/validation/classes";

/**
 * Classes, schedules, enrollment, the holiday calendar and the session
 * generator (M4). Every action follows docs/02 §7: getTenantContext() →
 * permission check → zod → scoped write → audit if sensitive → revalidate.
 *
 * Conflict detection (spec §5 "Scheduling") runs at schedule-save time
 * (`lib/scheduling.ts`'s `findScheduleConflicts`, against every *other*
 * class's slots in the center) and again at generation time
 * (`lib/db/sessions.ts`'s `generateSessions`). Whether a conflict is denied or
 * merely surfaced is the center's own `scheduleConflictPolicy` — never
 * hardcoded here.
 */

const FORBIDDEN: ClassActionState = { error: "forbidden" };
const NOT_FOUND: ClassActionState = { error: "notFound" };

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
  if (!scope) return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const enrollments = await scope.db.enrollments.listForClass(classGroupId);
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

async function classScope(): Promise<Scope | null> {
  const ctx = await getTenantContext("center");
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
  lookup: (id: string) => Promise<unknown>,
  id: string | null,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (id === null) return { ok: true, id: null };
  const row = await lookup(id);
  return row ? { ok: true, id } : { ok: false };
}

// ── Class group ─────────────────────────────────────────────────────────────

export async function createClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classGroupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    teacherId,
    subjectId,
    gradeId,
    educationSystemId,
    roomId,
    price,
    centerShareType,
    centerShareValue,
    capacity,
    attendanceRequired,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    allowExcused,
  } = parsed.data;

  // Every foreign key is re-resolved inside this center — an id from
  // elsewhere (or a stale form) simply does not exist as far as we're
  // concerned (docs/02 §5).
  const teacher = await scope.db.teachers.findByUserId(teacherId);
  if (!teacher) return { fieldErrors: { teacherId: "notFound" } };

  const [subject, grade, educationSystem, room] = await Promise.all([
    resolveRef((id) => scope.db.subjects.findById(id), subjectId),
    resolveRef((id) => scope.db.grades.findById(id), gradeId),
    resolveRef((id) => scope.db.educationSystems.findById(id), educationSystemId),
    resolveRef((id) => scope.db.rooms.findById(id), roomId),
  ]);
  if (!subject.ok) return { fieldErrors: { subjectId: "notFound" } };
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };
  if (!educationSystem.ok) {
    return { fieldErrors: { educationSystemId: "notFound" } };
  }
  if (!room.ok) return { fieldErrors: { roomId: "notFound" } };

  const created = await scope.db.classGroups.create({
    teacherId,
    subjectId: subject.id,
    gradeId: grade.id,
    educationSystemId: educationSystem.id,
    roomId: room.id,
    price,
    centerShareType,
    centerShareValue,
    capacity,
    attendanceRequired,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    allowExcused,
  });

  // A class's price and center-cut are money configuration (CLAUDE.md rule 7)
  // — never rewrites recorded payments, but the config change is audited.
  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "classGroup.create",
    entityType: "ClassGroup",
    entityId: created.id,
    after: { price, centerShareType, centerShareValue, teacherId },
  });

  revalidateClassList(locale);
  return { status: "created" };
}

export async function updateClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
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
    price,
    centerShareType,
    centerShareValue,
    capacity,
    attendanceRequired,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    allowExcused,
  } = parsed.data;

  const existing = await scope.db.classGroups.findById(id);
  if (!existing) return NOT_FOUND;

  const teacher = await scope.db.teachers.findByUserId(teacherId);
  if (!teacher) return { fieldErrors: { teacherId: "notFound" } };

  const [subject, grade, educationSystem, room] = await Promise.all([
    resolveRef((refId) => scope.db.subjects.findById(refId), subjectId),
    resolveRef((refId) => scope.db.grades.findById(refId), gradeId),
    resolveRef(
      (refId) => scope.db.educationSystems.findById(refId),
      educationSystemId,
    ),
    resolveRef((refId) => scope.db.rooms.findById(refId), roomId),
  ]);
  if (!subject.ok) return { fieldErrors: { subjectId: "notFound" } };
  if (!grade.ok) return { fieldErrors: { gradeId: "notFound" } };
  if (!educationSystem.ok) {
    return { fieldErrors: { educationSystemId: "notFound" } };
  }
  if (!room.ok) return { fieldErrors: { roomId: "notFound" } };

  await scope.db.classGroups.update(id, {
    teacherId,
    subjectId: subject.id,
    gradeId: grade.id,
    educationSystemId: educationSystem.id,
    roomId: room.id,
    price,
    centerShareType,
    centerShareValue,
    capacity,
    attendanceRequired,
    lateThresholdMinutes,
    acceptsNewStudents,
    requiresConfirmation,
    allowExcused,
  });

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "classGroup.update",
    entityType: "ClassGroup",
    entityId: id,
    before: {
      price: existing.price,
      centerShareType: existing.centerShareType,
      centerShareValue: existing.centerShareValue,
      teacherId: existing.teacherId,
    },
    after: { price, centerShareType, centerShareValue, teacherId },
  });

  revalidateClassDetail(locale, id);
  revalidateClassList(locale);
  return { status: "saved" };
}

export async function setClassActiveAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, active, locale } = parsed.data;
  const existing = await scope.db.classGroups.findById(id);
  if (!existing) return NOT_FOUND;
  if (existing.active === active) return { status: "saved" };

  await scope.db.classGroups.update(id, { active });

  revalidateClassList(locale);
  revalidateClassDetail(locale, id);
  return { status: "saved" };
}

export async function deleteClassAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale } = parsed.data;
  const existing = await scope.db.classGroups.findById(id);
  if (!existing) return NOT_FOUND;

  // Enrollments and generated sessions are append-only history (CLAUDE.md
  // rule 2) — a class that carries either is deactivated, not deleted.
  if ((await classDeleteBlockers(scope.db, id)) > 0) {
    return { error: "classInUse" };
  }

  try {
    await scope.db.classGroups.remove(id);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return { error: "classInUse" };
    }
    throw error;
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "classGroup.delete",
    entityType: "ClassGroup",
    entityId: id,
    before: { teacherId: existing.teacherId, price: existing.price },
  });

  revalidateClassList(locale);
  // Same fix as deleteStudentAction (M18, docs/00 §7.1): the delete control
  // lives on /classes/[id] itself, so without a redirect the implicit
  // post-action refresh re-fetches the deleted row and 404s.
  redirect({ href: ROUTES.centerClasses, locale });
  return { status: "deleted" };
}

// ── Class schedule (Schedule Builder, docs/04 §9) ──────────────────────────

async function checkScheduleConflicts(
  db: ScopedDb,
  ctx: TenantContext,
  locale: string,
  classGroupId: string,
  candidate: { dayOfWeek: number; startTime: string; endTime: string },
): Promise<{ conflicts: { type: "teacher" | "room"; className: string }[]; denied: boolean }> {
  const classGroup = await db.classGroups.findById(classGroupId);
  if (!classGroup) return { conflicts: [], denied: false };

  const existingRows = await db.classSchedules.listForConflictCheck(classGroupId);
  const existing = toExistingScheduleSlots(locale, existingRows);

  const conflicts = findScheduleConflicts(
    {
      dayOfWeek: candidate.dayOfWeek,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
      teacherId: classGroup.teacherId,
      roomId: classGroup.roomId,
    },
    existing,
  );

  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  const denied = conflicts.length > 0 && policy === "DENY";
  return {
    conflicts: conflicts.map((c) => ({ type: c.type, className: c.className })),
    denied,
  };
}

export async function createScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classScheduleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, classGroupId, dayOfWeek, startTime, endTime } = parsed.data;
  const classGroup = await scope.db.classGroups.findById(classGroupId);
  if (!classGroup) return NOT_FOUND;

  const check = await checkScheduleConflicts(scope.db, scope.ctx, locale, classGroupId, {
    dayOfWeek,
    startTime,
    endTime,
  });
  if (check.denied) {
    return { error: "scheduleConflict", conflicts: check.conflicts };
  }

  await scope.db.classSchedules.create({
    classGroupId,
    dayOfWeek,
    startTime,
    endTime,
  });

  revalidateClassDetail(locale, classGroupId);
  return {
    status: "created",
    conflicts: check.conflicts.length > 0 ? check.conflicts : undefined,
  };
}

export async function updateScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classScheduleUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, id, classGroupId, dayOfWeek, startTime, endTime } = parsed.data;
  const schedule = await scope.db.classSchedules.findById(id);
  if (!schedule || schedule.classGroupId !== classGroupId) return NOT_FOUND;

  const check = await checkScheduleConflicts(scope.db, scope.ctx, locale, classGroupId, {
    dayOfWeek,
    startTime,
    endTime,
  });
  if (check.denied) {
    return { error: "scheduleConflict", conflicts: check.conflicts };
  }

  await scope.db.classSchedules.update(id, { dayOfWeek, startTime, endTime });

  revalidateClassDetail(locale, classGroupId);
  return {
    status: "saved",
    conflicts: check.conflicts.length > 0 ? check.conflicts : undefined,
  };
}

export async function removeScheduleAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = classScheduleDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { id, locale } = parsed.data;
  const schedule = await scope.db.classSchedules.findById(id);
  if (!schedule) return NOT_FOUND;

  await scope.db.classSchedules.remove(id);
  revalidateClassDetail(locale, schedule.classGroupId);
  return { status: "deleted" };
}

// ── Enrollment (add / remove / block a student to/from a class) ───────────

export async function enrollStudentAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = enrollmentCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { locale, classGroupId, studentProfileId } = parsed.data;

  const classGroup = await scope.db.classGroups.findById(classGroupId);
  if (!classGroup) return NOT_FOUND;

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

  // Hard-capped by the room, not just the class's own configured target
  // (M15, spec §5.1 "Capacity") — staff cannot manually add past the cap.
  const room = classGroup.roomId ? await scope.db.rooms.findById(classGroup.roomId) : null;
  const cap = enrollmentCap(classGroup.capacity, room?.capacity);
  const active = await scope.db.enrollments.countActive(classGroupId);
  if (isAtCapacity(active, cap)) return { error: "classFull" };

  // @@unique([studentProfileId, classGroupId]) means a previously removed
  // enrollment still owns this pair's row — reactivate it instead of
  // inserting a second one, which would violate the unique constraint.
  const existing = await scope.db.enrollments.findAny(classGroupId, studentProfileId);
  if (existing) {
    await scope.db.enrollments.reactivate(existing.id);
  } else {
    await scope.db.enrollments.create({
      classGroupId,
      studentProfileId,
      status: "ACTIVE",
    });
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
    after: { scope: "CLASS", classGroupId, studentProfileId, reason },
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
    before: { scope: "CLASS", classGroupId: block.refId, reason: block.reason },
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
  if (!scope) return FORBIDDEN;

  const parsed = holidaySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, date, name } = parsed.data;

  try {
    await scope.db.holidays.create({ date, name });
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
  return { status: "created" };
}

export async function removeHolidayAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const scope = await classScope();
  if (!scope) return FORBIDDEN;

  const parsed = holidayDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const holiday = await scope.db.holidays.findById(parsed.data.id);
  if (!holiday) return NOT_FOUND;

  await scope.db.holidays.remove(holiday.id);
  revalidateClassList(parsed.data.locale);
  return { status: "deleted" };
}

// ── Session generation ──────────────────────────────────────────────────

export async function generateSessionsAction(
  _state: ClassActionState,
  formData: FormData,
): Promise<ClassActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "session.manage")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = generateSessionsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { locale, classGroupId } = parsed.data;

  if (classGroupId) {
    const classGroup = await db.classGroups.findById(classGroupId);
    if (!classGroup) return NOT_FOUND;
  }

  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  const result = await generateSessions(
    prisma,
    ctx.center.id,
    policy,
    classGroupId ?? undefined,
    locale,
  );

  if (classGroupId) revalidateClassDetail(locale, classGroupId);
  else revalidateClassList(locale);

  return {
    status: "generated",
    generated: { created: result.created, conflicts: result.conflicts.length },
    conflicts:
      result.conflicts.length > 0
        ? result.conflicts.map((c) => ({ type: c.type, className: c.className }))
        : undefined,
  };
}
