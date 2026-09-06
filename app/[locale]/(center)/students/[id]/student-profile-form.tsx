"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteStudentAction,
  updateStudentAction,
} from "@/app/[locale]/(center)/students/actions";
import { ContactFields, type ContactValues } from "@/components/center/contact-fields";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import {
  StudentFields,
  type GradeOption,
  type StudentValues,
} from "@/components/center/student-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Edit one student.
 *
 * Name, contact details, grade and parent info are all this **center's own
 * local record** (docs/01-data-model.md §6) — seeded from the global `User`
 * when this center registered the student, then always editable here,
 * independently of any other center, with no lock of any kind. The student
 * code is never edited here — it was assigned once, at registration.
 */
export function StudentProfileForm({
  studentProfileId,
  name,
  contact,
  student,
  grades,
  noneLabel,
  canDelete,
}: {
  studentProfileId: string;
  name: PersonValues;
  contact: ContactValues;
  student: StudentValues;
  grades: GradeOption[];
  noneLabel: string;
  canDelete: boolean;
}) {
  const t = useTranslations("Students");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    updateStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const [deleteState, deleteFormAction] = useActionState(
    deleteStudentAction,
    IDLE_PEOPLE_STATE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {deleteState.error ? (
        <FormMessage>{tErrors(deleteState.error)}</FormMessage>
      ) : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <SectionHeader
        title={t("centerSectionTitle")}
        description={t("centerSectionDescription")}
      />
      <PersonFields
        idPrefix={`student-${studentProfileId}`}
        values={name}
        fieldErrors={state.fieldErrors}
      />
      <ContactFields
        idPrefix={`student-${studentProfileId}`}
        values={contact}
        fieldErrors={state.fieldErrors}
      />
      <StudentFields
        idPrefix={`student-${studentProfileId}`}
        values={student}
        grades={grades}
        fieldErrors={state.fieldErrors}
        noneLabel={noneLabel}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SubmitButton className="w-full sm:w-auto">
          {tCommon("save")}
        </SubmitButton>

        {canDelete ? (
          <div className="sm:ms-auto">
            {confirmingDelete ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="text-xs text-text-secondary">
                  {t("deleteConfirm")}
                </span>
                {/* formAction re-targets this one submit — no nested form. */}
                <Button
                  type="submit"
                  variant="destructive"
                  formAction={deleteFormAction}
                  formNoValidate
                  className="h-11 w-full px-4 sm:w-auto"
                >
                  {tCommon("deleteYes")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full px-4 sm:w-auto"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                className="h-11 w-full px-4 sm:w-auto"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-4" />
                {tCommon("delete")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </form>
  );
}
