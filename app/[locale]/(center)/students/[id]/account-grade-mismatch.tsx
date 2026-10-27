"use client";

import { useLocale, useTranslations } from "next-intl";

import { applyAccountGradeAction } from "@/app/[locale]/(center)/students/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * "Account says: <grade>" beside a student's grade on file (F4, docs/04
 * §11.23) when their own account names a different one, with **Use account
 * grade**. The account grade is the student's statement; the grade on file is
 * this branch's record — they are allowed to differ, and nothing reconciles
 * them silently. Adopting it is one explicit, audited staff action
 * (`student.manage`) that changes this branch's grade only.
 */
export function AccountGradeMismatch({
  studentProfileId,
  accountGrade,
  canAdopt,
}: {
  studentProfileId: string;
  accountGrade: string;
  /** False when this branch does not offer that grade — it cannot be adopted here. */
  canAdopt: boolean;
}) {
  const t = useTranslations("Students.accountGrade");
  const tErrors = useTranslations("People.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(applyAccountGradeAction, IDLE_PEOPLE_STATE);
  useActionFeedback(state, {
    success: tToasts("studentAccountGradeUsed"),
    error: (key) => (tErrors.has(key) ? tErrors(key) : tErrors("generic")),
  });

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge variant="warning">{t("says", { grade: accountGrade })}</Badge>
      {canAdopt ? (
        <form action={formAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="studentProfileId" value={studentProfileId} />
          <SubmitButton variant="outline" className="h-11">
            {t("use")}
          </SubmitButton>
        </form>
      ) : (
        <span className="text-xs text-text-secondary">{t("notOffered")}</span>
      )}
    </span>
  );
}
