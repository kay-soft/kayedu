"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteClassAction,
  updateClassAction,
} from "@/app/[locale]/(center)/classes/actions";
import {
  ClassFields,
  type ClassFieldsValues,
  type SelectOption,
} from "@/components/center/class-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

/** Edit a class's own fields — money config, capacity and the enrollment flags. */
export function ClassProfileForm({
  classGroupId,
  values,
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  noneLabel,
  canDelete,
}: {
  classGroupId: string;
  values: ClassFieldsValues;
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: SelectOption[];
  noneLabel: string;
  canDelete: boolean;
}) {
  const t = useTranslations("Classes");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(updateClassAction, IDLE_CLASS_STATE);
  const [deleteState, deleteFormAction] = useActionState(
    deleteClassAction,
    IDLE_CLASS_STATE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={classGroupId} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {deleteState.error ? (
        <FormMessage>{tErrors(deleteState.error)}</FormMessage>
      ) : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <ClassFields
        idPrefix={`class-${classGroupId}`}
        values={values}
        teachers={teachers}
        subjects={subjects}
        grades={grades}
        educationSystems={educationSystems}
        educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
        rooms={rooms}
        noneLabel={noneLabel}
        fieldErrors={state.fieldErrors}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SubmitButton className="w-full sm:w-auto">{tCommon("save")}</SubmitButton>

        {canDelete ? (
          <div className="sm:ms-auto">
            {confirmingDelete ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="text-xs text-text-secondary">
                  {t("deleteConfirm")}
                </span>
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
