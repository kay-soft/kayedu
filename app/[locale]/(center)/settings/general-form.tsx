"use client";

import { startTransition, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ConflictPolicy, ShareType } from "@prisma/client";

import { saveGeneralSettingsAction } from "@/app/[locale]/(center)/settings/actions";
import { ToggleRow } from "@/components/settings/toggle-row";
import { ErrorSummary } from "@/components/shared/error-summary";
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
import { Select } from "@/components/ui/select";
import { CENTER_TIMEZONES } from "@/lib/branch-setup";
import { formatMoney } from "@/lib/format";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres, piastresToInputValue, splitShare } from "@/lib/money";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { MAX_EDIT_DEADLINE_HOURS, MAX_LATE_THRESHOLD, MAX_TIMEOUT_DAYS, generalSettingsSchema } from "@/lib/validation/settings";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { MAX_CENTER_VISIBILITY_DAYS, MAX_TEACHER_VISIBILITY_DAYS } from "@/lib/db/visibility";
import { useClientValidation } from "@/lib/ui/client-validation";

/** The session price the cut preview is worked out against: 120.00 EGP. */
const PREVIEW_AMOUNT = 12_000;

/** IANA zones a center in the region plausibly runs on. */
const TIMEZONES = CENTER_TIMEZONES;

