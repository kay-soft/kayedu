"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createPeriodSettlementAction } from "@/app/[locale]/(center)/settlements/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";

export type SettlementTeacherOption = { id: string; name: string };

/** The period roll-up creation form (spec §5 "Teacher settlements"). */
export function PeriodSettlementForm({
  teachers,
}: {
  teachers: SettlementTeacherOption[];
}) {
  const t = useTranslations("Settlements");
  const tErrors = useTranslations("Settlements.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createPeriodSettlementAction,
    IDLE_SETTLEMENT_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "created" ? (
        <FormMessage tone="success">{t("created")}</FormMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settlement-teacher">{t("fields.teacher")}</Label>
          <select
            id="settlement-teacher"
            name="teacherId"
            required
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
          >
            {teachers.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {teacher.name}
              </option>
            ))}
          </select>
          {state.fieldErrors?.teacherId ? (
            <FieldError>{tErrors(state.fieldErrors.teacherId)}</FieldError>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settlement-from">{t("fields.from")}</Label>
          <Input id="settlement-from" name="from" type="date" required dir="ltr" />
          {state.fieldErrors?.from ? (
            <FieldError>{tErrors(state.fieldErrors.from)}</FieldError>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settlement-to">{t("fields.to")}</Label>
          <Input id="settlement-to" name="to" type="date" required dir="ltr" />
          {state.fieldErrors?.to ? (
            <FieldError>{tErrors(state.fieldErrors.to)}</FieldError>
          ) : null}
        </div>
      </div>

      <SubmitButton className="w-full sm:w-auto">{t("createPeriod")}</SubmitButton>
    </form>
  );
}
