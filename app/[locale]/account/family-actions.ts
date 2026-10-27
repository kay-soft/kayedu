"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request-ip";
import { prisma } from "@/lib/db/client";
import {
  acceptFamilyCode,
  issueStudentInvitation,
  regenerateStudentInvitation,
  revokeFamilyLink,
  revokeStudentInvitation,
} from "@/lib/db/parents";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  acceptFamilyCodeSchema,
  inviteParentSchema,
  studentInvitationSchema,
  unlinkChildSchema,
  type FamilyActionState,
} from "@/lib/validation/parents";

/**
 * Family links from the person's own side (F3): Account → Family and
 * `/family/join`. The acting user is always the session's — never a form
 * field — and every rule (slots, refusals, single use, rate limit, audit) is
 * in `lib/db/parents.ts`. Error keys resolve under `Family.errors`.
 *
 * None of these lives under `app/[locale]/(parent)/`: the parent portal
 * itself stays read-only (`check:parent` sweeps it for "use server").
 */

function revalidateFamily(locale: string) {
  revalidatePath(`/${locale}${ROUTES.account}`);
  revalidatePath(`/${locale}${ROUTES.parentHome}`);
}

/** The student invites a parent: the code is in this answer, and nowhere else. */
export async function inviteParentAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = inviteParentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await issueStudentInvitation(prisma, {
    studentUserId: user.id,
    declaredParentFirstName: parsed.data.parentFirstName,
    declaredParentLastName: parsed.data.parentLastName,
    declaredParentPhone: parsed.data.parentPhone,
  });
  if (!result.ok) return { error: result.error };
  revalidateFamily(parsed.data.locale);
  return { status: "issued", code: result.code };
}

/** "New code" on the student's own pending invitation — the old code stops working. */
export async function regenerateInvitationAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = studentInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await regenerateStudentInvitation(prisma, {
    studentUserId: user.id,
    invitationId: parsed.data.invitationId,
  });
  if (!result.ok) return { error: result.error };
  revalidateFamily(parsed.data.locale);
  return { status: "issued", code: result.code };
}

/** The student cancels their own pending invitation (never an active parent). */
export async function cancelInvitationAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = studentInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await revokeStudentInvitation(prisma, {
    studentUserId: user.id,
    invitationId: parsed.data.invitationId,
  });
  if (!result.ok) return { error: result.error };
  revalidateFamily(parsed.data.locale);
  return { status: "revoked" };
}

/**
 * Accept a code — from `/family/join` (the code came in the URL fragment)
 * or Account → Family "Link another child".
 */
export async function acceptFamilyCodeAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = acceptFamilyCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await acceptFamilyCode(prisma, {
    acceptorUserId: user.id,
    code: parsed.data.code,
    ip: await clientIp(),
  });
  if (!result.ok) return { error: result.error };
  revalidateFamily(parsed.data.locale);
  return { status: "linked" };
}

/** The parent unlinks a child — final; relinking needs a new code. */
export async function unlinkChildAction(
  _state: FamilyActionState,
  formData: FormData,
): Promise<FamilyActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = unlinkChildSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await revokeFamilyLink(prisma, { by: "parent", linkId: parsed.data.linkId, actorUserId: user.id });
  if (!result.ok) return { error: result.error };
  revalidateFamily(parsed.data.locale);
  return { status: "revoked" };
}
