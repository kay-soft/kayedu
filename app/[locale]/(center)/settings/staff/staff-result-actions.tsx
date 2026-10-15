"use client";

import { useTranslations } from "next-intl";
import { X } from "lucide-react";

import {
  revokeInvitationAction,
} from "@/app/[locale]/(center)/settings/staff/actions";
import {
  grantMembershipBranchAction,
  revokeMembershipBranchAction,
} from "@/app/[locale]/(center)/settings/staff/member-actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Select } from "@/components/ui/select";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

/**
 * The staff screen's three controls that used to post a `void` Server Action
 * (DES, Phase 3): revoking an invitation, and granting or removing a branch.
 * A refusal had looked exactly like success — the page simply re-rendered.
 * Each now toasts its result; the grant, which has a body, also says an error
 * beside its select. The rules are the actions' own and unchanged.
 */

export function RevokeInvitationButton({
  locale,
  invitationId,
  email,
}: {
  locale: string;
  invitationId: string;
  email: string;
}) {
  const t = useTranslations("Staff");
  const tErrors = useTranslations("Settings.errors");
  const [state, dispatch, pending] = useGuardedActionState(revokeInvitationAction, IDLE_ACTION_STATE);
  useActionFeedback(state, {
    success: t("toast.invitationRevoked"),
    error: (key) => tErrors(key),
  });

  return (
    <ConfirmAction
      label={t("revoke")}
      variant="destructive"
      triggerClassName="h-11 w-full shrink-0 px-4 sm:w-auto"
      title={t("revokeConfirm.title")}
      description={t("revokeConfirm.body", { email })}
      action={dispatch}
      disabled={pending}
      fields={{ locale, invitationId }}
    />
  );
}

export function RevokeBranchButton({
  locale,
  membershipId,
  branch,
  memberName,
}: {
  locale: string;
  membershipId: string;
  branch: { id: string; name: string };
  memberName: string;
}) {
  const t = useTranslations("Staff");
  const tErrors = useTranslations("Settings.errors");
  const [state, dispatch, pending] = useGuardedActionState(revokeMembershipBranchAction, IDLE_ACTION_STATE);
  useActionFeedback(state, {
    success: t("toast.branchRevoked", { branch: branch.name }),
    error: (key) => tErrors(key),
  });

  return (
    // Revoking cross-branch access asks first, and the target is 44px — it
    // had been a one-tap 24px "×".
    <ConfirmAction
      label={t("branchGrants.revoke", { branch: branch.name })}
      iconOnly
      icon={<X className="size-4" aria-hidden />}
      variant="ghost"
      triggerClassName="size-11 rounded-full p-0 text-text-secondary hover:bg-danger-bg hover:text-danger-fg"
      title={t("branchGrants.revokeConfirm.title", { branch: branch.name })}
      description={t("branchGrants.revokeConfirm.body", { name: memberName })}
      confirmLabel={t("branchGrants.revokeConfirm.confirm")}
      action={dispatch}
      disabled={pending}
      fields={{ locale, membershipId, centerId: branch.id }}
    />
  );
}

export function GrantBranchForm({
  locale,
  membershipId,
  branches,
}: {
  locale: string;
  membershipId: string;
  branches: { id: string; name: string }[];
}) {
  const t = useTranslations("Staff");
  const tErrors = useTranslations("Settings.errors");
  const [state, dispatch] = useGuardedActionState(grantMembershipBranchAction, IDLE_ACTION_STATE);
  useActionFeedback(state, { success: t("toast.branchGranted") });

  return (
    <form action={dispatch} className="flex flex-col gap-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <div className="flex items-center gap-2">
        <Select
          name="centerId"
          aria-label={t("branchGrants.grantLabel")}
          // It had rendered as an empty bar beside "Grant".
          placeholder={t("branchGrants.grantPlaceholder")}
          className="min-w-0 flex-1"
        >
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </Select>
        <SubmitButton variant="outline" className="h-11 shrink-0 px-3">
          {t("branchGrants.grant")}
        </SubmitButton>
      </div>
      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
    </form>
  );
}
