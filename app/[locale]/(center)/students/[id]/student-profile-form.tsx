"use client";

import { useLocale, useTranslations } from "next-intl";

import { updateStudentAction } from "@/app/[locale]/(center)/students/actions";
import { ContactFields, type ContactValues } from "@/components/center/contact-fields";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import {
  GradeField,
  ParentFields,
  StudentCodeField,
  type GradeOption,
  type StudentValues,
} from "@/components/center/student-fields";
import { FormGroup } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * Edit one student.
 *
 * Name, contact details, grade and parent info are all this **center's own
 * local record** (docs/01-data-model.md §6) — seeded from the global `User`
 * when this center registered the student, then always editable here,
 * independently of any other center, with no lock of any kind. The student
 * code is never edited here — it was assigned once, at registration.
 *
 * R10b: three titled groups (person, grade, parent contact) instead of one
 * run of fields, and Delete lives in the page's danger zone
 * (`DeleteRecordCard`), not beside Save.
 */
export function StudentProfileForm({
  studentProfileId,
  name,
  contact,
  student,
  grades,
  noneLabel,
}: {
  studentProfileId: string;
  name: PersonValues;
  contact: ContactValues;
  student: StudentValues;
  grades: GradeOption[];
  noneLabel: string;
}) {
  const t = useTranslations("Students");
  const tSections = useTranslations("Students.addSections");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    updateStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const idPrefix = `student-${studentProfileId}`;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <FormGroup
        title={tSections("person")}
        description={t("centerSectionDescription")}
      >
        <PersonFields
          idPrefix={idPrefix}
          values={name}
          fieldErrors={state.fieldErrors}
        />
        <ContactFields
          idPrefix={idPrefix}
          values={contact}
          fieldErrors={state.fieldErrors}
        />
      </FormGroup>

      <FormGroup title={tSections("grade")}>
        <div className="grid gap-4 sm:grid-cols-2">
          {student.studentCode ? (
            <StudentCodeField idPrefix={idPrefix} studentCode={student.studentCode} />
          ) : null}
          <GradeField
            idPrefix={idPrefix}
            gradeId={student.gradeId}
            grades={grades}
            fieldErrors={state.fieldErrors}
            noneLabel={noneLabel}
          />
        </div>
      </FormGroup>

      <FormGroup title={tSections("parent")} description={tSections("parentHint")}>
        <ParentFields
          idPrefix={idPrefix}
          values={student}
          fieldErrors={state.fieldErrors}
        />
      </FormGroup>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SubmitButton className="w-full sm:w-auto">
          {tCommon("save")}
        </SubmitButton>
      </div>
    </form>
  );
}
