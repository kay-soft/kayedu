"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteTeacherAction,
  updateTeacherAction,
} from "@/app/[locale]/(center)/teachers/actions";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Button } from "@/components/ui/button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * Edit one teacher's record at this center.
 *
 * `profileEditable` is false when the person has signed in (they own their
 * account) or belongs to another center too — renaming them here would rename
 * them everywhere, which is exactly what the global-identity model forbids
 * (CLAUDE.md rule 4). The center-owned parts — financial visibility, active
 * status, the block-list — stay editable either way.
 */
export function TeacherProfileForm({
  membershipId,
  values,
  canSeeEarnings,
  profileEditable,
  canDelete,
}: {
  membershipId: string;
  values: PersonValues;
  canSeeEarnings: boolean;
  profileEditable: boolean;
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

      {profileEditable ? null : (
        <FormMessage tone="info">{t("profileLocked")}</FormMessage>
      )}

      <PersonFields
        idPrefix={`teacher-${membershipId}`}
        values={values}
        fieldErrors={state.fieldErrors}
        readOnly={!profileEditable}
      />

      {/* Disabled inputs are not submitted, so the action re-reads the stored
          person instead — the values below still need to reach it. */}
      {profileEditable ? null : (
        <>
          <input type="hidden" name="firstName" value={values.firstName ?? ""} />
          <input type="hidden" name="lastName" value={values.lastName ?? ""} />
          <input type="hidden" name="email" value={values.email ?? ""} />
          <input type="hidden" name="phone" value={values.phone ?? ""} />
          <input type="hidden" name="altPhone" value={values.altPhone ?? ""} />
        </>
      )}

      <ToggleRow
        name="canSeeEarnings"
        label={t("canSeeEarnings")}
        description={t("canSeeEarningsHint")}
        defaultChecked={canSeeEarnings}
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
