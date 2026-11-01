"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { removeCenterLogoAction, updateCenterLogoAction } from "@/app/[locale]/(center)/settings/actions";
import { shrinkImageForUpload } from "@/components/center/resize-image";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { ComingSoonNote } from "@/components/shared/coming-soon-note";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAX_LOGO_BYTES } from "@/lib/storage-paths";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

/**
 * Change or remove the branch logo (F8). The browser shrinks a large picture
 * first (D-27 (b)); the server re-checks the bytes, type and size.
 */
export function LogoForm({
  branchName,
  themeColor,
  logoSrc,
  uploadsEnabled,
}: {
  branchName: string;
  themeColor: string;
  logoSrc: string | null;
  /** `MEDIA_UPLOADS_ENABLED`: off, the controls say "Coming soon" and nothing is stored. */
  uploadsEnabled: boolean;
}) {
  const t = useTranslations("Settings.branding");
  const tToast = useTranslations("Toasts");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(updateCenterLogoAction, IDLE_ACTION_STATE);
  const [removeState, removeFormAction] = useGuardedActionState(removeCenterLogoAction, IDLE_ACTION_STATE);
  useActionFeedback(state, { success: tToast("logoSaved") });
  useActionFeedback(removeState, { success: tToast("logoRemoved") });

  const error = state.error ?? removeState.error;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <BrandAvatar name={branchName} logoUrl={logoSrc} themeColor={themeColor} size="lg" />
          <p className="min-w-0 break-words text-sm font-medium text-text-primary">{branchName}</p>
        </div>

        {!uploadsEnabled ? <ComingSoonNote /> : null}

        {uploadsEnabled && error ? <FormMessage>{t.has(`errors.${error}`) ? t(`errors.${error}`) : t("errors.failed")}</FormMessage> : null}

        {uploadsEnabled ? (
        <form
          action={async (formData) => {
            const logo = formData.get("logo");
            if (logo instanceof File && logo.size > 0) {
              formData.set("logo", await shrinkImageForUpload(logo, MAX_LOGO_BYTES, 512));
            }
            formAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="locale" value={locale} />
          <Field id="branch-logo" label={t("label")} hint={t("hint")}>
            <Input
              id="branch-logo"
              name="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              required
              className="py-2.5"
            />
          </Field>
          <SubmitButton className="w-full sm:w-auto sm:self-start">
            <ImageUp className="size-4" aria-hidden />
            {t("upload")}
          </SubmitButton>
        </form>
        ) : null}

        {uploadsEnabled && logoSrc ? (
          <ConfirmAction
            label={t("remove")}
            icon={<Trash2 className="size-4" aria-hidden />}
            variant="destructive"
            triggerClassName="w-full sm:w-auto sm:self-start"
            title={t("removeConfirm.title")}
            description={t("removeConfirm.body")}
            action={removeFormAction}
            fields={{ locale }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
