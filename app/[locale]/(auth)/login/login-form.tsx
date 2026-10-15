"use client";

import { useLocale, useTranslations } from "next-intl";

import { signInAction, type AuthFormState } from "@/app/[locale]/(auth)/actions";
import { Field } from "@/components/shared/field";
import { CheckEmailNotice } from "@/components/shared/check-email-notice";
import { FormMessage } from "@/components/shared/form-message";
import { PasswordField } from "@/components/shared/password-field";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const initialState: AuthFormState = {};

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("Auth");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(signInAction, initialState);

  if (state.status === "emailConfirmationRequired" && state.email) {
    return <CheckEmailNotice email={state.email} />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

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
          autoComplete="email"
          inputMode="email"
          dir="ltr"
          placeholder="name@example.com"
          required
          aria-invalid={state.fieldErrors?.email ? true : undefined}
        />
      </Field>

      <Field
        id="password"
        label={t("fields.password")}
        error={state.fieldErrors?.password ? tErrors(state.fieldErrors.password) : undefined}
      >
        <PasswordField
          id="password"
          name="password"
          autoComplete="current-password"
          required
          aria-invalid={state.fieldErrors?.password ? true : undefined}
        />
      </Field>

      <SubmitButton className="w-full">{t("login.submit")}</SubmitButton>

      <p className="border-t border-border pt-4 text-center text-sm text-text-secondary">
        {t("login.noAccount")}{" "}
        <Link
          href={
            next
              ? `${ROUTES.register}?next=${encodeURIComponent(next)}`
              : ROUTES.register
          }
          className="font-medium text-brand hover:underline"
        >
          {t("login.registerLink")}
        </Link>
      </p>
    </form>
  );
}
