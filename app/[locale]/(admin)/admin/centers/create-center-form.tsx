"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { IDLE_ADMIN_ACTION_STATE } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { createCenterAction } from "@/app/[locale]/(admin)/admin/centers/actions";
import { CopyLinkField } from "@/components/shared/copy-link-field";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_BRANCH_LIMIT } from "@/lib/branch-setup";
import { formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { cn } from "@/lib/utils";

const DEFAULT_THEME = "#2563EB";

/** An existing organization the admin may add a branch to (F1). */
export type OrganizationOption = {
  id: string;
  name: string;
  nameEn: string | null;
  usedBranches: number;
  maxBranches: number;
};

type Mode = "new" | "existing";

function InviteLink({ token }: { token: string }) {
  const t = useTranslations("AdminCenters");
  const locale = useLocale();
  const path = `/${locale}${ROUTES.invite(token)}`;
  // Only ever rendered after the action resolves, i.e. on the client.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const href = `${origin}${path}`;
  return (
    <div className="flex flex-col gap-2">
      <FormMessage tone="success">{t("create.created")}</FormMessage>
      <CopyLinkField
        id="owner-invite-link"
        href={href}
        label={t("create.inviteLinkLabel")}
        hint={t("create.inviteLinkHint")}
        copyLabel={t("create.copy")}
        copiedLabel={t("create.copied")}
        failedLabel={t("create.copyFailed")}
      />
    </div>
  );
}

/**
 * Provisions a branch (F1, OD-12 (a)) in one of two ways through
 * `createCenterAction`: **New organization** — the branch founds its own
 * organization (a name of its own, or the branch's; a branch limit) and its
 * founding Owner is invited, the link shared manually exactly like
 * `/settings/staff`'s (email delivery stays out of Phase 1, docs/02 §3); or
 * **Add to an existing organization** — a searchable pick, refused at the
 * organization's limit until it is raised, inviting nobody because that
 * organization's Owner already resolves every branch under it.
 */
export function CreateCenterForm({ organizations }: { organizations: OrganizationOption[] }) {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>("new");
  const [state, formAction] = useGuardedActionState(
    createCenterAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  const organizationOptions = organizations.map((organization) => {
    const full = organization.usedBranches >= organization.maxBranches;
    const usage = t("create.organizationUsage", {
      used: formatNumber(organization.usedBranches, locale),
      max: formatNumber(organization.maxBranches, locale),
    });
    return {
      value: organization.id,
      label: locale === "en" && organization.nameEn ? organization.nameEn : organization.name,
      description: full ? t("create.organizationFull", { usage }) : usage,
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("create.title")}</CardTitle>
        <CardDescription>{t("create.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="organizationMode" value={mode} />

          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

          <div className="flex flex-col gap-1.5">
            <div
              role="group"
              aria-label={t("create.modeLabel")}
              className="flex h-11 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5 sm:max-w-md"
            >
              {(["new", "existing"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  disabled={value === "existing" && organizations.length === 0}
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex h-full min-w-11 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium",
                    "transition-ui focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                    mode === value
                      ? "bg-surface text-text-primary shadow-card"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
                  )}
                >
                  {value === "new" ? t("create.modeNew") : t("create.modeExisting")}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              {mode === "new" ? t("create.modeNewHint") : t("create.modeExistingHint")}
            </p>
          </div>

          {mode === "new" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-organization-name">{t("create.fields.organizationName")}</Label>
                <Input
                  id="create-organization-name"
                  name="organizationName"
                  aria-describedby="create-organization-name-hint"
                  aria-invalid={state.fieldErrors?.organizationName ? true : undefined}
                />
                <p id="create-organization-name-hint" className="text-xs text-text-muted">
                  {t("create.fields.organizationNameHint")}
                </p>
                {state.fieldErrors?.organizationName ? (
                  <FieldError>{tErrors(state.fieldErrors.organizationName)}</FieldError>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-organization-name-en">{t("create.fields.organizationNameEn")}</Label>
                <Input id="create-organization-name-en" name="organizationNameEn" dir="ltr" />
                {state.fieldErrors?.organizationNameEn ? (
                  <FieldError>{tErrors(state.fieldErrors.organizationNameEn)}</FieldError>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-organization-limit">{t("create.fields.maxBranches")}</Label>
                <Input
                  id="create-organization-limit"
                  name="maxBranches"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_BRANCH_LIMIT}
                  defaultValue={1}
                  dir="ltr"
                  aria-describedby="create-organization-limit-hint"
                  aria-invalid={state.fieldErrors?.maxBranches ? true : undefined}
                />
                <p id="create-organization-limit-hint" className="text-xs text-text-muted">
                  {t("create.fields.maxBranchesHint")}
                </p>
                {state.fieldErrors?.maxBranches ? (
                  <FieldError>{tErrors(state.fieldErrors.maxBranches)}</FieldError>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 sm:max-w-md">
              <Label htmlFor="create-organization-existing">{t("create.fields.organization")}</Label>
              <Combobox
                id="create-organization-existing"
                name="organizationId"
                options={organizationOptions}
                placeholder={t("create.organizationPicker.placeholder")}
                emptyLabel={t("create.organizationPicker.empty")}
                clearLabel={t("create.organizationPicker.clear")}
                openLabel={t("create.organizationPicker.open")}
                required
                aria-invalid={state.fieldErrors?.organizationId ? true : undefined}
              />
              <p className="text-xs text-text-muted">{t("create.fields.organizationHint")}</p>
              {state.fieldErrors?.organizationId ? (
                <FieldError>{tErrors(state.fieldErrors.organizationId)}</FieldError>
              ) : null}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-center-name">{t("create.fields.name")}</Label>
              <Input
                id="create-center-name"
                name="name"
                required
                aria-invalid={state.fieldErrors?.name ? true : undefined}
              />
              {state.fieldErrors?.name ? (
                <FieldError>{tErrors(state.fieldErrors.name)}</FieldError>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-center-name-en">{t("create.fields.nameEn")}</Label>
              <Input id="create-center-name-en" name="nameEn" dir="ltr" />
              {state.fieldErrors?.nameEn ? (
                <FieldError>{tErrors(state.fieldErrors.nameEn)}</FieldError>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-center-slug">{t("create.fields.slug")}</Label>
              <Input
                id="create-center-slug"
                name="slug"
                dir="ltr"
                required
                aria-invalid={state.fieldErrors?.slug ? true : undefined}
              />
              <p className="text-xs text-text-muted">{t("create.fields.slugHint")}</p>
              {state.fieldErrors?.slug ? (
                <FieldError>{tErrors(state.fieldErrors.slug)}</FieldError>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-center-theme">{t("create.fields.themeColor")}</Label>
              <input
                id="create-center-theme"
                name="themeColor"
                type="color"
                defaultValue={DEFAULT_THEME}
                className="h-11 w-full cursor-pointer rounded-lg border border-border bg-background p-1"
              />
              {state.fieldErrors?.themeColor ? (
                <FieldError>{tErrors(state.fieldErrors.themeColor)}</FieldError>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-center-logo">{t("create.fields.logo")}</Label>
              <Input
                id="create-center-logo"
                name="logo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="h-11"
              />
              <p className="text-xs text-text-muted">{t("create.fields.logoHint")}</p>
              {state.fieldErrors?.logo ? (
                <FieldError>{tErrors(state.fieldErrors.logo)}</FieldError>
              ) : null}
            </div>

            {mode === "new" ? (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="create-center-owner-email">
                  {t("create.fields.ownerEmail")}
                </Label>
                <Input
                  id="create-center-owner-email"
                  name="ownerEmail"
                  type="email"
                  spellCheck={false}
                  autoCapitalize="none"
                  inputMode="email"
                  dir="ltr"
                  required
                  aria-invalid={state.fieldErrors?.ownerEmail ? true : undefined}
                />
                <p className="text-xs text-text-muted">{t("create.fields.ownerEmailHint")}</p>
                {state.fieldErrors?.ownerEmail ? (
                  <FieldError>{tErrors(state.fieldErrors.ownerEmail)}</FieldError>
                ) : null}
              </div>
            ) : null}
          </div>

          <SubmitButton className="w-full sm:w-auto">
            {mode === "new" ? t("create.submit") : t("create.submitExisting")}
          </SubmitButton>
        </form>

        {state.status === "created" && state.invitationToken ? (
          <div className="mt-4">
            <InviteLink token={state.invitationToken} />
          </div>
        ) : null}
        {state.status === "branchAdded" ? (
          <div className="mt-4">
            <FormMessage tone="success">{t("create.branchAdded")}</FormMessage>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