export type GeneralSettingsValues = {
  defaultShareType: ShareType;
  defaultShareValue: number;
  teacherTimeoutDays: number | null;
  defaultLateThreshold: number;
  timezone: string;
  scheduleConflictPolicy: ConflictPolicy;
  teacherEditDeadlineHours: number | null;
  centerDataVisibilityDays: number;
  teacherDataVisibilityDays: number;
  publicListing: boolean;
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
  const [state, formAction] = useGuardedActionState(
    saveGeneralSettingsAction,
    IDLE_ACTION_STATE,
  );
  // The action's own schema, run before the round trip (docs/04 §14.2).
  const { clientErrors, check } = useClientValidation(generalSettingsSchema);
  const fieldErrors = clientErrors ?? state.fieldErrors;

  const [shareType, setShareType] = useState<ShareType>(values.defaultShareType);
  const [shareValue, setShareValue] = useState(
    values.defaultShareType === "FIXED"
      ? piastresToInputValue(values.defaultShareValue)
      : String(values.defaultShareValue),
  );
  const [timeoutEnabled, setTimeoutEnabled] = useState(
    values.teacherTimeoutDays !== null,
  );
  const [editDeadlineEnabled, setEditDeadlineEnabled] = useState(
    values.teacherEditDeadlineHours !== null,
  );

  // The same split lib/money.ts freezes onto a payment, previewed live so an
  // owner sees what the setting actually does before saving it.
  // Through the server's own parser (lib/money.ts, SEC-74) — preview only.
  const typed =
    shareType === "FIXED"
      ? parseEgpToPiastres(shareValue, MAX_PRICE_PIASTRES)
      : shareValue.trim() !== "" && Number.isInteger(Number(shareValue)) ? Number(shareValue) : null;
  const preview = typed !== null ? splitShare(PREVIEW_AMOUNT, shareType, typed) : null;

  return (
    // `startTransition` with the form's FormData: `<form action>` resets an
    // uncontrolled form once the action returns, so a refused save lost every
    // edit on the page (DES, docs/04 §14.8).
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
    if (!check(event.currentTarget, formData)) return;
        startTransition(() => formAction(formData));
      }}
      className="flex flex-col gap-6"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <ErrorSummary fieldErrors={fieldErrors} />

      <Card>
        <CardHeader>
          <CardTitle>{t("cutTitle")}</CardTitle>
          <CardDescription>{t("cutDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="defaultShareType">{t("shareType")}</Label>
              <Select
                id="defaultShareType"
                name="defaultShareType"
                value={shareType}
                onValueChange={(next) => setShareType(next as ShareType)}
              >
                <option value="PERCENTAGE">{t("percentage")}</option>
                <option value="FIXED">{t("fixed")}</option>
              </Select>
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
                aria-invalid={fieldErrors?.shareValue ? true : undefined}
              />
              {fieldErrors?.shareValue ? (
                <FieldError>
                  {tErrors(fieldErrors.shareValue)}
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
                    fieldErrors?.teacherTimeoutDays ? true : undefined
                  }
                />
                {fieldErrors?.teacherTimeoutDays ? (
                  <FieldError>
                    {tErrors(fieldErrors.teacherTimeoutDays)}
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
                  fieldErrors?.defaultLateThreshold ? true : undefined
                }
              />
              <p className="text-xs text-text-muted">
                {t("lateThresholdHint")}
              </p>
              {fieldErrors?.defaultLateThreshold ? (
                <FieldError>
                  {tErrors(fieldErrors.defaultLateThreshold)}
                </FieldError>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="timezone">{t("timezone")}</Label>
              <Select
                id="timezone"
                name="timezone"
                defaultValue={values.timezone}
              >
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <ToggleRow
            name="teacherEditDeadlineEnabled"
            label={t("editDeadlineLabel")}
            description={t("editDeadlineDescription")}
            checked={editDeadlineEnabled}
            onCheckedChange={setEditDeadlineEnabled}
            note={
              <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-56">
                <Label htmlFor="teacherEditDeadlineHours">
                  {t("editDeadlineHours")}
                </Label>
                <Input
                  id="teacherEditDeadlineHours"
                  name="teacherEditDeadlineHours"
                  type="number"
                  dir="ltr"
                  inputMode="numeric"
                  min={1}
                  max={MAX_EDIT_DEADLINE_HOURS}
                  step={1}
                  disabled={!editDeadlineEnabled}
                  defaultValue={values.teacherEditDeadlineHours ?? 48}
                  aria-invalid={
                    fieldErrors?.teacherEditDeadlineHours ? true : undefined
                  }
                />
                {fieldErrors?.teacherEditDeadlineHours ? (
                  <FieldError>
                    {tErrors(fieldErrors.teacherEditDeadlineHours)}
                  </FieldError>
                ) : null}
              </div>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("visibilityTitle")}</CardTitle>
          <CardDescription>{t("visibilityDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* U6: two windows, each with its cap and one line on what it covers. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["centerDataVisibilityDays", MAX_CENTER_VISIBILITY_DAYS, "visibilityCenter"],
                ["teacherDataVisibilityDays", MAX_TEACHER_VISIBILITY_DAYS, "visibilityTeacher"],
              ] as const
            ).map(([name, max, key]) => (
              <div key={name} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={name}>{t(`${key}.label`)}</Label>
                <Input
                  id={name}
                  name={name}
                  type="number"
                  dir="ltr"
                  inputMode="numeric"
                  min={1}
                  max={max}
                  step={1}
                  defaultValue={values[name]}
                  aria-invalid={fieldErrors?.[name] ? true : undefined}
                  className="sm:max-w-56"
                />
                <p className="text-xs text-text-muted">{t(`${key}.hint`, { max })}</p>
                {fieldErrors?.[name] ? <FieldError>{tErrors(fieldErrors[name])}</FieldError> : null}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-text-muted">{t("visibilityHint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("schedulingTitle")}</CardTitle>
          <CardDescription>{t("schedulingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleRow
            name="denyScheduleConflicts"
            label={t("denyConflictsLabel")}
            description={t("denyConflictsDescription")}
            defaultChecked={values.scheduleConflictPolicy === "DENY"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("publicListingTitle")}</CardTitle>
          <CardDescription>{t("publicListingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleRow
            name="publicListing"
            label={t("publicListingLabel")}
            description={t("publicListingHint")}
            defaultChecked={values.publicListing}
          />
        </CardContent>
      </Card>

      {/* The save bar stays at the foot of the screen on a long page and says
          what happened where the press was (the success is also a toast). */}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 rounded-xl border border-border bg-surface/95 p-3 shadow-popover backdrop-blur sm:flex-row sm:items-center sm:justify-end">
        {state.error ? (
          <FormMessage className="sm:me-auto">{tErrors(state.error)}</FormMessage>
        ) : state.status === "saved" ? (
          <FormMessage tone="success" className="sm:me-auto">
            {tCommon("saved")}
          </FormMessage>
        ) : null}
        <SubmitButton className="w-full sm:w-auto">{tCommon("save")}</SubmitButton>
      </div>
    </form>
  );
}
