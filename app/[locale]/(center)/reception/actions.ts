"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import {
  createAttendance,
  findAttendee,
  SessionClosedError,
  updateAttendanceStatus,
} from "@/lib/db/attendance";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { recordPayment } from "@/lib/db/payments";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import {
  receptionCheckInSchema,
  type SessionActionState,
} from "@/lib/validation/sessions";

/**
 * Reception Desk (spec §4.1 item 8): search a student, pick today's session,
 * attendance status and payment method, and submit **one** action that marks
 * attendance and — only for PRESENT/LATE, per "attend = pay, or not counted"
 * (spec §2 "Financial model", §5 "No debt") — records the payment in the
 * same request. Both writes go through the exact same shared helpers
 * `app/[locale]/(center)/sessions/actions.ts` uses
 * (`lib/db/attendance.ts`, `lib/db/payments.ts`), so there is one attendance
 * write path and one money write path in the whole app, not two.
 */

const FORBIDDEN: SessionActionState = { error: "forbidden" };
const NOT_FOUND: SessionActionState = { error: "notFound" };

function revalidateReception(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerReception}`);
}

function revalidateAffectedSession(locale: string, sessionId: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSession(sessionId)}`);
  revalidatePath(`/${locale}${ROUTES.centerSessions}`);
}

export async function checkInAction(
  _state: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "reception.use")) return FORBIDDEN;
  const db = scoped(ctx);
  const centerId = ctx.center.id;

  const parsed = receptionCheckInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, sessionId, studentProfileId, status, method } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;
  if (status === "EXCUSED") {
    const classGroup = await db.classGroups.findById(session.classGroupId);
    if (!(classGroup?.allowExcused ?? true)) return { error: "excusedNotAllowed" };
  }

  const existing = await findAttendee(prisma, centerId, sessionId, studentProfileId);
  let attendeeId: string;

  try {
    if (existing) {
      if (existing.attendanceStatus !== status) {
        if (!ctxCan(ctx, "attendance.correct")) return FORBIDDEN;
        const before = existing.attendanceStatus;
        await updateAttendanceStatus(prisma, existing, status, ctx.user.id);
        await writeAuditLog({
          centerId,
          actorUserId: ctx.user.id,
          action: "attendance.correct",
          entityType: "SessionAttendee",
          entityId: existing.id,
          before: { attendanceStatus: before },
          after: { attendanceStatus: status },
        });
      }
      attendeeId = existing.id;
    } else {
      if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;
      const enrollment = await db.enrollments.findExisting(
        session.classGroupId,
        studentProfileId,
      );
      const active = enrollment?.status === "ACTIVE";
      const created = await createAttendance(prisma, {
        centerId,
        sessionId,
        studentProfileId,
        enrollmentId: active ? enrollment!.id : null,
        isDropIn: !active,
        status,
        recordedBy: ctx.user.id,
      });
      attendeeId = created.id;
    }
  } catch (error) {
    // Cancelled or already-rescheduled session (M15, spec §7 criterion 17) —
    // refused server-side here too, not just hidden in the Reception UI.
    if (error instanceof SessionClosedError) return { error: error.reason };
    throw error;
  }

  // "Attend = pay, or not counted" — only PRESENT/LATE is ever payable
  // (lib/db/payments.ts `recordPayment` enforces this too; this check just
  // avoids an unnecessary transaction when it plainly cannot apply).
  if (method && (status === "PRESENT" || status === "LATE")) {
    if (!ctxCan(ctx, "payment.record")) return FORBIDDEN;

    const result = await prisma.$transaction((tx) =>
      recordPayment(tx, centerId, attendeeId, method, ctx.user.id),
    );

    if (result.ok) {
      await writeAuditLog({
        centerId,
        actorUserId: ctx.user.id,
        action: "payment.record",
        entityType: "Payment",
        entityId: result.payment.id,
        after: {
          amount: result.payment.amount,
          method: result.payment.method,
          centerShareSnapshot: result.payment.centerShareSnapshot,
          teacherShareSnapshot: result.payment.teacherShareSnapshot,
        },
      });
    } else if (result.error !== "alreadyPaid") {
      // "alreadyPaid" is fine to swallow — the check-in itself still
      // succeeded, they simply already have an active payment on file.
      revalidateReception(locale);
      revalidateAffectedSession(locale, sessionId);
      return { error: result.error };
    }
  }

  revalidateReception(locale);
  revalidateAffectedSession(locale, sessionId);
  return { status: "saved" };
}
