"use client";

import { useActionState, useState } from "react";
import { Copy, Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createInvitationAction,
  type InviteFormState,
} from "@/app/[locale]/(center)/settings/staff/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ROUTES } from "@/lib/routes";

const initialState: InviteFormState = {};

const ROLE_OPTIONS = [
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
  "TEACHER",
  "OWNER",
] as const;

function InviteLink({ token }: { token: string }) {
  const t = useTranslations("Staff");
  const locale = useLocale();
  const path = `/${locale}${ROUTES.invite(token)}`;
  // Only ever rendered after the action resolves, i.e. on the client.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const href = `${origin}${path}`;
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <FormMessage tone="success">{t("inviteCreated")}</FormMessage>
      <Label htmlFor="invite-link">{t("inviteLinkLabel")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id="invite-link" readOnly value={href} dir="ltr" />
        <Button
          type="button"
          variant="outline"
          className="h-11 shrink-0 px-4"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(href);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      <p className="text-xs text-text-muted">{t("inviteLinkHint")}</p>
    </div>
  );
}

export function InviteForm() {
  const t = useTranslations("Staff");
  const tErrors = useTranslations("Staff.errors");
  const tRoles = useTranslations("Roles");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createInvitationAction,
    initialState,
  );

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="locale" value={locale} />

        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email">{t("fields.email")}</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
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
            <Label htmlFor="invite-role">{t("fields.role")}</Label>
            <Select
              id="invite-role"
              name="role"
              defaultValue="RECEPTIONIST"
              aria-invalid={state.fieldErrors?.role ? true : undefined}
              options={ROLE_OPTIONS.map((role) => ({
                value: role,
                label: tRoles(role),
              }))}
            />
            {state.fieldErrors?.role ? (
              <FieldError>{tErrors(state.fieldErrors.role)}</FieldError>
            ) : null}
          </div>
        </div>

        <SubmitButton className="w-full sm:w-auto">
          {t("sendInvite")}
        </SubmitButton>
      </form>

      {state.token ? <InviteLink token={state.token} /> : null}
    </div>
  );
}
