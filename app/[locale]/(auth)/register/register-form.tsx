"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { signUpAction, type AuthFormState } from "@/app/[locale]/(auth)/actions";
import { IntentCards, type SignupIntentValue } from "@/app/[locale]/(auth)/register/intent-cards";
import { Field } from "@/components/shared/field";
import { CheckEmailNotice } from "@/components/shared/check-email-notice";
import { FormMessage } from "@/components/shared/form-message";
import { NewPasswordField } from "@/components/shared/new-password-field";
import { PasswordField } from "@/components/shared/password-field";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const initialState: AuthFormState = {};

export function RegisterForm({
  next,
  defaultEmail,
  defaultIntent = null,
}: {
  next?: string;
  defaultEmail?: string;
  /** Pre-ticked only (a parent arriving from a join link) — still the person's choice to confirm. */
  defaultIntent?: SignupIntentValue | null;
}) {
  const t = useTranslations("Auth");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(signUpAction, initialState);
  const [intent, setIntent] = useState<SignupIntentValue | null>(defaultIntent);

  if (state.status === "emailConfirmationRequired" && state.email) {
    return <CheckEmailNotice email={state.email} />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <IntentCards
        value={intent}
        onChange={setIntent}
        error={state.fieldErrors?.signupIntent ? tErrors(state.fieldErrors.signupIntent) : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="firstName"
          label={t("fields.firstName")}
          error={
            state.fieldErrors?.firstName
              ? tErrors(state.fieldErrors.firstName)
              : undefined
          }
        >
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            placeholder={t("fields.firstNamePlaceholder")}
            required
            aria-invalid={state.fieldErrors?.firstName ? true : undefined}
          />
        </Field>

        <Field
          id="lastName"
          label={t("fields.lastName")}
          error={
            state.fieldErrors?.lastName
              ? tErrors(state.fieldErrors.lastName)
              : undefined
          }
        >
          <Input
            id="lastName"
            name="lastName"
            autoComplete="family-name"
            placeholder={t("fields.lastNamePlaceholder")}
            required
            aria-invalid={state.fieldErrors?.lastName ? true : undefined}
          />
        </Field>
      </div>

      <Field
        id="email"
        label={t("fields.email")}
        error={state.fieldErrors?.email ? tErrors(state.fieldErrors.email) : undefined}
      >
        <Input
          id="email"
          name="email"
          type="email"
          spellCheck={false}
          autoCapitalize="none"
          inputMode="email"
          autoComplete="email"
          dir="ltr"
          placeholder="name@example.com"
          defaultValue={defaultEmail}
          readOnly={Boolean(defaultEmail)}
          required
          aria-invalid={state.fieldErrors?.email ? true : undefined}
        />
      </Field>

      <Field
        id="password"
        label={t("fields.password")}
        error={
          state.fieldErrors?.password
            ? tErrors(state.fieldErrors.password)
            : undefined
        }
      >
        <NewPasswordField
          id="password"
          name="password"
          autoComplete="new-password"
          required
          aria-invalid={state.fieldErrors?.password ? true : undefined}
        />
      </Field>

      <Field
        id="confirmPassword"
        label={t("fields.confirmPassword")}
        error={
          state.fieldErrors?.confirmPassword
            ? tErrors(state.fieldErrors.confirmPassword)
            : undefined
        }
      >
        <PasswordField
          id="confirmPassword"
          name="confirmPassword"
          autoComplete="new-password"
          required
          aria-invalid={state.fieldErrors?.confirmPassword ? true : undefined}
        />
      </Field>

      <SubmitButton className="w-full">{t("register.submit")}</SubmitButton>

      <p className="border-t border-border pt-4 text-center text-sm text-text-secondary">
        {t("register.haveAccount")}{" "}
        <Link
          href={
            next ? `${ROUTES.login}?next=${encodeURIComponent(next)}` : ROUTES.login
          }
          className="font-medium text-brand hover:underline"
        >
          {t("register.loginLink")}
        </Link>
      </p>
    </form>
  );
}
