"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
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

  const profile = await prisma.studentProfile.findFirst({
    where: scopedWhere(centerId, { id: studentProfileId, userId: user.id }),
  });
  if (!profile) return NOT_FOUND;

  if (gradeId) {
    // The picker offers the global catalog directly (docs/01 §2 "Academic
    // catalog layer") — a grade is not centre-scoped, so no CenterCatalog-
    // Selection lookup applies here, unlike a receptionist's own picker.
    const grade = await prisma.catalogGrade.findUnique({ where: { id: gradeId } });
    if (!grade) return { fieldErrors: { gradeId: "notFound" } };
    // A deactivated grade cannot be newly chosen (R8) — only kept, if it is already theirs.
    if (!grade.active && grade.id !== profile.gradeId) return { fieldErrors: { gradeId: "notFound" } };
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

  revalidatePath(`/${locale}${ROUTES.studentProfile}`);
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);

  return { status: "profileCompleted" };
}
