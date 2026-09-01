"use client";

import { useActionState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { promoteGradeAction } from "@/app/[locale]/(center)/students/actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { SelectInput } from "@/components/ui/select-input";
import type { GradeOption } from "@/components/center/student-fields";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

/**
 * End-of-term grade promotion (spec §4.1 item 4) — every **active** student in
 * one grade moves to another in a single scoped `updateMany`, and the move is
 * audited. A Manager/Owner action: a receptionist has no `student.promote`.
 */
export function PromoteForm({ grades }: { grades: GradeOption[] }) {
  const t = useTranslations("Students.promote");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    promoteGradeAction,
    IDLE_PEOPLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("done")}</FormMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="promote-from"
          label={t("from")}
          error={
            state.fieldErrors?.fromGradeId
              ? tErrors(state.fieldErrors.fromGradeId)
              : undefined
          }
        >
          <SelectInput id="promote-from" name="fromGradeId" required>
            {grades.map((grade) => (
              <option key={grade.value} value={grade.value}>
                {grade.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id="promote-to"
          label={t("to")}
          error={
            state.fieldErrors?.toGradeId
              ? tErrors(state.fieldErrors.toGradeId)
              : undefined
          }
        >
          <SelectInput id="promote-to" name="toGradeId" required>
            {grades.map((grade) => (
              <option key={grade.value} value={grade.value}>
                {grade.label}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <p className="text-xs text-text-muted">{t("warning")}</p>

      <SubmitButton className="w-full sm:w-auto">
        {/* An arrow that means "moves up a year", not "forward" — it does not
            mirror in RTL (docs/04 §7). */}
        <ArrowUpRight className="size-4" aria-hidden />
        {t("submit")}
      </SubmitButton>
    </form>
  );
}
