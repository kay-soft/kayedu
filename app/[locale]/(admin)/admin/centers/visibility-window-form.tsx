"use client";

import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { updateCenterVisibilityWindowAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The platform-admin override of a centre's data-visibility window (M19,
 * docs/01-data-model.md §7) — the same `CenterSettings.dataVisibilityDays`
 * column a centre's own `/settings` screen edits (spec §5.1: "per-centre
 * configurable ... AND adjustable by a platform admin"). Widening it here
 * restores full visibility for that centre's staff on their very next
 * request — nothing was ever deleted, so there is nothing to restore.
 */
export function VisibilityWindowForm({
  centerId,
  dataVisibilityDays,
}: {
  centerId: string;
  dataVisibilityDays: number;
}) {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    updateCenterVisibilityWindowAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="center-visibility-days">{t("detail.visibilityLabel")}</Label>
        <Input
          id="center-visibility-days"
          name="dataVisibilityDays"
          type="number"
          inputMode="numeric"
          min={1}
          max={3650}
          dir="ltr"
          defaultValue={dataVisibilityDays}
          aria-invalid={state.fieldErrors?.dataVisibilityDays ? true : undefined}
        />
        {state.fieldErrors?.dataVisibilityDays ? (
          <FieldError>{tErrors(state.fieldErrors.dataVisibilityDays)}</FieldError>
        ) : null}
      </div>

      <SubmitButton className="sm:w-auto">{t("detail.saveVisibility")}</SubmitButton>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("detail.visibilitySaved")}</FormMessage>
      ) : null}
    </form>
  );
}
