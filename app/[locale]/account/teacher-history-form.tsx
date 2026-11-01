"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { saveTeacherHistoryAction } from "@/app/[locale]/account/teacher-history-actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_TEACHER_HISTORY_DAYS } from "@/lib/db/visibility";
import { cn } from "@/lib/utils";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_TEACHER_HISTORY_STATE } from "@/lib/validation/account";

type Mode = "all" | "days";

/**
 * Account → "History shown in my teacher portal" (U6, docs/04 §11.27): "All"
 * (the default, stored as 0) or a number of days. The teacher's own
 * preference — the note under it says it never changes what a branch sees.
 */
export function TeacherHistoryForm({ teacherHistoryDays }: { teacherHistoryDays: number }) {
  const t = useTranslations("Account.teacherHistory");
  const tErrors = useTranslations("Account.errors");
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>(teacherHistoryDays > 0 ? "days" : "all");
  const [state, formAction] = useGuardedActionState(saveTeacherHistoryAction, IDLE_TEACHER_HISTORY_STATE);
  useActionFeedback(state, { success: t("saved") });
  const errorText = (key: string | undefined) =>
    key ? (tErrors.has(key) ? tErrors(key) : tErrors("failed")) : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text-primary">{t("label")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["all", "days"] as const).map((option) => (
            <label key={option} className="block cursor-pointer">
              <input
                type="radio"
                name="historyMode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex min-h-11 flex-col justify-center rounded-xl border border-border bg-surface px-3 py-2 text-start transition-ui",
                  "hover:border-border-strong hover:bg-surface-hover",
                  "peer-checked:border-brand peer-checked:bg-brand/5 peer-checked:ring-2 peer-checked:ring-brand/20",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40",
                )}
              >
                <span className="text-sm font-semibold text-text-primary">{t(`${option}.label`)}</span>
                <span className="text-xs text-text-secondary">{t(`${option}.hint`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === "days" ? (
        <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-56">
          <Label htmlFor="teacher-history-days">{t("daysLabel")}</Label>
          <Input
            id="teacher-history-days"
            name="historyDays"
            type="number"
            inputMode="numeric"
            dir="ltr"
            min={1}
            max={MAX_TEACHER_HISTORY_DAYS}
            step={1}
            defaultValue={teacherHistoryDays > 0 ? teacherHistoryDays : 30}
            aria-invalid={state.fieldErrors?.historyDays ? true : undefined}
          />
          <p className="text-xs text-text-muted">{t("daysHint", { max: MAX_TEACHER_HISTORY_DAYS })}</p>
          {state.fieldErrors?.historyDays ? <FieldError>{errorText(state.fieldErrors.historyDays)}</FieldError> : null}
        </div>
      ) : null}

      <p className="text-xs text-text-secondary">{t("note")}</p>

      <SubmitButton className="w-full sm:w-fit" pendingLabel={t("saving")}>
        {t("save")}
      </SubmitButton>
    </form>
  );
}
