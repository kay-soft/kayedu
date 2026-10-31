"use server";

import { revalidatePath } from "next/cache";

import { getUserCenterRelations } from "@/lib/auth/tenant";
import { clientIp } from "@/lib/auth/request-ip";
import { getCurrentUser } from "@/lib/auth/session";
import { isPairLinked } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { ACCESSIBLE_CENTER } from "@/lib/db/platform";
import { checkRateLimits } from "@/lib/rate-limit";
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

  // SEC-25: the directory is for a teacher with zero centres — the page's
  // redirect is not the boundary, so the action refuses one who already
  // teaches somewhere (their own Classes screen is where they ask for more).
  const relations = await getUserCenterRelations(user.id);
  if (relations.some((relation) => relation.roles.includes("TEACHER"))) {
    return { error: "alreadyTeaching" };
  }
  const allowed = await checkRateLimits([
    { name: "teachRequestPerUser", key: user.id },
    { name: "teachRequestPerIp", key: await clientIp() },
  ]);
  if (!allowed) return { error: "rateLimited" };

  const center = await prisma.center.findFirst({
    where: { id: centerId, ...ACCESSIBLE_CENTER },
  });
  if (!center) return { error: "notFound" };

  // The directory form offers only active catalog entries (R8); hold a direct
  // post to the same line — a deactivated or unknown id is "not found".
  if (payload.subjectId) {
    const subject = await prisma.catalogSubject.findFirst({
      where: { id: payload.subjectId, active: true },
      select: { id: true },
    });
    if (!subject) return { fieldErrors: { subjectId: "notFound" } };
  }
  if (payload.gradeId) {
    const grade = await prisma.catalogGrade.findFirst({
      where: { id: payload.gradeId, active: true },
      select: { id: true },
    });
    if (!grade) return { fieldErrors: { gradeId: "notFound" } };
  }
  // U3: the pair must be linked in the catalog. Only the global catalog is
  // checked — this teacher has no relationship with the branch yet, so its
  // picks are not read; the branch decides at approval.
  if (payload.subjectId && payload.gradeId && !(await isPairLinked(prisma, payload.gradeId, payload.subjectId))) {
    return { fieldErrors: { subjectId: "subjectNotInGrade" } };
  }

  // SEC-25: one PENDING request per (requester, centre); serialized per pair,
  // so two parallel posts cannot both pass the check.
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`teach-request:${centerId}:${user.id}`}, 0))`;
    const pending = await tx.changeRequest.findFirst({
      where: { centerId, requestedBy: user.id, type: "NEW_CLASS", status: "PENDING" },
      select: { id: true },
    });
    if (pending) return false;
    await tx.changeRequest.create({
      data: {
        centerId,
        type: "NEW_CLASS",
        requestedBy: user.id,
        payload,
      },
    });
    return true;
  });
  if (!created) return { error: "alreadyRequested" };

  revalidatePath(`/${locale}${ROUTES.teacherCenters}`);
  return { status: "created" };
}
