"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { savePermissionGrantsAction } from "@/app/[locale]/(center)/settings/actions";
import { ToggleRow } from "@/components/settings/toggle-row";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

export function PermissionGrantsForm({
  receptionistCanViewProfit,
  receptionistCanCorrectAttendance,
}: {
  receptionistCanViewProfit: boolean;
  receptionistCanCorrectAttendance: boolean;
}) {
  const t = useTranslations("Settings.permissions");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    savePermissionGrantsAction,
    IDLE_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("receptionistTitle")}</CardTitle>
          <CardDescription>{t("receptionistDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ToggleRow
            name="receptionistCanViewProfit"
            label={t("viewProfitLabel")}
            description={t("viewProfitDescription")}
            defaultChecked={receptionistCanViewProfit}
          />
          <ToggleRow
            name="receptionistCanCorrectAttendance"
            label={t("correctAttendanceLabel")}
            description={t("correctAttendanceDescription")}
            defaultChecked={receptionistCanCorrectAttendance}
          />

          <SubmitButton className="w-full sm:w-auto">
            {tCommon("save")}
          </SubmitButton>
        </CardContent>
      </Card>
    </form>
  );
}
