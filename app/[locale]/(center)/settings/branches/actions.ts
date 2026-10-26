"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { addBranchAsOwner } from "@/lib/db/branches";
import { prisma } from "@/lib/db/client";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { addBranchSchema } from "@/lib/validation/branches";

export type AddBranchState = {
  /** Message key under `Settings.branches.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created";
  /** The new branch's name, for the confirmation. */
  branchName?: string;
};

/**
 * An Owner's Add branch (F1, OD-12 (b)). getTenantContext() → the OWNER-only
 * `organization.branch.create` → zod → `addBranchAsOwner`, which re-resolves
 * the actor on its own and does the limit, the provisioning, the copies and
 * the `organization.branch.create` audit row in one transaction. The
 * organization is the acting branch's — never a posted id.
 *
 * The whole locale layout is revalidated: the branch switcher and
 * `/select-center` read the relations fresh on the next request, so the new
 * branch is in both at once.
 */
export async function addBranchAction(
  _state: AddBranchState,
  formData: FormData,
): Promise<AddBranchState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "organization.branch.create")) return { error: "forbidden" };

  const parsed = addBranchSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, ...input } = parsed.data;

  const result = await addBranchAsOwner(prisma, {
    actorUserId: ctx.user.id,
    actingCenterId: ctx.center.id,
    ...input,
  });
  if (!result.ok) {
    return result.error === "sourceNotFound"
      ? { fieldErrors: { copyFromCenterId: result.error } }
      : { error: result.error };
  }

  revalidatePath(`/${locale}`, "layout");
  return { status: "created", branchName: result.center.name };
}
