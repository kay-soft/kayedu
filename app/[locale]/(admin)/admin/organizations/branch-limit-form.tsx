"use client";

import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { updateOrganizationBranchLimitAction } from "@/app/[locale]/(admin)/admin/organizations/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BRANCH_LIMIT } from "@/lib/branch-setup";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The organization's branch limit (F1) — platform admin only, audited
 * `platform.organization.limit.update`. Lowering it below the branches the
 * organization already has is allowed and only blocks new ones; the hint says
 * so, so nobody expects a branch to disappear.
 */
export function BranchLimitForm({
  organizationId,
  maxBranches,
  used,
}: {
  organizationId: string;
  maxBranches: number;
  used: number;
}) {
  const t = useTranslations("AdminOrganizations");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    updateOrganizationBranchLimitAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={organizationId} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="organization-max-branches">{t("limit.label")}</Label>
        <Input
          id="organization-max-branches"
          name="maxBranches"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_BRANCH_LIMIT}
          dir="ltr"
          defaultValue={maxBranches}
          aria-invalid={state.fieldErrors?.maxBranches ? true : undefined}
          aria-describedby="organization-max-branches-hint"
        />
        <p id="organization-max-branches-hint" className="text-xs text-text-muted">
          {t("limit.hint", { used })}
        </p>
        {state.fieldErrors?.maxBranches ? (
          <FieldError>{tErrors(state.fieldErrors.maxBranches)}</FieldError>
        ) : null}
      </div>

      <SubmitButton className="sm:w-auto">{t("limit.save")}</SubmitButton>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? <FormMessage tone="success">{t("limit.saved")}</FormMessage> : null}
    </form>
  );
}
