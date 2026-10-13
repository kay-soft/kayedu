"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import {
  createAttendance,
  findAttendee,
  SessionClosedError,
} from "@/lib/db/attendance";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { recordPayment } from "@/lib/db/payments";
import { scoped } from "@/lib/db/scoped";
import { WRITE_TRANSACTION_OPTIONS } from "@/lib/db/session-lifecycle";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import {
  receptionCheckInSchema,
  type SessionActionState,
} from "@/lib/validation/sessions";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";

/**
 * Reception Desk (spec §4.1 item 8): search a student, pick today's session
 * and a payment method, and submit **one** action that checks the student in
 * and — only for PRESENT/LATE, per "attend = pay, or not counted" (spec §2
 * "Financial model", §5 "No debt") — records the payment in the same
 * request. There is no status picker (R2): `createAttendance` decides
 * PRESENT or LATE from the clock and the class's late threshold. A student
 * already on the roster keeps their mark — a correction is the roster's job,
 * live only — and only the payment is attempted. Both writes go through the exact same shared helpers
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

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────
// The QR/scan path bypasses this entirely — a scanned payload resolves
// straight to the selected-student panel via the plain form submit
// (`parseStudentQrPayload`, `app/[locale]/(center)/reception/page.tsx`), not
// through this dropdown.

export async function searchStudentsForReceptionAction(
  query: string,
): Promise<TypeAheadResult[]> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "reception.use")) return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const rows = await scoped(ctx).students.search({
    where: { ...studentSearchWhere(trimmed), active: true },
    take: 8,
  });

  return rows.map((row) => ({
    id: row.id,
    primary: fullName(localName(row, row.user)),
    secondary: row.studentCode,
    href: `${ROUTES.centerReception}?studentId=${row.id}`,
  }));
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
  const { locale, sessionId, studentProfileId, paymentMethodId } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session) return NOT_FOUND;
  const student = await db.students.findById(studentProfileId);
  if (!student) return NOT_FOUND;

  let attendee = await findAttendee(prisma, centerId, sessionId, studentProfileId);

  if (!attendee) {
    if (!ctxCan(ctx, "attendance.record")) return FORBIDDEN;
    // A one-time session (R5) has no class: everyone is a drop-in.
    const enrollment = session.classGroupId
      ? await db.enrollments.findExisting(session.classGroupId, studentProfileId)
      : null;
    const active = enrollment?.status === "ACTIVE";
    try {
      attendee = await createAttendance(prisma, {
        centerId,
        sessionId,
        studentProfileId,
        enrollmentId: active ? enrollment!.id : null,
        isDropIn: !active,
        recordedBy: ctx.user.id,
      });
    } catch (error) {
      // Cancelled, rescheduled or closed session (M15/R2) — refused
      // server-side here too, not just hidden in the Reception UI.
      if (error instanceof SessionClosedError) return { error: error.reason };
      throw error;
    }
  }

  // "Attend = pay, or not counted" — only PRESENT/LATE is ever payable
  // (lib/db/payments.ts `recordPayment` enforces this too, and refuses a
  // closed session on its own; this check just avoids an unnecessary
  // transaction when it plainly cannot apply).
  const payable = attendee.attendanceStatus === "PRESENT" || attendee.attendanceStatus === "LATE";
  if (paymentMethodId && payable) {
    if (!ctxCan(ctx, "payment.record")) return FORBIDDEN;

    const result = await prisma.$transaction(
      (tx) => recordPayment(tx, centerId, attendee.id, paymentMethodId, ctx.user.id),
      WRITE_TRANSACTION_OPTIONS,
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
          paymentMethodId: result.payment.paymentMethodId,
          methodLabelSnapshot: result.payment.methodLabelSnapshot,
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
