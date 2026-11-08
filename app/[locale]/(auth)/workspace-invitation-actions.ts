"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { acceptWorkspaceInvitation, declineWorkspaceInvitation } from "@/lib/db/workspace-students";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { workspaceInvitationResponseSchema, type WorkspaceStudentActionState } from "@/lib/validation/workspace-students";

/**
 * The hub's invitation card (W8b, D-W39 item 7): Confirm and Cancel. The
 * invitation is looked up for the **signed-in** account only, so another
 * account's id — or one already answered, cancelled or from a workspace that
 * is gone — is not-found. Confirming moves the profile to this account in one
 * transaction (`acceptWorkspaceInvitation`) and lands on the student's
 * calendar, where the class now shows; Cancel answers on the card itself.
 */

function revalidateStudentSurfaces(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.selectCenter}`);
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);
  revalidatePath(`/${locale}${ROUTES.studentCalendar}`);
  revalidatePath(`/${locale}`, "layout");
}

export async function acceptWorkspaceInvitationAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };
  const parsed = workspaceInvitationResponseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invitationGone" };
  const result = await acceptWorkspaceInvitation(prisma, user.id, parsed.data.invitationId);
  if (!result.ok) return { error: result.error === "notFound" ? "invitationGone" : result.error };
  revalidateStudentSurfaces(parsed.data.locale);
  redirect({ href: ROUTES.studentCalendar, locale: parsed.data.locale });
  return { status: "accepted" };
}

export async function declineWorkspaceInvitationAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };
  const parsed = workspaceInvitationResponseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invitationGone" };
  const result = await declineWorkspaceInvitation(prisma, user.id, parsed.data.invitationId);
  if (!result.ok) return { error: "invitationGone" };
  // Nothing is revalidated: the card says "Declined" in place (a re-render
  // would drop it), and the card and its notice are gone on the next request.
  return { status: "declined" };
}
