"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  approveSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
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
 * `lib/db/payments.ts`'s `recordPayment`/`voidPayment` already use — this
 * file writes the `AuditLog` row itself, exactly like those money actions.
 */

const FORBIDDEN: SettlementActionState = { error: "forbidden" };

async function settlementScope(): Promise<TenantContext | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "settlement.manage")) return null;
  return ctx;
}

function revalidateSettlements(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.centerSettlements}`);
}

/** The "pay cash right after this session" shape — also called from the session detail page. */
export async function createSessionSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (!ctx) return FORBIDDEN;

  const parsed = createSessionSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, sessionId } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    createSessionSettlement(tx, ctx.center.id, sessionId, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "settlement.create",
    entityType: "Settlement",
    entityId: result.settlement.id,
    after: {
      teacherId: result.settlement.teacherId,
      sessionId: result.settlement.sessionId,
      totalAmount: result.settlement.totalAmount,
    },
  });

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
  if (!ctx) return FORBIDDEN;

  const parsed = createPeriodSettlementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, teacherId, from, to } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, ctx.center.id, teacherId, from, to, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "settlement.create",
    entityType: "Settlement",
    entityId: result.settlement.id,
    after: {
      teacherId: result.settlement.teacherId,
      periodFrom: result.settlement.periodFrom,
      periodTo: result.settlement.periodTo,
      totalAmount: result.settlement.totalAmount,
    },
  });

  revalidateSettlements(locale);
  return { status: "created" };
}

export async function approveSettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (!ctx) return FORBIDDEN;

  const parsed = settlementIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    approveSettlement(tx, ctx.center.id, id, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "settlement.approve",
    entityType: "Settlement",
    entityId: id,
    before: { status: "DRAFT" },
    after: { status: "APPROVED" },
  });

  revalidateSettlements(locale);
  return { status: "approved" };
}

export async function paySettlementAction(
  _state: SettlementActionState,
  formData: FormData,
): Promise<SettlementActionState> {
  const ctx = await settlementScope();
  if (!ctx) return FORBIDDEN;

  const parsed = settlementIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await prisma.$transaction((tx) =>
    paySettlement(tx, ctx.center.id, id, ctx.user.id),
  );
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "settlement.pay",
    entityType: "Settlement",
    entityId: id,
    before: { status: "APPROVED" },
    after: { status: "PAID" },
  });

  revalidateSettlements(locale);
  return { status: "paid" };
}
