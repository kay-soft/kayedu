"use client";

import { useActionState, useState } from "react";
import type { CenterLifecycleState } from "@prisma/client";
import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { transitionCenterLifecycleAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/**
 * The lifecycle-state transition control (M19, replacing the old boolean
 * activate/suspend toggle). `validNext` is computed server-side from
 * `lib/db/platform.ts`'s `validNextLifecycleStates` — this form only ever
 * offers a state the transition table already allows, and the Server Action
 * re-validates the same table regardless (docs/00 §5.1: "an invalid
 * transition is refused, not silently allowed").
 *
 * SYS: ARCHIVED is terminal, so choosing it asks for an explicit "this is
 * final" tick before the button works — the one irreversible move here.
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
  const [to, setTo] = useState<string>(validNext[0] ?? "");
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
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
        <Select
          id="lifecycle-transition-to"
          name="to"
          value={to}
          onValueChange={(next) => {
            setTo(next);
            setArchiveConfirmed(false);
          }}
        >
          {validNext.map((next) => (
            <option key={next} value={next}>
              {tLifecycle(next)}
            </option>
          ))}
        </Select>
      </div>

      {to === "ARCHIVED" ? (
        <label htmlFor="lifecycle-archive-confirm" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-text-primary">
          <Checkbox
            id="lifecycle-archive-confirm"
            checked={archiveConfirmed}
            onCheckedChange={(checked) => setArchiveConfirmed(checked === true)}
          />
          <span>{t("archiveConfirm")}</span>
        </label>
      ) : null}

      <SubmitButton className="sm:w-auto" disabled={to === "ARCHIVED" && !archiveConfirmed}>
        {t("lifecycleTransitionSubmit")}
      </SubmitButton>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("lifecycleTransitionSaved")}</FormMessage>
      ) : null}
    </form>
  );
}
