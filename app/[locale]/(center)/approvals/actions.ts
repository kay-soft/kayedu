"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { approveAccountClaim, rejectAccountClaim } from "@/lib/db/account-claims";
import { resolveChangeRequest, resolveSessionRequest } from "@/lib/db/approvals";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { confirmReservation, rejectReservation } from "@/lib/db/reservations";
import { confirmBooking, rejectBooking } from "@/lib/db/session-bookings";
import { formatDate } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { describeConflicts } from "@/lib/db/slot-conflicts";
import {
  approvalIdSchema,
  approveSessionRequestSchema,
  type ApprovalsActionState,
} from "@/lib/validation/approvals";
import { runInTransaction } from "@/lib/db/session-lifecycle";

/**
 * The Approvals queue's write path (docs/00-master-product-spec.md §4.1 item
 * 9, closing the gap flagged at M6/M7/M8). Every action here follows docs/02
 * §7: `getTenantContext()` → permission check → zod → scoped write → audit
 * (a status change on a workflow record — CLAUDE.md rule 7) → revalidate.
 *
 * `ChangeRequest`'s status flip (`resolveChangeRequest`) and `Reservation`'s
 * confirm/reject (`confirmReservation`/`rejectReservation`, M8) both take
 * `centerId` directly rather than `ScopedDb` — the same shape as
 * `lib/db/payments.ts`'s `recordPayment`/`voidPayment` — so this file writes
 * the `AuditLog` row itself, exactly like those money actions already do.
 */

const FORBIDDEN: ApprovalsActionState = { error: "forbidden" };

async function approvalsScope(): Promise<TenantContext | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "approvals.manage")) return null;
  return ctx;
}

function revalidateApprovals(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerApprovals}`);
}

export async function approveChangeRequestAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await resolveChangeRequest(prisma, ctx.center.id, id, "APPROVED", ctx.user.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "changeRequest.approve",
    entityType: "ChangeRequest",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "APPROVED" },
  });

  revalidateApprovals(locale);
  return { status: "approved" };
}

export async function declineChangeRequestAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await resolveChangeRequest(prisma, ctx.center.id, id, "DECLINED", ctx.user.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "changeRequest.decline",
    entityType: "ChangeRequest",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "DECLINED" },
  });

  revalidateApprovals(locale);
  return { status: "declined" };
}

export async function approveReservationAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) =>
    confirmReservation(tx, ctx.center.id, id, ctx.user.id),
  );
  if (!result.ok) {
    if (result.error === "sessionFull") return { error: result.error, errorDate: formatDate(result.date, locale) };
    return { error: result.error };
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "reservation.confirm",
    entityType: "Reservation",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "CONFIRMED", enrollmentId: result.enrollment?.id },
  });

  revalidateApprovals(locale);
  return { status: "approved" };
}

export async function declineReservationAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await rejectReservation(prisma, ctx.center.id, id, ctx.user.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "reservation.reject",
    entityType: "Reservation",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "REJECTED" },
  });

  revalidateApprovals(locale);
  return { status: "declined" };
}

// ── Single-session bookings (F6) ────────────────────────────────────────────
// Same gate as a reservation (`approvals.manage`), same shape: confirm
// re-checks blocks, enrolment and the session's seats under its locks; both
// decisions write their audit row in the same transaction
// (`lib/db/session-bookings.ts`). An expired booking (its session started)
// is refused — nothing is written for it.

export async function approveBookingAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) => confirmBooking(tx, ctx.center.id, id, ctx.user.id));
  if (!result.ok) return { error: result.error };

  revalidateApprovals(locale);
  return { status: "approved" };
}

export async function declineBookingAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) => rejectBooking(tx, ctx.center.id, id, ctx.user.id));
  if (!result.ok) return { error: result.error };

  revalidateApprovals(locale);
  return { status: "declined" };
}

// ── ChangeRequest type NEW_SESSION (M10) ────────────────────────────────────
// Unlike NEW_CLASS, accepting immediately creates the `Session` — the
// request's own `ClassGroup` already has its price/cut decided, so there is
// no missing-money problem to defer (see the decision record in
// lib/db/approvals.ts).

export async function approveSessionRequestAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approveSessionRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id, confirmConflicts } = parsed.data;

  // R3: a double-booking is refused with its conflict list — DENY always,
  // WARN until the approver ticks "I understand" (audited by the data layer).
  const policy = ctx.settings?.scheduleConflictPolicy ?? "WARN";
  const result = await resolveSessionRequest(
    prisma,
    ctx.center.id,
    id,
    "APPROVED",
    ctx.user.id,
    policy,
    locale,
    { confirmConflicts, actorUserId: ctx.user.id },
  );
  if (!result.ok) {
    if ("conflicts" in result) {
      return {
        error: result.error,
        conflicts: await describeConflicts(prisma, ctx.center.id, result.conflicts.slice(0, 30)),
        conflictPolicy: policy,
      };
    }
    return { error: result.error };
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "changeRequest.approve",
    entityType: "ChangeRequest",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "APPROVED", sessionId: result.session?.id },
  });

  revalidateApprovals(locale);
  return { status: "approved" };
}

export async function declineSessionRequestAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await resolveSessionRequest(
    prisma,
    ctx.center.id,
    id,
    "DECLINED",
    ctx.user.id,
    ctx.settings?.scheduleConflictPolicy ?? "WARN",
    locale,
    // Declining writes no slot; the flag is required but has nothing to confirm.
    { confirmConflicts: false, actorUserId: ctx.user.id },
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "changeRequest.decline",
    entityType: "ChangeRequest",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "DECLINED" },
  });

  revalidateApprovals(locale);
  return { status: "declined" };
}

// ── Account claims (SEC-2a, D-01) ───────────────────────────────────────────
// A sign-up whose email matches a person this centre created waits here: staff
// approve it with the person in front of them. Both decisions are audited by
// the data layer, inside their own transaction (`lib/db/account-claims.ts`).

export async function approveAccountClaimAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await approveAccountClaim(prisma, {
    claimId: id,
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
  });
  if (!result.ok) return { error: result.error };

  revalidateApprovals(locale);
  return { status: "approved" };
}

export async function declineAccountClaimAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await approvalsScope();
  if (!ctx) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await rejectAccountClaim(prisma, {
    claimId: id,
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
  });
  if (!result.ok) return { error: result.error };

  revalidateApprovals(locale);
  return { status: "declined" };
}
