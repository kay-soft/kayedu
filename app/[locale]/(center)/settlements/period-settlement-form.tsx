"use client";

import { useLocale, useTranslations } from "next-intl";

import { createPeriodSettlementAction } from "@/app/[locale]/(center)/settlements/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

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
  const [state, formAction] = useGuardedActionState(
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
          <Select
            id="settlement-teacher"
            name="teacherId"
            required
            defaultValue={teachers[0]?.id ?? ""}
            aria-invalid={state.fieldErrors?.teacherId ? true : undefined}
            options={teachers.map((teacher) => ({
              value: teacher.id,
              label: teacher.name,
            }))}
          />
          {state.fieldErrors?.teacherId ? (
            <FieldError>{tErrors(state.fieldErrors.teacherId)}</FieldError>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settlement-from">{t("fields.from")}</Label>
          <DatePicker id="settlement-from" name="from" required />
          {state.fieldErrors?.from ? (
            <FieldError>{tErrors(state.fieldErrors.from)}</FieldError>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settlement-to">{t("fields.to")}</Label>
          <DatePicker id="settlement-to" name="to" required />
          {state.fieldErrors?.to ? (
            <FieldError>{tErrors(state.fieldErrors.to)}</FieldError>
          ) : null}
        </div>
      </div>

      {/* R2: a period settlement counts only payments of sessions that are
          already closed — said here, where the range is chosen. */}
      <p className="text-xs text-text-muted">{t("periodClosedOnlyHint")}</p>

      <SubmitButton className="w-full sm:w-auto">{t("createPeriod")}</SubmitButton>
    </form>
  );
}
