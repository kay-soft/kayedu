"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { signUpAction, type AuthFormState } from "@/app/[locale]/(auth)/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

const initialState: AuthFormState = {};

export function RegisterForm({
  next,
  defaultEmail,
}: {
  next?: string;
  defaultEmail?: string;
}) {
  const t = useTranslations("Auth");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(signUpAction, initialState);

  if (state.status === "emailConfirmationRequired") {
    return (
      <FormMessage tone="info">{t("register.confirmEmail")}</FormMessage>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="firstName">{t("fields.firstName")}</Label>
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            required
            aria-invalid={state.fieldErrors?.firstName ? true : undefined}
          />
          {state.fieldErrors?.firstName ? (
            <FieldError>{tErrors(state.fieldErrors.firstName)}</FieldError>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lastName">{t("fields.lastName")}</Label>
          <Input
            id="lastName"
            name="lastName"
            autoComplete="family-name"
            required
            aria-invalid={state.fieldErrors?.lastName ? true : undefined}
          />
          {state.fieldErrors?.lastName ? (
            <FieldError>{tErrors(state.fieldErrors.lastName)}</FieldError>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("fields.email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          dir="ltr"
          defaultValue={defaultEmail}
          readOnly={Boolean(defaultEmail)}
          required
          aria-invalid={state.fieldErrors?.email ? true : undefined}
        />
        {state.fieldErrors?.email ? (
          <FieldError>{tErrors(state.fieldErrors.email)}</FieldError>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="phone">
          {t("fields.phone")}
          <span className="text-text-muted">({t("fields.optional")})</span>
        </Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          placeholder="01xxxxxxxxx"
          aria-invalid={state.fieldErrors?.phone ? true : undefined}
        />
        {state.fieldErrors?.phone ? (
          <FieldError>{tErrors(state.fieldErrors.phone)}</FieldError>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("fields.password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={state.fieldErrors?.password ? true : undefined}
        />
        {state.fieldErrors?.password ? (
          <FieldError>{tErrors(state.fieldErrors.password)}</FieldError>
        ) : (
          <p className="text-xs text-text-muted">{t("register.passwordHint")}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirmPassword">{t("fields.confirmPassword")}</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={state.fieldErrors?.confirmPassword ? true : undefined}
        />
        {state.fieldErrors?.confirmPassword ? (
          <FieldError>{tErrors(state.fieldErrors.confirmPassword)}</FieldError>
        ) : null}
      </div>

      <SubmitButton className="w-full">{t("register.submit")}</SubmitButton>

      <p className="text-center text-sm text-text-secondary">
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
