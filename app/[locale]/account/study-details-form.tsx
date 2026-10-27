"use client";

import { useLocale, useTranslations } from "next-intl";

import {
  IDLE_STUDY_STATE,
  saveStudyDetailsAction,
} from "@/app/[locale]/account/study-actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { GradePicker } from "@/components/student/grade-picker";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import type { GradePickerData } from "@/lib/student-grade-options";

/**
 * Account → Study details (F4, docs/04 §11.23): the student's own grade. It is
 * the student's statement, not a branch's record — the note under the picker
 * says so, and saving writes `User.gradeId` only.
 */
export function StudyDetailsForm({
  data,
  gradeId,
}: {
  data: GradePickerData;
  gradeId: string;
}) {
  const t = useTranslations("Account.study");
  const tErrors = useTranslations("Account.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(saveStudyDetailsAction, IDLE_STUDY_STATE);
  useActionFeedback(state, { success: t("saved") });
  const errorText = (key: string | undefined) =>
    key ? (tErrors.has(key) ? tErrors(key) : tErrors("failed")) : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}

      <GradePicker
        data={data}
        defaultGradeId={gradeId}
        optional
        idPrefix="study"
        error={errorText(state.fieldErrors?.gradeId)}
      />

      <p className="text-xs text-text-secondary">{t("branchNote")}</p>

      <SubmitButton className="w-full sm:w-fit" pendingLabel={t("saving")}>
        {t("save")}
      </SubmitButton>
    </form>
  );
}
