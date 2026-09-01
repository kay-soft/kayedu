"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import {
  countOtherCenterRelations,
  createPerson,
  deletePersonIfOrphaned,
  describeMatch,
  resolveContact,
  updatePerson,
} from "@/lib/db/identity";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { teacherDeleteBlockers } from "@/lib/db/students";
import { canEditGlobalProfile, fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  blockCreateSchema,
  blockRemoveSchema,
  membershipActionSchema,
  membershipActiveSchema,
  teacherCreateSchema,
  teacherUpdateSchema,
  type PeopleActionState,
} from "@/lib/validation/people";

/**
 * Teachers (M3). Every action follows docs/02 §7: getTenantContext() →
 * permission check → zod → scoped write → audit if sensitive → revalidate.
 *
 * A teacher is a **Membership**, not a user (CLAUDE.md rule 4). Adding one who
 * already exists on the platform links a membership to that person; it never
 * creates a second identity (spec §5), and the match is always shown to staff
 * before it is acted on.
 */

const FORBIDDEN: PeopleActionState = { error: "forbidden" };
const NOT_FOUND: PeopleActionState = { error: "notFound" };

type Scope = { ctx: TenantContext; db: ScopedDb };

async function teacherScope(): Promise<Scope | null> {
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "teacher.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

function revalidateTeachers(locale: string, teacherId?: string): void {
  revalidatePath(`/${locale}${ROUTES.centerTeachers}`);
  if (teacherId) revalidatePath(`/${locale}${ROUTES.centerTeacher(teacherId)}`);
}

/** Both unique columns on User are contact details, so P2002 is a duplicate. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ── Add ────────────────────────────────────────────────────────────────────

export async function createTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = teacherCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    canSeeEarnings,
    linkUserId,
  } = parsed.data;

  const contact = { email, phone };
  const resolution = await resolveContact(contact);

  // The email belongs to one person and the phone to another — merging two
  // identities is a manual, audited admin action (docs/02 §3), not this form.
  if (resolution.kind === "conflict") return { error: "contactConflict" };

  // Nothing matched: create the person, then their membership here.
  if (resolution.kind === "none") {
    if (linkUserId) return { error: "matchGone" };
    try {
      const person = await createPerson({
        firstName,
        lastName,
        email,
        phone,
        altPhone,
        locale,
      });

      const membership = await scope.db.teachers.create({
        userId: person.id,
        role: "TEACHER",
        canSeeEarnings,
        joinedAt: new Date(),
      });

      await writeAuditLog({
        centerId: scope.ctx.center.id,
        actorUserId: scope.ctx.user.id,
        action: "membership.create",
        entityType: "Membership",
        entityId: membership.id,
        after: { role: "TEACHER", via: "teacher.add", linked: false },
      });

      revalidateTeachers(locale);
      return { status: "created" };
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "contactInUse" };
      throw error;
    }
  }

  // Someone matched. Show them before doing anything — "this person already
  // exists", never a silent merge (spec §5).
  const match = await describeMatch(scope.ctx.center.id, resolution.user, contact);
  if (linkUserId !== resolution.user.id) {
    return { status: "matchFound", match };
  }

  if (match.existingHere === "teacher") return { error: "alreadyTeacher" };

  // Re-activating a former teacher is the same membership coming back, not a
  // second one — Membership is unique on (userId, centerId, role).
  const existing = await scope.db.teachers.findByUserId(resolution.user.id);
  if (existing) {
    await scope.db.teachers.update(existing.id, {
      active: true,
      canSeeEarnings,
      joinedAt: existing.joinedAt ?? new Date(),
    });

    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: "membership.activate",
      entityType: "Membership",
      entityId: existing.id,
      before: { active: existing.active },
      after: { active: true, via: "teacher.add", linked: true },
    });

    revalidateTeachers(locale);
    return { status: "created" };
  }

  const membership = await scope.db.teachers.create({
    userId: resolution.user.id,
    role: "TEACHER",
    canSeeEarnings,
    joinedAt: new Date(),
  });

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "membership.create",
    entityType: "Membership",
    entityId: membership.id,
    after: {
      role: "TEACHER",
      via: "teacher.add",
      linked: true,
      matchedOn: match.matchedOn,
    },
  });

  revalidateTeachers(locale);
  return { status: "created" };
}

// ── Edit ───────────────────────────────────────────────────────────────────

export async function updateTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = teacherUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    membershipId,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    canSeeEarnings,
  } = parsed.data;

  const teacher = await scope.db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;

  // Financial visibility is a permission change — always audited (rule 7).
  if (teacher.canSeeEarnings !== canSeeEarnings) {
    await scope.db.teachers.update(teacher.id, { canSeeEarnings });
    await writeAuditLog({
      centerId: scope.ctx.center.id,
      actorUserId: scope.ctx.user.id,
      action: "membership.visibility.change",
      entityType: "Membership",
      entityId: teacher.id,
      before: { canSeeEarnings: teacher.canSeeEarnings },
      after: { canSeeEarnings },
    });
  }

  // Identity is global: this center may only rewrite a person it created and
  // who exists nowhere else (lib/identity.ts). Otherwise the profile fields
  // are read-only here and the form renders them disabled.
  const editable = canEditGlobalProfile({
    authId: teacher.user.authId,
    otherCenterRelations: await countOtherCenterRelations(
      teacher.userId,
      scope.ctx.center.id,
    ),
  });

  if (editable) {
    try {
      await updatePerson(teacher.userId, {
        firstName,
        lastName,
        email,
        phone,
        altPhone,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "contactInUse" };
      throw error;
    }
  }

  revalidateTeachers(locale, teacher.id);
  return { status: "saved" };
}

export async function setTeacherActiveAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const scope = await teacherScope();
  if (!scope) return FORBIDDEN;

  const parsed = membershipActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { membershipId, active, locale } = parsed.data;
  const teacher = await scope.db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;
  if (teacher.active === active) return { status: "saved" };

  await scope.db.teachers.update(teacher.id, {
    active,
    ...(active && !teacher.joinedAt ? { joinedAt: new Date() } : {}),
  });

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: active ? "membership.activate" : "membership.deactivate",
    entityType: "Membership",
    entityId: teacher.id,
    before: { active: teacher.active },
    after: { active },
  });

  revalidateTeachers(locale, teacher.id);
  return { status: "saved" };
}

// ── Delete ─────────────────────────────────────────────────────────────────

export async function deleteTeacherAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
  // Delete is a Manager/Owner action, never a receptionist's (spec §3).
  if (!ctxCan(ctx, "teacher.delete")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = membershipActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { membershipId, locale } = parsed.data;
  const teacher = await db.teachers.findById(membershipId);
  if (!teacher) return NOT_FOUND;

  // A teacher who already carries classes or sessions is deactivated, not
  // deleted — the schedule and its money history must keep resolving.
  if ((await teacherDeleteBlockers(db, teacher.userId)) > 0) {
    return { error: "teacherInUse" };
  }

  await db.teachers.remove(teacher.id);
  // Their block-list here goes with the relationship.
  const blocks = await db.studentBlocks.list({
    scope: "TEACHER",
    refId: teacher.userId,
  });
  for (const block of blocks) await db.studentBlocks.remove(block.id);

  const personDeleted = await deletePersonIfOrphaned(teacher.userId);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "membership.delete",
    entityType: "Membership",
    entityId: teacher.id,
    before: {
      role: "TEACHER",
      userId: teacher.userId,
      name: fullName(teacher.user),
    },
    after: { personDeleted, blocksRemoved: blocks.length },
  });

  revalidateTeachers(locale, teacher.id);
  return { status: "deleted" };
}

// ── Block-list (block a student from this teacher) ─────────────────────────

export async function blockStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "student.block")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = blockCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, teacherUserId, studentProfileId, reason } = parsed.data;

  // Both sides are re-resolved inside this center: a teacher or a student from
  // another center simply does not exist here.
  const teacher = await db.teachers.findByUserId(teacherUserId);
  if (!teacher) return NOT_FOUND;

  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  if (
    await db.studentBlocks.isBlocked("TEACHER", teacherUserId, student.userId)
  ) {
    return { error: "alreadyBlocked" };
  }

  const block = await db.studentBlocks.create({
    scope: "TEACHER",
    refId: teacherUserId,
    blockedUserId: student.userId,
    reason,
  });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.block",
    entityType: "StudentBlock",
    entityId: block.id,
    after: {
      scope: "TEACHER",
      teacherUserId,
      studentProfileId: student.id,
      reason,
    },
  });

  revalidateTeachers(locale, teacher.id);
  return { status: "created" };
}

export async function unblockStudentAction(
  _state: PeopleActionState,
  formData: FormData,
): Promise<PeopleActionState> {
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "student.block")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = blockRemoveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const block = await db.studentBlocks.findById(parsed.data.blockId);
  if (!block) return NOT_FOUND;

  await db.studentBlocks.remove(block.id);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.unblock",
    entityType: "StudentBlock",
    entityId: block.id,
    before: {
      scope: block.scope,
      refId: block.refId,
      blockedUserId: block.blockedUserId,
      reason: block.reason,
    },
  });

  const teacher = await db.teachers.findByUserId(block.refId);
  revalidateTeachers(parsed.data.locale, teacher?.id);
  return { status: "deleted" };
}
