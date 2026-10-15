"use client";

import { useLocale, useTranslations } from "next-intl";

import {
  acceptInvitationAction,
  type AuthFormState,
} from "@/app/[locale]/(auth)/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const initialState: AuthFormState = {};

export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useTranslations("Auth.invite");
  const tErrors = useTranslations("Auth.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    acceptInvitationAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <SubmitButton className="w-full">{t("accept")}</SubmitButton>
    </form>
  );
}
