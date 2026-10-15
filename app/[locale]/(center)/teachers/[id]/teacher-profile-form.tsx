"use client";

import { useLocale, useTranslations } from "next-intl";

import { updateTeacherAction } from "@/app/[locale]/(center)/teachers/actions";
import { ContactFields, type ContactValues } from "@/components/center/contact-fields";
import { PersonFields, type PersonValues } from "@/components/center/person-fields";
import { ToggleRow } from "@/components/settings/toggle-row";
import { FormGroup } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * Edit one teacher's record at this center.
 *
 * Name and contact details are this **center's own local record**
 * (docs/01-data-model.md §6) — seeded from the global `User` when this center
 * added the teacher, then always editable here, independently of any other
 * center, with no lock of any kind.
 *
 * R10b: the person's details and the branch's own setting (trusted teacher)
 * are two titled groups of the one form, saved together by the one Save; the
 * Delete control moved to the page's danger zone (`DeleteRecordCard`).
 */
export function TeacherProfileForm({
  membershipId,
  name,
  contact,
  isTrustedTeacher,
}: {
  membershipId: string;
  name: PersonValues;
  contact: ContactValues;
  isTrustedTeacher: boolean;
}) {
  const t = useTranslations("Teachers");
  const tSections = useTranslations("Teachers.addSections");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    updateTeacherAction,
    IDLE_PEOPLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="membershipId" value={membershipId} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <FormGroup
        title={tSections("person")}
        description={t("contactDescription")}
      >
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
      </FormGroup>

      <FormGroup title={t("settingsTitle")}>
        <ToggleRow
          name="isTrustedTeacher"
          label={t("trusted.label")}
          description={t("trusted.description")}
          defaultChecked={isTrustedTeacher}
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
