"use client";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROUTES } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const DEFAULT_THEME = "#2563EB";

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
 * Provisions a Center + its CenterSettings row + the founding Owner's
 * invitation in one flow (`createCenterAction` → `createCenterWithSettings`),
 * mirroring how `configureCenter` provisions a fresh center's config at M2 —
 * no per-center branching, one call does the whole thing. The invite link is
 * shared manually, exactly like `/settings/staff`'s invite form — email
 * delivery stays out of Phase 1 scope (docs/02 §3).
 */
export function CreateCenterForm() {
  const t = useTranslations("AdminCenters");
  const tErrors = useTranslations("AdminCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(
    createCenterAction,
    IDLE_ADMIN_ACTION_STATE,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("create.title")}</CardTitle>
        <CardDescription>{t("create.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="locale" value={locale} />

          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

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
          </div>

          <SubmitButton className="w-full sm:w-auto">{t("create.submit")}</SubmitButton>
        </form>

        {state.status === "created" && state.invitationToken ? (
          <div className="mt-4">
            <InviteLink token={state.invitationToken} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
