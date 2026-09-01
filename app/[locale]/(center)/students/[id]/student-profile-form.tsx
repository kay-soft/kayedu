"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteStudentAction,
  updateStudentAction,
} from "@/app/[locale]/(center)/students/actions";
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
 * The person's own name and contact details are **global**: this center may
 * rewrite them only for someone it created who exists nowhere else, otherwise
 * they render read-only (CLAUDE.md rule 4). Grade, ID-card number and parent
 * details belong to this center and are always editable.
 */
export function StudentProfileForm({
  studentProfileId,
  person,
  student,
  grades,
  noneLabel,
  profileEditable,
  canDelete,
}: {
  studentProfileId: string;
  person: PersonValues;
  student: StudentValues;
  grades: GradeOption[];
  noneLabel: string;
  profileEditable: boolean;
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

      {profileEditable ? null : (
        <FormMessage tone="info">{t("profileLocked")}</FormMessage>
      )}

      <PersonFields
        idPrefix={`student-${studentProfileId}`}
        values={person}
        fieldErrors={state.fieldErrors}
        readOnly={!profileEditable}
      />

      {/* Disabled inputs are not submitted; these keep the stored values
          flowing through the action unchanged. */}
      {profileEditable ? null : (
        <>
          <input type="hidden" name="firstName" value={person.firstName ?? ""} />
          <input type="hidden" name="lastName" value={person.lastName ?? ""} />
          <input type="hidden" name="email" value={person.email ?? ""} />
          <input type="hidden" name="phone" value={person.phone ?? ""} />
          <input type="hidden" name="altPhone" value={person.altPhone ?? ""} />
        </>
      )}

      <SectionHeader
        title={t("centerSectionTitle")}
        description={t("centerSectionDescription")}
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
