"use server";

import { revalidatePath } from "next/cache";

import { getTenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { teacherStudentProfileIds } from "@/lib/db/teacher-portal";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  teacherBlockStudentSchema,
  teacherUnblockStudentSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";

/**
 * Teacher block-list (spec §4.2 items 2/3, reusing the `StudentBlock` scope
 * TEACHER mechanism from M3). Unlike the center-staff version
 * (`app/[locale]/(center)/teachers/actions.ts`), `refId` is never taken from
 * the form — it is always `ctx.user.id`, so a teacher can only ever block a
 * student from *themselves*, never impersonate another teacher's block-list.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };

export async function teacherBlockStudentAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  const db = scoped(ctx);

  const parsed = teacherBlockStudentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, studentProfileId, reason } = parsed.data;

  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  // Only a student this teacher has actually taught can be blocked from
  // here — this screen is reached from that student's own detail page.
  const taughtIds = await teacherStudentProfileIds(prisma, ctx.center.id, ctx.user.id);
  if (!taughtIds.includes(studentProfileId)) return NOT_FOUND;

  if (await db.studentBlocks.isBlocked("TEACHER", ctx.user.id, student.userId)) {
    return { error: "alreadyBlocked" };
  }

  const block = await db.studentBlocks.create({
    scope: "TEACHER",
    refId: ctx.user.id,
    blockedUserId: student.userId,
    reason,
  });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.block",
    entityType: "StudentBlock",
    entityId: block.id,
    after: { scope: "TEACHER", teacherUserId: ctx.user.id, studentProfileId, reason },
  });

  revalidatePath(`/${locale}${ROUTES.teacherStudent(studentProfileId)}`);
  return { status: "created" };
}

export async function teacherUnblockStudentAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  const db = scoped(ctx);

  const parsed = teacherUnblockStudentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const block = await db.studentBlocks.findById(parsed.data.blockId);
  // Only this teacher's own block-list rows — never another teacher's.
  if (!block || block.scope !== "TEACHER" || block.refId !== ctx.user.id) return NOT_FOUND;

  await db.studentBlocks.remove(block.id);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "student.unblock",
    entityType: "StudentBlock",
    entityId: block.id,
    before: { scope: block.scope, refId: block.refId, blockedUserId: block.blockedUserId },
  });

  const student = await db.students.list({ userId: block.blockedUserId });
  if (student[0]) {
    revalidatePath(`/${parsed.data.locale}${ROUTES.teacherStudent(student[0].id)}`);
  }

  return { status: "deleted" };
}
