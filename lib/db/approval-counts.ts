import type { PrismaClient } from "@prisma/client";
// Relative imports and an injected client, like `scoped.ts`: `npm run
// check:approvals` calls these directly, outside the Next.js runtime.
import { countPendingClaimsForCenter } from "./account-claims.ts";
import { prisma as sharedClient } from "./client.ts";
import { scopedWith, type ScopeContext } from "./scoped.ts";

/**
 * How many requests wait at this branch, by kind (F7) — the one source the
 * Approvals tabs and the sidebar badge both read, so the number on a tab, the
 * number on the badge and the rows in the queue cannot disagree. Each figure
 * is a centre-scoped count over exactly the `where` its queue lists with
 * (`lib/db/scoped.ts`); the branch's counts are never summed across centres.
 */
export type PendingApprovalCounts = {
  classRequests: number;
  sessionRequests: number;
  enrolments: number;
  bookings: number;
  accountClaims: number;
  total: number;
};

/** The branch's `/approvals` (permission `approvals.manage`). */
export async function pendingApprovalCounts(
  ctx: ScopeContext,
  client: PrismaClient = sharedClient,
  options: { now?: Date } = {},
): Promise<PendingApprovalCounts> {
  const db = scopedWith(client, ctx);
  const [byType, enrolments, bookings, accountClaims] = await Promise.all([
    db.changeRequests.countPendingByType(),
    db.reservations.countPending(),
    db.sessionBookings.countPending({ now: options.now }),
    countPendingClaimsForCenter(client, ctx.center.id),
  ]);
  return {
    classRequests: byType.newClass,
    sessionRequests: byType.newSession,
    enrolments,
    bookings,
    accountClaims,
    total: byType.newClass + byType.newSession + enrolments + bookings + accountClaims,
  };
}

export type PendingTeacherApprovalCounts = {
  enrolments: number;
  bookings: number;
  total: number;
};

/**
 * A teacher's own queue (`reservation.manage.own`): pinned to the classes
 * `teacherUserId` teaches — never another teacher's, never a class request or
 * an account claim, which are the branch's decisions.
 */
export async function pendingTeacherApprovalCounts(
  ctx: ScopeContext,
  teacherUserId: string,
  client: PrismaClient = sharedClient,
  options: { now?: Date } = {},
): Promise<PendingTeacherApprovalCounts> {
  const db = scopedWith(client, ctx);
  const [enrolments, bookings] = await Promise.all([
    db.reservations.countPendingForTeacher(teacherUserId),
    db.sessionBookings.countPending({ teacherId: teacherUserId, now: options.now }),
  ]);
  return { enrolments, bookings, total: enrolments + bookings };
}
