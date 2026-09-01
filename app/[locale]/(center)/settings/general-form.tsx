"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { saveGeneralSettingsAction } from "@/app/[locale]/(center)/settings/actions";
import { ToggleRow } from "@/components/settings/toggle-row";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectInput } from "@/components/ui/select-input";
import { formatMoney } from "@/lib/format";
import { piastresToInputValue, splitShare } from "@/lib/money";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import {
  MAX_LATE_THRESHOLD,
  MAX_TIMEOUT_DAYS,
} from "@/lib/validation/settings";

/** The session price the cut preview is worked out against: 120.00 EGP. */
const PREVIEW_AMOUNT = 12_000;

/** IANA zones a center in the region plausibly runs on. */
const TIMEZONES = ["Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "UTC"] as const;

export type GeneralSettingsValues = {
  defaultShareType: ShareType;
  defaultShareValue: number;
  teacherTimeoutDays: number | null;
  defaultLateThreshold: number;
  timezone: string;
};

export function GeneralSettingsForm({
  values,
}: {
  values: GeneralSettingsValues;
}) {
  const t = useTranslations("Settings.general");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Settings.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    saveGeneralSettingsAction,
    IDLE_ACTION_STATE,
  );

  const [shareType, setShareType] = useState<ShareType>(values.defaultShareType);
  const [shareValue, setShareValue] = useState(
    values.defaultShareType === "FIXED"
      ? piastresToInputValue(values.defaultShareValue)
      : String(values.defaultShareValue),
  );
  const [timeoutEnabled, setTimeoutEnabled] = useState(
    values.teacherTimeoutDays !== null,
  );

  // The same split lib/money.ts freezes onto a payment, previewed live so an
  // owner sees what the setting actually does before saving it.
  const typed = Number(shareValue);
  const previewable = shareValue.trim() !== "" && Number.isFinite(typed) && typed >= 0;
  const preview = previewable
    ? splitShare(
        PREVIEW_AMOUNT,
        shareType,
        shareType === "FIXED" ? Math.round(typed * 100) : Math.round(typed),
      )
    : null;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("cutTitle")}</CardTitle>
          <CardDescription>{t("cutDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="defaultShareType">{t("shareType")}</Label>
              <SelectInput
                id="defaultShareType"
                name="defaultShareType"
                value={shareType}
                onChange={(event) =>
                  setShareType(event.target.value as ShareType)
                }
              >
                <option value="PERCENTAGE">{t("percentage")}</option>
                <option value="FIXED">{t("fixed")}</option>
              </SelectInput>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="shareValue">
                {shareType === "FIXED" ? t("shareValueEgp") : t("shareValuePct")}
              </Label>
              <Input
                id="shareValue"
                name="shareValue"
                type="number"
                dir="ltr"
                inputMode="decimal"
                min={0}
                {...(shareType === "FIXED"
                  ? { step: "0.01" }
                  : { step: 1, max: 100 })}
                value={shareValue}
                onChange={(event) => setShareValue(event.target.value)}
                aria-invalid={state.fieldErrors?.shareValue ? true : undefined}
              />
              {state.fieldErrors?.shareValue ? (
                <FieldError>
                  {tErrors(state.fieldErrors.shareValue)}
                </FieldError>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface-subtle p-3 sm:p-4">
            <p className="text-xs font-medium text-text-muted">
              {t("previewLabel", {
                amount: formatMoney(PREVIEW_AMOUNT, locale),
              })}
            </p>
            {preview ? (
              <dl className="mt-2 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-text-secondary">{t("centerShare")}</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMoney(preview.centerShare, locale)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 sm:block">
                  <dt className="text-text-secondary">{t("teacherShare")}</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMoney(preview.teacherShare, locale)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-sm text-text-muted">{t("previewEmpty")}</p>
            )}
            <p className="mt-2 text-xs text-text-muted">{t("snapshotNote")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("operationsTitle")}</CardTitle>
          <CardDescription>{t("operationsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ToggleRow
            name="teacherTimeoutEnabled"
            label={t("timeoutLabel")}
            description={t("timeoutDescription")}
            checked={timeoutEnabled}
            onCheckedChange={setTimeoutEnabled}
            note={
              <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-56">
                <Label htmlFor="teacherTimeoutDays">{t("timeoutDays")}</Label>
                <Input
                  id="teacherTimeoutDays"
                  name="teacherTimeoutDays"
                  type="number"
                  dir="ltr"
                  inputMode="numeric"
                  min={1}
                  max={MAX_TIMEOUT_DAYS}
                  step={1}
                  disabled={!timeoutEnabled}
                  defaultValue={values.teacherTimeoutDays ?? 30}
                  aria-invalid={
                    state.fieldErrors?.teacherTimeoutDays ? true : undefined
                  }
                />
                {state.fieldErrors?.teacherTimeoutDays ? (
                  <FieldError>
                    {tErrors(state.fieldErrors.teacherTimeoutDays)}
                  </FieldError>
                ) : null}
              </div>
            }
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="defaultLateThreshold">
                {t("lateThreshold")}
              </Label>
              <Input
                id="defaultLateThreshold"
                name="defaultLateThreshold"
                type="number"
                dir="ltr"
                inputMode="numeric"
                min={0}
                max={MAX_LATE_THRESHOLD}
                step={1}
                defaultValue={values.defaultLateThreshold}
                aria-invalid={
                  state.fieldErrors?.defaultLateThreshold ? true : undefined
                }
              />
              <p className="text-xs text-text-muted">
                {t("lateThresholdHint")}
              </p>
              {state.fieldErrors?.defaultLateThreshold ? (
                <FieldError>
                  {tErrors(state.fieldErrors.defaultLateThreshold)}
                </FieldError>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="timezone">{t("timezone")}</Label>
              <SelectInput
                id="timezone"
                name="timezone"
                defaultValue={values.timezone}
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </SelectInput>
            </div>
          </div>
        </CardContent>
      </Card>

      <div>
        <SubmitButton className="w-full sm:w-auto">
          {tCommon("save")}
        </SubmitButton>
      </div>
    </form>
  );
}
