"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  changeEmailAction,
  changePasswordAction,
  updateAccountProfileAction,
  type AccountFormState,
} from "@/app/[locale]/account/actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { NewPasswordField } from "@/components/shared/new-password-field";
import { PasswordField } from "@/components/shared/password-field";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatPhone } from "@/lib/phone";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

const IDLE: AccountFormState = {};

/** An `Account.errors` key → copy; a key the namespace lacks reads as "failed". */
function useErrorText() {
  const t = useTranslations("Account.errors");
  return (key: string | undefined) => (key ? (t.has(key) ? t(key) : t("failed")) : undefined);
}

/** Name, contact phone and preferred language — the `User` row only (F2). */
export function AccountProfileForm({
  firstName,
  lastName,
  contactPhone,
  preferredLocale,
}: {
  firstName: string;
  lastName: string;
  contactPhone: string;
  preferredLocale: "ar" | "en";
}) {
  const t = useTranslations("Account.profile");
  const errorText = useErrorText();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(updateAccountProfileAction, IDLE);
  useActionFeedback(state, { success: t("saved") });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="account-firstName" label={t("firstName")} error={errorText(state.fieldErrors?.firstName)}>
              <Input id="account-firstName" name="firstName" autoComplete="given-name" defaultValue={firstName} required />
            </Field>
            <Field id="account-lastName" label={t("lastName")} error={errorText(state.fieldErrors?.lastName)}>
              <Input id="account-lastName" name="lastName" autoComplete="family-name" defaultValue={lastName} required />
            </Field>
          </div>

          <Field
            id="account-contactPhone"
            label={t("contactPhone")}
            optional
            hint={t("contactPhoneHint")}
            error={errorText(state.fieldErrors?.contactPhone)}
          >
            <Input
              id="account-contactPhone"
              name="contactPhone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              placeholder="01012345678"
              defaultValue={formatPhone(contactPhone)}
            />
          </Field>

          <Field
            id="account-preferredLocale"
            label={t("preferredLocale")}
            hint={t("preferredLocaleHint")}
            error={errorText(state.fieldErrors?.preferredLocale)}
          >
            <Select id="account-preferredLocale" name="preferredLocale" defaultValue={preferredLocale}>
              <option value="ar">{t("localeAr")}</option>
              <option value="en">{t("localeEn")}</option>
            </Select>
          </Field>

          <SubmitButton className="w-full sm:w-fit" pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * The sign-in email. `mode` is the server's `emailChangeMode()`: `off` shows
 * the address read-only with "coming soon"; `direct` and `confirm` take the
 * new address and the current password.
 */
export function AccountEmailForm({
  currentEmail,
  pendingEmail,
  mode,
}: {
  currentEmail: string | null;
  /** Supabase's `new_email` while a confirmation link is outstanding. */
  pendingEmail: string | null;
  mode: "confirm" | "direct" | "off";
}) {
  const t = useTranslations("Account.email");
  const errorText = useErrorText();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(changeEmailAction, IDLE);
  useActionFeedback(state, {
    success: (status) => (status === "emailChanged" ? t("changed") : null),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-secondary">{t("current")}</span>
          <span className="text-sm break-all text-text-primary">
            {currentEmail ? <Ltr>{currentEmail}</Ltr> : "—"}
          </span>
        </div>

        {pendingEmail ? (
          <FormMessage tone="info">
            {t("pending")} <Ltr>{pendingEmail}</Ltr>
          </FormMessage>
        ) : null}

        {mode === "off" ? (
          <FormMessage tone="info">{t("comingSoon")}</FormMessage>
        ) : (
          <form action={formAction} className="flex flex-col gap-4" noValidate>
            <input type="hidden" name="locale" value={locale} />
            {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}
            {state.status === "emailChangeRequested" ? (
              <FormMessage tone="success">{t("requested")}</FormMessage>
            ) : null}

            <Field id="account-newEmail" label={t("newEmail")} error={errorText(state.fieldErrors?.newEmail)}>
              <Input
                id="account-newEmail"
                name="newEmail"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                placeholder="name@example.com"
                required
              />
            </Field>
            <Field
              id="account-email-currentPassword"
              label={t("currentPassword")}
              error={errorText(state.fieldErrors?.currentPassword)}
            >
              <PasswordField
                id="account-email-currentPassword"
                name="currentPassword"
                autoComplete="current-password"
                required
                aria-invalid={state.fieldErrors?.currentPassword ? true : undefined}
              />
            </Field>

            <SubmitButton className="w-full sm:w-fit" pendingLabel={t("submitting")}>
              {t("submit")}
            </SubmitButton>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** Current password, new + confirm, and "sign out other devices" (ticked by default). */
export function AccountPasswordForm() {
  const t = useTranslations("Account.password");
  const errorText = useErrorText();
  const locale = useLocale();
  const [signOutOthers, setSignOutOthers] = useState(true);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useGuardedActionState(changePasswordAction, IDLE);
  useActionFeedback(state, {
    success: (status) => (status === "passwordChanged" ? t("changed") : null),
  });
  // A changed password leaves nothing typed behind.
  useEffect(() => {
    if (state.status) formRef.current?.reset();
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="signOutOthers" value={signOutOthers ? "true" : "false"} />
          {state.error ? <FormMessage>{errorText(state.error)}</FormMessage> : null}
          {state.status === "passwordChangedOthersKept" ? (
            <FormMessage tone="warning">{t("changedOthersKept")}</FormMessage>
          ) : null}

          <Field
            id="account-currentPassword"
            label={t("currentPassword")}
            error={errorText(state.fieldErrors?.currentPassword)}
          >
            <PasswordField
              id="account-currentPassword"
              name="currentPassword"
              autoComplete="current-password"
              required
              aria-invalid={state.fieldErrors?.currentPassword ? true : undefined}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="account-newPassword" label={t("newPassword")} error={errorText(state.fieldErrors?.newPassword)}>
              <NewPasswordField
                id="account-newPassword"
                name="newPassword"
                autoComplete="new-password"
                required
                aria-invalid={state.fieldErrors?.newPassword ? true : undefined}
              />
            </Field>
            <Field
              id="account-confirmPassword"
              label={t("confirmPassword")}
              error={errorText(state.fieldErrors?.confirmPassword)}
            >
              <PasswordField
                id="account-confirmPassword"
                name="confirmPassword"
                autoComplete="new-password"
                required
                aria-invalid={state.fieldErrors?.confirmPassword ? true : undefined}
              />
            </Field>
          </div>

          <label
            htmlFor="account-signOutOthers"
            className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm text-text-primary"
          >
            <Checkbox
              id="account-signOutOthers"
              checked={signOutOthers}
              onCheckedChange={(checked) => setSignOutOthers(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span>{t("signOutOthers")}</span>
              <span className="text-xs text-text-secondary">{t("signOutOthersHint")}</span>
            </span>
          </label>

          <SubmitButton className="w-full sm:w-fit" pendingLabel={t("submitting")}>
            {t("submit")}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
