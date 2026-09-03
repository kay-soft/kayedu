"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { updateCenterPlanAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Minimal editable UI for `Center.plan` (spec §4.4 "plan/onboarding
 * metadata") — a loose free-text field on the schema, so this stays a single
 * input rather than a billing system (CLAUDE.md rule: stay in scope).
 */
export function PlanForm({ centerId, plan }: { centerId: string; plan: string | null }) {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    updateCenterPlanAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="center-plan">{t("detail.planLabel")}</Label>
        <Input
          id="center-plan"
          name="plan"
          dir="ltr"
          defaultValue={plan ?? ""}
          placeholder={t("detail.planPlaceholder")}
          aria-invalid={state.fieldErrors?.plan ? true : undefined}
        />
        {state.fieldErrors?.plan ? (
          <FieldError>{tErrors(state.fieldErrors.plan)}</FieldError>
        ) : null}
      </div>

      <SubmitButton className="sm:w-auto">{t("detail.savePlan")}</SubmitButton>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("detail.planSaved")}</FormMessage>
      ) : null}
    </form>
  );
}
