"use server";

import { revalidatePath } from "next/cache";

import { ctxCan } from "@/lib/auth/tenant";
import { teacherActionScope, teacherBranchContext } from "@/lib/auth/teacher-scope";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { taughtByTeacherWhere, teacherPortalHistoryFloor, teacherStudentProfileIds } from "@/lib/db/teacher-portal";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  teacherBlockStudentSchema,
  teacherUnblockStudentSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";
import { parseActionArgs, searchArgs } from "@/lib/validation/action-args";

/**
 * Teacher block-list (spec §4.2 items 2/3, reusing the `StudentBlock` scope
 * TEACHER mechanism from M3). Unlike the center-staff version
 * (`app/[locale]/(center)/teachers/actions.ts`), `refId` is never taken from
 * the form — it is always `ctx.user.id`, so a teacher can only ever block a
 * student from *themselves*, never impersonate another teacher's block-list.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────

/** Narrowed to students this teacher has actually taught — never a
 * branch's full roster (same scope `teacherStudentProfileIds` already
 * enforces for the paginated list). U7: across the branches in view, one
 * scoped search per branch, merged; a result names its branch when there
 * are several. */
export async function searchTaughtStudentsTypeAheadAction(
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await teacherActionScope();
  if (!scope) return [];
  const args = parseActionArgs(searchArgs, [query]);
  if (!args) return [];
  const [trimmed] = args;
  if (trimmed.length < 2) return [];

  const several = scope.inView.length > 1;
  const perBranch = await Promise.all(
    scope.inView.map(async (ctx) => {
      // SEC-52: a relational filter, not this teacher's whole roster loaded per keystroke.
      const rows = await scoped(ctx).students.search({
        where: { ...taughtByTeacherWhere(ctx.center.id, ctx.user.id, teacherPortalHistoryFloor(ctx)), ...studentSearchWhere(trimmed) },
        take: 8,
      });
      return rows.map((row) => ({ row, branch: ctx.center }));
    }),
  );

  return perBranch
    .flat()
    .slice(0, 8)
    .map(({ row, branch }) => ({
      id: row.id,
      primary: fullName(localName(row, row.user)),
      secondary: several ? `${row.studentCode} · ${branch.name}` : row.studentCode,
      href: ROUTES.teacherStudent(row.id),
    }));
}

export async function teacherBlockStudentAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const parsed = teacherBlockStudentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, centerId, studentProfileId, reason } = parsed.data;

  // U7: the student's branch, re-resolved — its own `student.block` cell.
  const ctx = await teacherBranchContext(centerId);
  // SEC-15: the matrix's TEACHER `student.block` cell means what it says.
  if (!ctx || !ctxCan(ctx, "student.block")) return { error: "forbidden" };
  const db = scoped(ctx);

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
    after: { scope: "TEACHER", teacherUserId: ctx.user.id, studentProfileId },
  });

  revalidatePath(`/${locale}${ROUTES.teacherStudent(studentProfileId)}`);
  return { status: "created" };
}

export async function teacherUnblockStudentAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const parsed = teacherUnblockStudentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const ctx = await teacherBranchContext(parsed.data.centerId);
  if (!ctx || !ctxCan(ctx, "student.block")) return { error: "forbidden" };
  const db = scoped(ctx);

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
