"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteTeacherAction,
  updateTeacherAction,
} from "@/app/[locale]/(center)/teachers/actions";
import { ContactFields, type ContactValues } from "@/components/center/contact-fields";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import { ToggleRow } from "@/components/settings/toggle-row";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Edit one teacher's record at this center.
 *
 * Name and contact details are this **center's own local record**
 * (docs/01-data-model.md §6) — seeded from the global `User` when this center
 * added the teacher, then always editable here, independently of any other
 * center, with no lock of any kind.
 */
export function TeacherProfileForm({
  membershipId,
  name,
  contact,
  isTrustedTeacher,
  canDelete,
}: {
  membershipId: string;
  name: PersonValues;
  contact: ContactValues;
  isTrustedTeacher: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("Teachers");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    updateTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  const [deleteState, deleteFormAction] = useActionState(
    deleteTeacherAction,
    IDLE_PEOPLE_STATE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="membershipId" value={membershipId} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {deleteState.error ? (
        <FormMessage>{tErrors(deleteState.error)}</FormMessage>
      ) : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <SectionHeader
        title={t("contactTitle")}
        description={t("contactDescription")}
      />
      <PersonFields
        idPrefix={`teacher-${membershipId}`}
        values={name}
        fieldErrors={state.fieldErrors}
      />
      <ContactFields
        idPrefix={`teacher-${membershipId}`}
        values={contact}
        fieldErrors={state.fieldErrors}
        atLeastOneRequired
      />

      <ToggleRow
        name="isTrustedTeacher"
        label={t("trusted.label")}
        description={t("trusted.description")}
        defaultChecked={isTrustedTeacher}
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
