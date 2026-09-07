"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { ACCESSIBLE_LIFECYCLE_STATES } from "@/lib/db/platform";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  teachAtCenterRequestSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";

/**
 * A teacher with **zero** centres requesting to teach at one (M15, spec §5.1
 * "Teacher onboarding") — the centre-directory counterpart to Discover's
 * `reserveClassAction`. There is no `Membership` yet to resolve a
 * `TenantContext` from, so this writes the `ChangeRequest` directly with an
 * explicit `centerId`, the same "no ctx, no ScopedDb" shape
 * `lib/db/reservations.ts`'s `reserveOrEnroll` already uses for a person's
 * very first connection to a centre. It goes through the **same**
 * `ChangeRequest`/`/approvals` machinery a connected teacher's own
 * `/teacher/classes` request does (`resolveChangeRequest`, a status flip
 * only — a real class still needs a centre to decide price/cut/room, exactly
 * as for any other `NEW_CLASS` request) — never a parallel workflow. No
 * `isTrustedTeacher` gate applies: that flag lives on a `Membership` this
 * person does not have yet.
 */
export async function requestToTeachAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };

  const parsed = teachAtCenterRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, centerId, ...payload } = parsed.data;

  const center = await prisma.center.findFirst({
    where: { id: centerId, lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
  });
  if (!center) return { error: "notFound" };

  await prisma.changeRequest.create({
    data: {
      centerId,
      type: "NEW_CLASS",
      requestedBy: user.id,
      payload,
    },
  });

  revalidatePath(`/${locale}${ROUTES.teacherCenters}`);
  return { status: "created" };
}
