"use client";

import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  resendConfirmationAction,
  type AuthFormState,
} from "@/app/[locale]/(auth)/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * "Check your email" (SEC-2a): what sign-up and sign-in show when Supabase
 * returns no session because the email still needs confirming. The same
 * screen appears for an email that already has an account, so it never tells
 * anyone which emails are registered. Resending is rate-limited on the server
 * and always answers the same way.
 */
export function CheckEmailNotice({ email }: { email: string }) {
  const t = useTranslations("Auth.checkEmail");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    resendConfirmationAction,
    {},
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border border-info/30 bg-info-bg/60 p-4">
        <MailCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-text-primary">{t("title")}</p>
          <p className="mt-1 text-text-secondary">{t("body")}</p>
          <p className="mt-2 truncate font-medium text-text-primary" dir="ltr">
            {email}
          </p>
        </div>
      </div>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "resent" && !state.error ? (
        <FormMessage tone="success">{t("resent")}</FormMessage>
      ) : null}

      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="email" value={email} />
        <SubmitButton variant="outline" className="h-11 w-full sm:w-auto">
          {t("resend")}
        </SubmitButton>
        <Link
          href={ROUTES.login}
          className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-brand hover:underline"
        >
          {t("backToLogin")}
        </Link>
      </form>
    </div>
  );
}
