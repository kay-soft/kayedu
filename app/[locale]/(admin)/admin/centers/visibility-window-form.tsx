"use client";

import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { updateCenterVisibilityWindowAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_CENTER_VISIBILITY_DAYS, MAX_TEACHER_VISIBILITY_DAYS } from "@/lib/db/visibility";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The platform-admin override of a branch's two data-visibility windows
 * (M19, U6, docs/01-data-model.md §7) — the same `CenterSettings.
 * centerDataVisibilityDays`/`teacherDataVisibilityDays` columns a branch's
 * own `/settings` screen edits, under the same caps (spec §5.1: "per-centre
 * configurable ... AND adjustable by a platform admin"). Widening one here
 * restores visibility for that branch's staff on their very next request —
 * nothing was ever deleted, so there is nothing to restore.
 */
export function VisibilityWindowForm({
  centerId,
  centerDataVisibilityDays,
  teacherDataVisibilityDays,
}: {
  centerId: string;
  centerDataVisibilityDays: number;
  teacherDataVisibilityDays: number;
}) {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    updateCenterVisibilityWindowAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  const fields = [
    ["centerDataVisibilityDays", centerDataVisibilityDays, MAX_CENTER_VISIBILITY_DAYS, "visibilityCenter"],
    ["teacherDataVisibilityDays", teacherDataVisibilityDays, MAX_TEACHER_VISIBILITY_DAYS, "visibilityTeacher"],
  ] as const;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />

      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map(([name, value, max, key]) => (
          <div key={name} className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`center-${name}`}>{t(`detail.${key}.label`)}</Label>
            <Input
              id={`center-${name}`}
              name={name}
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              dir="ltr"
              defaultValue={value}
              aria-invalid={state.fieldErrors?.[name] ? true : undefined}
            />
            <p className="text-xs text-text-muted">{t(`detail.${key}.hint`, { max })}</p>
            {state.fieldErrors?.[name] ? <FieldError>{tErrors(state.fieldErrors[name])}</FieldError> : null}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SubmitButton className="sm:w-auto">{t("detail.saveVisibility")}</SubmitButton>
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        {state.status === "saved" ? (
          <FormMessage tone="success">{t("detail.visibilitySaved")}</FormMessage>
        ) : null}
      </div>
    </form>
  );
}
