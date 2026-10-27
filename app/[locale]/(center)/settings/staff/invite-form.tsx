"use client";

import { useLocale, useTranslations } from "next-intl";

import {
  createInvitationAction,
  type InviteFormState,
} from "@/app/[locale]/(center)/settings/staff/actions";
import { CopyLinkField } from "@/components/shared/copy-link-field";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const initialState: InviteFormState = {};

// Centre staff only (R9) — teachers are added from the Teachers page.
const ROLE_OPTIONS = [
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
  "OWNER",
] as const;

function InviteLink({ token, branchName }: { token: string; branchName?: string }) {
  const t = useTranslations("Staff");
  const locale = useLocale();
  const path = `/${locale}${ROUTES.invite(token)}`;
  // Only ever rendered after the action resolves, i.e. on the client.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const href = `${origin}${path}`;
  return (
    <div className="flex flex-col gap-2">
      <FormMessage tone="success">
        {branchName ? t("inviteCreatedForBranch", { branch: branchName }) : t("inviteCreated")}
      </FormMessage>
      <CopyLinkField
        id="invite-link"
        href={href}
        label={t("inviteLinkLabel")}
        hint={t("inviteLinkHint")}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
        failedLabel={t("copyFailed")}
      />
    </div>
  );
}

/**
 * F1: `branches` are the branches where the actor may invite (holds
 * `membership.role.assign` there); with more than one, a Branch select
 * appears, defaulting to the active branch. The action re-checks the target.
 */
export function InviteForm({
  branches,
  activeBranchId,
}: {
  branches: { id: string; name: string }[];
  activeBranchId: string;
}) {
  const t = useTranslations("Staff");
  const tErrors = useTranslations("Staff.errors");
  const tRoles = useTranslations("Roles");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    createInvitationAction,
    initialState,
  );

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="locale" value={locale} />

        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {branches.length > 1 ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="invite-branch">{t("fields.branch")}</Label>
              <Select
                id="invite-branch"
                name="branchId"
                defaultValue={activeBranchId}
                aria-invalid={state.fieldErrors?.branchId ? true : undefined}
                options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
              />
              {state.fieldErrors?.branchId ? (
                <FieldError>{tErrors(state.fieldErrors.branchId)}</FieldError>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email">{t("fields.email")}</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
          spellCheck={false}
          autoCapitalize="none"
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

        <SubmitButton className="w-full sm:w-auto sm:self-start">
          {t("sendInvite")}
        </SubmitButton>
      </form>

      {state.token ? <InviteLink token={state.token} branchName={state.branchName} /> : null}
    </div>
  );
}
