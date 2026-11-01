"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { centerGradeById } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { ACCESSIBLE_LIFECYCLE_STATES } from "@/lib/db/platform";
import { scopedWhere } from "@/lib/db/tenant-scope";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  completeStudentProfileSchema,
  type StudentActionState,
} from "@/lib/validation/student";

const FORBIDDEN: StudentActionState = { error: "forbidden" };
const NOT_FOUND: StudentActionState = { error: "notFound" };

/**
 * The one-time profile-completion form (M18, spec §4.3 item 4): the same
 * fields a receptionist's add-student form collects, filled in by a
 * self-registered student instead of left as the thin stub
 * `ensureStudentProfile` (`lib/db/reservations.ts`) seeds. Never trusts the
 * client-sent `studentProfileId`/`centerId` beyond resolving them against
 * this signed-in user's own row — the same discipline every other
 * student-portal write follows (`lib/db/reservations.ts`).
 */
export async function completeStudentProfileAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = completeStudentProfileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const {
    locale,
    centerId,
    studentProfileId,
    firstName,
    lastName,
    email,
    phone,
    altPhone,
    gradeId,
    parentFirstName,
    parentLastName,
    parentPhone,
    parentAltPhone,
  } = parsed.data;

  // SEC-16: only an active profile at a centre that still admits sign-ins —
  // a deactivated student or a suspended/archived centre is not editable here.
  const profile = await prisma.studentProfile.findFirst({
    where: scopedWhere(centerId, {
      id: studentProfileId,
      userId: user.id,
      active: true,
      // U5: the same rule as `ACCESSIBLE_CENTER` — a deleted branch is not one.
      center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] }, deletedAt: null },
    }),
  });
  if (!profile) return NOT_FOUND;
  // SEC-17 / D-11 (a): strictly one-time. Once the profile is complete (by
  // the student, or by staff at creation) only staff edit it — the layout's
  // gate is not the only thing standing between a student and the parent
  // phone that parent-link origination keys on.
  if (profile.profileCompletedAt) return { error: "alreadyCompleted" };

  if (gradeId) {
    // SEC-49: a grade this centre offers — resolved through its own catalog
    // selection, exactly like the receptionist's picker, never any catalog row.
    const grade = await centerGradeById(prisma, centerId, gradeId);
    if (!grade) return { fieldErrors: { gradeId: "notFound" } };
    // A deactivated grade or selection cannot be newly chosen (R8) — only
    // kept, if it is already theirs.
    if (!(grade.active && grade.catalogActive) && grade.id !== profile.gradeId) {
      return { fieldErrors: { gradeId: "notFound" } };
    }
  }

  await prisma.studentProfile.update({
    where: { id: profile.id },
    data: {
      firstName,
      lastName,
      email,
      phone,
      altPhone,
      gradeId,
      parentFirstName,
      parentLastName,
      parentPhone,
      parentAltPhone,
      profileCompletedAt: new Date(),
    },
  });
  // F3: the parent contact here is this branch's record only — it creates,
  // matches and ends no family link (a link needs a code; docs/00 §5.1).

  revalidatePath(`/${locale}${ROUTES.studentProfile}`);
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);

  return { status: "profileCompleted" };
}
