"use server";

import { revalidatePath } from "next/cache";

import { ctxCan } from "@/lib/auth/tenant";
import { branchesInView, teacherActionScope, teacherBranchContext } from "@/lib/auth/teacher-scope";
import { branchPauseRefusal } from "@/lib/db/branch-pauses";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { sessionTimeZone } from "@/lib/db/session-lifecycle";
import { studentSearchWhere } from "@/lib/db/students";
import { taughtByTeacherWhere, teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, dayMarker, startOfSessionDay } from "@/lib/scheduling";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  sessionRequestSchema,
  teacherSessionDescriptionSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";
import { paramsSearchArgs, parseActionArgs } from "@/lib/validation/action-args";

/**
 * Session-description edit only (spec §4.2 item 2). Attendance and payments
 * stay a center-staff action (`app/[locale]/(center)/sessions/actions.ts`) —
 * the teacher portal is read-mostly for sessions.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };
const EDIT_DEADLINE_PASSED: TeacherActionState = { error: "editDeadlinePassed" };

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────
// Narrowed to students this teacher has actually taught — never a branch's
// full roster — exactly like the /teacher/students search. U7: across the
// branches in view (the page's `?branch=` included), one scoped search per
// branch, merged. Selecting a result keeps the query in a "self-navigate"
// href back to this page: `filters.q` becomes the exact student code (and,
// under All branches, `branch` that student's branch), which re-runs
// `teacherSessionListWhere`'s existing narrowing unchanged.
export async function searchOwnSessionStudentsTypeAheadAction(
  currentParams: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const scope = await teacherActionScope();
  if (!scope) return [];
  const args = parseActionArgs(paramsSearchArgs, [currentParams, query]);
  if (!args) return [];
  const [params, trimmed] = args;
  if (trimmed.length < 2) return [];

  const kept = new URLSearchParams(params);
  const several = scope.inView.length > 1;
  const perBranch = await Promise.all(
    branchesInView(scope, kept.get("branch")).map(async (ctx) => {
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
    .map(({ row, branch }) => {
      const params = new URLSearchParams(kept);
      params.set("q", row.studentCode);
      if (several) params.set("branch", branch.id);
      return {
        id: row.id,
        primary: fullName(localName(row, row.user)),
        secondary: several ? `${row.studentCode} · ${branch.name}` : row.studentCode,
        href: `${ROUTES.teacherSessions}?${params.toString()}`,
      };
    });
}

/**
 * U7: the form names the session's branch; it is re-resolved here
 * (`teacherBranchContext`) and the session re-found there, pinned to this
 * teacher — a session at another branch, or another teacher's, is not found.
 */
export async function updateSessionDescriptionAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const parsed = teacherSessionDescriptionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, centerId, sessionId, description } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const db = scoped(ctx);

  const session = await db.sessions.findById(sessionId);
  if (!session || session.teacherId !== ctx.user.id) return NOT_FOUND;

  // The manager-set edit deadline (M10, closing the gap flagged at M5/M7):
  // null means no deadline, the original M7 behavior.
  const deadlineHours = ctx.settings?.teacherEditDeadlineHours ?? null;
  if (deadlineHours !== null) {
    // R7b: the deadline counts hours from the start of the session's day *at
    // the centre* (local midnight), not from UTC midnight — in the session's
    // own frozen timezone (SEC-2b, D-14).
    const dayStart = startOfSessionDay(session.date, sessionTimeZone(session, centreTimeZone(ctx.settings)));
    const deadline = new Date(dayStart.getTime() + deadlineHours * 60 * 60 * 1000);
    if (new Date() > deadline) return EDIT_DEADLINE_PASSED;
  }

  // Pinned to this teacher's own userId as well as the branch — a session
  // belonging to another teacher (even at the same center) matches zero rows
  // here, never gets edited.
  const result = await db.sessions.updateDescription(sessionId, ctx.user.id, description);
  if (result.count === 0) return NOT_FOUND;

  revalidatePath(`/${locale}${ROUTES.teacherSession(sessionId)}`);
  return { status: "saved" };
}

const FORBIDDEN: TeacherActionState = { error: "forbidden" };
const NOT_TRUSTED: TeacherActionState = { error: "notTrusted" };
const REQUEST_NOT_FOUND: TeacherActionState = { error: "notFound" };

/**
 * "Request new session" (spec §4.2 item 2): writes a `ChangeRequest` (type
 * `NEW_SESSION`, M10, closing the gap flagged since M7) for a one-off session
 * on one of the teacher's own classes at one branch — free room/time is a
 * center manager's call at `/approvals`, same as the class request form.
 * Gated on `Membership.isTrustedTeacher` exactly like `createClassRequestAction`.
 * U7: the form's Branch is re-resolved here; its grant and trust are that
 * branch's own.
 */
export async function createSessionRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const parsed = sessionRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, centerId, classGroupId, date, startTime, endTime, note } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "changeRequest.create")) return FORBIDDEN;
  if (!(ctx.membership?.isTrustedTeacher ?? false)) return NOT_TRUSTED;
  const db = scoped(ctx);

  // Only a class this teacher actually teaches at this center — never a
  // client-trusted classGroupId (docs/02 §7).
  const classGroup = await db.classGroups.findById(classGroupId);
  if (!classGroup || classGroup.teacherId !== ctx.user.id) return REQUEST_NOT_FOUND;
  // U5: never a request for a date inside a branch pause (approval re-checks).
  if (await branchPauseRefusal(prisma, ctx.center.id, { date: dayMarker(date) })) {
    return { error: "branchPaused" };
  }

  await db.changeRequests.create({
    type: "NEW_SESSION",
    requestedBy: ctx.user.id,
    payload: { classGroupId, date, startTime, endTime, note },
  });

  revalidatePath(`/${locale}${ROUTES.teacherSessions}`);
  return { status: "created" };
}
