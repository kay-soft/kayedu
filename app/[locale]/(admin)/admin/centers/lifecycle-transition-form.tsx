"use client";

import { useActionState } from "react";
import type { CenterLifecycleState } from "@prisma/client";
import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { transitionCenterLifecycleAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Label } from "@/components/ui/label";
import { SelectInput } from "@/components/ui/select-input";

/**
 * The lifecycle-state transition control (M19, replacing the old boolean
 * activate/suspend toggle). `validNext` is computed server-side from
 * `lib/db/platform.ts`'s `validNextLifecycleStates` — this form only ever
 * offers a state the transition table already allows, and the Server Action
 * re-validates the same table regardless (docs/00 §5.1: "an invalid
 * transition is refused, not silently allowed").
 */
export function LifecycleTransitionForm({
  centerId,
  validNext,
}: {
  centerId: string;
  validNext: readonly CenterLifecycleState[];
}) {
  const t = useTranslations("AdminCenters");
  const tLifecycle = useTranslations("AdminCenters.lifecycle");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    transitionCenterLifecycleAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  if (validNext.length === 0) {
    return <p className="text-sm text-text-muted">{t("lifecycleTerminal")}</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="lifecycle-transition-to">{t("lifecycleTransitionLabel")}</Label>
        <SelectInput id="lifecycle-transition-to" name="to" defaultValue={validNext[0]}>
          {validNext.map((next) => (
            <option key={next} value={next}>
              {tLifecycle(next)}
            </option>
          ))}
        </SelectInput>
      </div>

      <SubmitButton className="sm:w-auto">{t("lifecycleTransitionSubmit")}</SubmitButton>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("lifecycleTransitionSaved")}</FormMessage>
      ) : null}
    </form>
  );
}
