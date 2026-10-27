"use server";

import { revalidatePath } from "next/cache";

import { PICK_BRANCH, isPickBranch, requireBranchScope, type PickBranch } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { WRITE_TRANSACTION_OPTIONS } from "@/lib/db/session-lifecycle";
import {
  approveSettlement,
  cancelSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
  type SettlementActor,
} from "@/lib/db/settlements";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  createPeriodSettlementSchema,
  createSessionSettlementSchema,
  settlementIdSchema,
  type SettlementActionState,
} from "@/lib/validation/settlements";

/**
 * Settlement creation and transitions (M14, spec §5 "Teacher settlements").
 * Every action follows docs/02 §7: getTenantContext() → permission check →
 * zod → scoped write → audit → revalidate. Creation and every transition go
 * through `lib/db/settlements.ts` with `centerId` directly, the same shape
 * `lib/db/payments.ts`'s `recordPayment`/`voidPayment` already use; the
 * `AuditLog` row is written on the same transaction (SEC-60), ids and amounts
 * only (D-20).
 *
 * SEC-2b: a settlement **claims** the payments it counts (D-05); a DRAFT may
 * be cancelled, releasing them (D-16); and a non-OWNER may not approve or pay
 * a settlement they created (D-12) — an OWNER may, and that row is audited
 * `selfApproved: true`.
 */

const FORBIDDEN: SettlementActionState = { error: "forbidden" };

async function settlementScope(): Promise<TenantContext | PickBranch | null> {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  if (!ctxCan(ctx, "settlement.manage")) return null;
  return ctx;
}

function revalidateSettlements(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSettlements}`);
}

/** The acting user, and whether they are an OWNER of this centre (D-12). */
function actorOf(ctx: TenantContext): SettlementActor {
  return { userId: ctx.user.id, isOwner: ctx.roles.includes("OWNER") };
}

/** A claim race the advisory lock should make impossible — never a 500. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Object && "code" in error && (error as { code?: string }).code === "P2002";
}

/** The "pay cash right after this session" shape — also called from the session detail page. */
export async function createSessionSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (isPickBranch(ctx)) return ctx;
  if (!ctx) return FORBIDDEN;

  const parsed = createSessionSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, sessionId } = parsed.data;

  let result: Awaited<ReturnType<typeof createSessionSettlement>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const created = await createSessionSettlement(tx, ctx.center.id, sessionId, ctx.user.id);
      if (created.ok) {
        await writeAuditLog(
          {
            centerId: ctx.center.id,
            actorUserId: ctx.user.id,
            action: "settlement.create",
            entityType: "Settlement",
            entityId: created.settlement.id,
            after: {
              teacherId: created.settlement.teacherId,
              sessionId: created.settlement.sessionId,
              totalAmount: created.settlement.totalAmount,
              claimedPayments: created.claimedPayments,
            },
          },
          tx,
        );
      }
      return created;
    }, WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "sessionAlreadySettled" };
    throw error;
  }
  if (!result.ok) return { error: result.error };

  revalidateSettlements(locale);
  revalidatePath(`/${locale}${ROUTES.centerSession(sessionId)}`);
  return { status: "created" };
}

/** The date-range roll-up shape. */
export async function createPeriodSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (isPickBranch(ctx)) return ctx;
  if (!ctx) return FORBIDDEN;

  const parsed = createPeriodSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, teacherId, from, to } = parsed.data;

  // SEC-46: the teacher must be a teacher **of this centre** — a foreign or
  // made-up id is refused before anything is written, never a junk row.
  if (!(await scoped(ctx).teachers.findByUserId(teacherId))) return { error: "notFound" };

  // R2: creating a period settlement first closes every ended session in
  // range (lib/db/settlements.ts), so it gets a longer transaction budget
  // than a single-row write.
  let result: Awaited<ReturnType<typeof createPeriodSettlement>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const created = await createPeriodSettlement(tx, ctx.center.id, teacherId, from, to, ctx.user.id);
      if (created.ok) {
        await writeAuditLog(
          {
            centerId: ctx.center.id,
            actorUserId: ctx.user.id,
            action: "settlement.create",
            entityType: "Settlement",
            entityId: created.settlement.id,
            after: {
              teacherId: created.settlement.teacherId,
              periodFrom: created.settlement.periodFrom,
              periodTo: created.settlement.periodTo,
              totalAmount: created.settlement.totalAmount,
              claimedPayments: created.claimedPayments,
            },
          },
          tx,
        );
      }
      return created;
    }, { ...WRITE_TRANSACTION_OPTIONS, timeout: 30_000 });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "overlappingSettlement" };
    throw error;
  }
  if (!result.ok) {
    if (result.error === "futureRange" || result.error === "rangeTooLong" || result.error === "invalidRange") {
      return { fieldErrors: { to: result.error } };
    }
    return { error: result.error };
  }

  revalidateSettlements(locale);
  return { status: "created" };
}

export async function approveSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (isPickBranch(ctx)) return ctx;
  if (!ctx) return FORBIDDEN;

  const parsed = settlementIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const approved = await approveSettlement(tx, ctx.center.id, id, actorOf(ctx));
    if (approved.ok) {
      await writeAuditLog(
        {
          centerId: ctx.center.id,
          actorUserId: ctx.user.id,
          action: "settlement.approve",
          entityType: "Settlement",
          entityId: id,
          before: { status: "DRAFT" },
          after: { status: "APPROVED", totalAmount: approved.settlement.totalAmount, selfApproved: approved.selfApproved },
        },
        tx,
      );
    }
    return approved;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

  revalidateSettlements(locale);
  return { status: "approved" };
}

export async function paySettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (isPickBranch(ctx)) return ctx;
  if (!ctx) return FORBIDDEN;

  const parsed = settlementIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const paid = await paySettlement(tx, ctx.center.id, id, actorOf(ctx));
    if (paid.ok) {
      await writeAuditLog(
        {
          centerId: ctx.center.id,
          actorUserId: ctx.user.id,
          action: "settlement.pay",
          entityType: "Settlement",
          entityId: id,
          before: { status: "APPROVED" },
          after: { status: "PAID", totalAmount: paid.settlement.totalAmount, selfApproved: paid.selfApproved },
        },
        tx,
      );
    }
    return paid;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

  revalidateSettlements(locale);
  return { status: "paid" };
}

/** DRAFT → CANCELLED (D-16): the draft is kept as a record; its payments are released. */
export async function cancelSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (isPickBranch(ctx)) return ctx;
  if (!ctx) return FORBIDDEN;

  const parsed = settlementIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    const cancelled = await cancelSettlement(tx, ctx.center.id, id, { userId: ctx.user.id });
    if (cancelled.ok) {
      await writeAuditLog(
        {
          centerId: ctx.center.id,
          actorUserId: ctx.user.id,
          action: "settlement.cancel",
          entityType: "Settlement",
          entityId: id,
          before: { status: "DRAFT", totalAmount: cancelled.settlement.totalAmount },
          after: { status: "CANCELLED", releasedClaims: cancelled.releasedClaims },
        },
        tx,
      );
    }
    return cancelled;
  }, WRITE_TRANSACTION_OPTIONS);
  if (!result.ok) return { error: result.error };

  revalidateSettlements(locale);
  return { status: "cancelled" };
}
