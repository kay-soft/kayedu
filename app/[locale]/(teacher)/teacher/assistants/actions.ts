"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import {
  createAssistantInvite,
  removeAssistant,
  revokeAssistantInvite,
  updateAssistantPermissions,
} from "@/lib/db/assistants";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  assistantLinkSchema,
  assistantPermissionsSchema,
  createAssistantInviteSchema,
  revokeAssistantInviteSchema,
  type TeacherAssistantActionState,
} from "@/lib/validation/assistants";

/**
 * Teacher → Assistants (W7a, D-W36). The actor is always the session's user,
 * never a form field. Every rule — a teacher, premium now (`requirePremium`),
 * the 5 slots under the teacher's row lock, owning the invite or link, the
 * catalogue, the audit row — is enforced by `lib/db/assistants.ts` inside its
 * own transaction, so a direct call by anyone else (a non-premium teacher,
 * another teacher, centre staff, a student) is refused there with nothing
 * written. Error keys resolve under `Assistants.errors`.
 */

function revalidateAssistants(locale: string) {
  revalidatePath(`/${locale}${ROUTES.teacherAssistants}`);
}

/** Invite an assistant: the code is in this answer, and nowhere else. */
export async function createAssistantInviteAction(
  _state: TeacherAssistantActionState,
  formData: FormData,
): Promise<TeacherAssistantActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = createAssistantInviteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await createAssistantInvite(prisma, { actorUserId: user.id, preset: parsed.data.preset });
  if (!result.ok) return { error: result.error };
  revalidateAssistants(parsed.data.locale);
  return { status: "created", code: result.code, expiresAt: result.expiresAt.toISOString() };
}

/** Revoke one of the teacher's own pending invites. */
export async function revokeAssistantInviteAction(
  _state: TeacherAssistantActionState,
  formData: FormData,
): Promise<TeacherAssistantActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = revokeAssistantInviteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await revokeAssistantInvite(prisma, { actorUserId: user.id, inviteId: parsed.data.inviteId });
  if (!result.ok) return { error: result.error };
  revalidateAssistants(parsed.data.locale);
  return { status: "revoked" };
}

/** A preset, or the toggles, for one of the teacher's own assistants. */
export async function updateAssistantPermissionsAction(
  _state: TeacherAssistantActionState,
  formData: FormData,
): Promise<TeacherAssistantActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = assistantPermissionsSchema.safeParse({
    mode: formData.get("mode"),
    locale: formData.get("locale"),
    linkId: formData.get("linkId"),
    preset: formData.get("preset") ?? undefined,
    permissions: formData.getAll("permission"),
  });
  if (!parsed.success) return { error: "unknownPermission" };

  const result = await updateAssistantPermissions(prisma, {
    actorUserId: user.id,
    linkId: parsed.data.linkId,
    change: parsed.data.mode === "preset" ? { preset: parsed.data.preset } : { permissions: parsed.data.permissions },
  });
  if (!result.ok) return { error: result.error };
  revalidateAssistants(parsed.data.locale);
  return { status: result.changed ? "saved" : "unchanged" };
}

/** Remove an assistant (confirmed in the page). Their experience disappears on their next request. */
export async function removeAssistantAction(
  _state: TeacherAssistantActionState,
  formData: FormData,
): Promise<TeacherAssistantActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = assistantLinkSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const result = await removeAssistant(prisma, { actorUserId: user.id, linkId: parsed.data.linkId });
  if (!result.ok) return { error: result.error };
  revalidateAssistants(parsed.data.locale);
  return { status: "removed" };
}
