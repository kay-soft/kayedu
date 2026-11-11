"use server";

import { revalidatePath } from "next/cache";

import type { PremiumAccountView, PremiumActionState } from "@/app/[locale]/(admin)/admin/teachers/action-state";
import { premiumStatus } from "@/lib/auth/premium";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import {
  extendPremium,
  findPremiumAccountByEmail,
  findPremiumAccountById,
  grantPremium,
  revokePremium,
  type PremiumAccount,
  type PremiumWriteResult,
} from "@/lib/db/premium";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { premiumGrantSchema, premiumLookupSchema, premiumRevokeSchema } from "@/lib/validation/admin";

/**
 * The Teachers page (W6, D-W35): `requirePlatformAdmin()` → zod → the real
 * `lib/db/premium.ts`, which re-checks the admin, the date and the current
 * state, writes, and audits `platform.premium.*` in one transaction.
 * Platform admin only, by nav and by direct call.
 */

function view(account: PremiumAccount, now: Date): PremiumAccountView {
  return {
    userId: account.userId,
    name: fullName(account),
    email: account.email,
    status: premiumStatus(account.premiumUntil, now),
  };
}

/** The account as it is now, for the answer to a refused write. */
async function current(adminId: string, userId: string): Promise<PremiumAccountView | null> {
  const found = await findPremiumAccountById(prisma, { actorUserId: adminId, userId });
  return found.ok && found.account ? view(found.account, new Date()) : null;
}

const DATE_ERRORS = new Set(["invalidDate", "dateInPast", "dateTooFar", "notLater"]);

async function answer(
  adminId: string,
  userId: string,
  locale: string,
  result: PremiumWriteResult,
  status: NonNullable<PremiumActionState["status"]>,
): Promise<PremiumActionState> {
  if (!result.ok) {
    const account = await current(adminId, userId);
    if (DATE_ERRORS.has(result.error)) return { account, fieldErrors: { endDay: result.error } };
    return { account, error: result.error };
  }
  revalidatePath(`/${locale}${ROUTES.adminTeachers}`);
  return { account: view(result.account, new Date()), status };
}

export async function lookupPremiumAccountAction(
  _prevState: PremiumActionState,
  formData: FormData,
): Promise<PremiumActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = premiumLookupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const found = await findPremiumAccountByEmail(prisma, { actorUserId: admin.id, email: parsed.data.email });
  if (!found.ok) return { error: found.error };
  return { account: found.account ? view(found.account, new Date()) : null };
}

export async function grantPremiumAction(
  prevState: PremiumActionState,
  formData: FormData,
): Promise<PremiumActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = premiumGrantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { account: prevState.account, fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, userId, endDay } = parsed.data;
  const result = await grantPremium(prisma, { actorUserId: admin.id, userId, endDay });
  return answer(admin.id, userId, locale, result, "granted");
}

export async function extendPremiumAction(
  prevState: PremiumActionState,
  formData: FormData,
): Promise<PremiumActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = premiumGrantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { account: prevState.account, fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, userId, endDay } = parsed.data;
  const result = await extendPremium(prisma, { actorUserId: admin.id, userId, endDay });
  return answer(admin.id, userId, locale, result, "extended");
}

export async function revokePremiumAction(
  prevState: PremiumActionState,
  formData: FormData,
): Promise<PremiumActionState> {
  const admin = await requirePlatformAdmin();
  const parsed = premiumRevokeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { account: prevState.account, error: "accountNotFound" };
  const { locale, userId } = parsed.data;
  const result = await revokePremium(prisma, { actorUserId: admin.id, userId });
  return answer(admin.id, userId, locale, result, "revoked");
}
