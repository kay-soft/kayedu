"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  IDLE_ADMIN_ACTION_STATE,
  setCenterActiveAction,
} from "@/app/[locale]/(admin)/admin/centers/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";

/** Flips `Center.active` — the same "hidden input carries the next value,
 * present only when activating" trick `EntityManager`'s row toggle uses. */
export function ActiveToggleForm({
  centerId,
  active,
}: {
  centerId: string;
  active: boolean;
}) {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    setCenterActiveAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={centerId} />
      {active ? null : <input type="hidden" name="active" value="true" />}
      <SubmitButton variant={active ? "destructive" : "outline"}>
        {active ? t("suspend") : t("activate")}
      </SubmitButton>
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </form>
  );
}
