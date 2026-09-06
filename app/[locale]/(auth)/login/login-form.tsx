"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { signInAction, type AuthFormState } from "@/app/[locale]/(auth)/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

const initialState: AuthFormState = {};

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("Auth");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(signInAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("fields.email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          dir="ltr"
          required
          aria-invalid={state.fieldErrors?.email ? true : undefined}
        />
        {state.fieldErrors?.email ? (
          <FieldError>{tErrors(state.fieldErrors.email)}</FieldError>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">{t("fields.password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state.fieldErrors?.password ? true : undefined}
        />
        {state.fieldErrors?.password ? (
          <FieldError>{tErrors(state.fieldErrors.password)}</FieldError>
        ) : null}
      </div>

      <SubmitButton className="w-full">{t("login.submit")}</SubmitButton>

      <p className="text-center text-sm text-text-secondary">
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
