"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { completeStudentProfileAction } from "@/app/[locale]/(student)/student/profile/actions";
import { ContactFields, type ContactValues } from "@/components/center/contact-fields";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import {
  StudentFields,
  type GradeOption,
  type StudentValues,
} from "@/components/center/student-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";

/**
 * The one-time profile-completion form (M18, spec §4.3 item 4): the
 * `(student)` layout renders this in place of every page's own content
 * until the student's auto-seeded profile (`ensureStudentProfile`,
 * `lib/db/reservations.ts` — name/email/phone/altPhone only, no grade, no
 * parent contact) is filled out, exactly once. Reuses the same field
 * components the receptionist's add-student dialog uses — the same fields,
 * filled in by the student themselves, not a second, thinner form.
 */
export function ProfileCompletionForm({
  centerId,
  studentProfileId,
  centerName,
  name,
  contact,
  student,
  grades,
  noneLabel,
}: {
  centerId: string;
  studentProfileId: string;
  centerName: string;
  name: PersonValues;
  contact: ContactValues;
  student: StudentValues;
  grades: GradeOption[];
  noneLabel: string;
}) {
  const t = useTranslations("StudentProfile");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    completeStudentProfileAction,
    IDLE_STUDENT_STATE,
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold text-text-primary">{t("title")}</h1>
        <p className="text-sm text-text-secondary">
          {t("description", { center: centerName })}
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="centerId" value={centerId} />
        <input type="hidden" name="studentProfileId" value={studentProfileId} />

        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        <PersonFields idPrefix="profile" values={name} fieldErrors={state.fieldErrors} />
        <ContactFields idPrefix="profile" values={contact} fieldErrors={state.fieldErrors} />
        <StudentFields
          idPrefix="profile"
          values={student}
          grades={grades}
          fieldErrors={state.fieldErrors}
          noneLabel={noneLabel}
        />

        <SubmitButton className="w-full sm:w-auto">{t("submit")}</SubmitButton>
      </form>
    </div>
  );
}
