"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/lib/auth/request-ip";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { leaveAssistantLink, previewAssistantCode, redeemAssistantCode } from "@/lib/db/assistants";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { assistantCodeSchema, assistantLinkSchema, type AssistantJoinState } from "@/lib/validation/assistants";

/**
 * The assistant's own side (W7a, D-W36): `/assistant-join` and Account
 * settings → "Join as an assistant" / Leave. The acting user is always the
 * session's. Redemption is two calls — a preview that writes nothing, then
 * the confirm that links — and every rule (rate limit, one answer for an
 * unusable code, own code, premium teacher, single use, audit) lives in
 * `lib/db/assistants.ts`. Error keys resolve under `Assistants.errors`.
 */

function revalidateAssistant(locale: string) {
  revalidatePath(`/${locale}${ROUTES.account}`);
  revalidatePath(`/${locale}${ROUTES.selectCenter}`);
}

/** Step one: what the code would link — shown for the person to confirm. */
export async function previewAssistantCodeAction(
  _state: AssistantJoinState,
  formData: FormData,
): Promise<AssistantJoinState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = assistantCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await previewAssistantCode(prisma, { userId: user.id, code: parsed.data.code, ip: await clientIp() });
  if (!result.ok) return { error: result.error };
  return {
    status: "preview",
    preview: { teacherName: result.teacherName, preset: result.preset, permissions: result.permissions },
  };
}

/** Step two, only from the confirmation's Confirm: the link. */
export async function redeemAssistantCodeAction(
  _state: AssistantJoinState,
  formData: FormData,
): Promise<AssistantJoinState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = assistantCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await redeemAssistantCode(prisma, { userId: user.id, code: parsed.data.code, ip: await clientIp() });
  if (!result.ok) return { error: result.error };
  revalidateAssistant(parsed.data.locale);
  return { status: "joined", teacherUserId: result.teacherUserId };
}

/** The assistant leaves one of their own links (confirmed on the page). */
export async function leaveAssistantAction(
  _state: AssistantJoinState,
  formData: FormData,
): Promise<AssistantJoinState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = assistantLinkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await leaveAssistantLink(prisma, { actorUserId: user.id, linkId: parsed.data.linkId });
  if (!result.ok) return { error: result.error };
  revalidateAssistant(parsed.data.locale);
  return { status: "left" };
}
