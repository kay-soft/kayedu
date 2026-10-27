"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  removeProfilePhotoAction,
  updateProfilePhotoAction,
  type AccountFormState,
} from "@/app/[locale]/account/actions";
import { shrinkImageForUpload } from "@/components/center/resize-image";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAX_PHOTO_BYTES } from "@/lib/storage-paths";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

const IDLE: AccountFormState = {};

/**
 * Your own profile photo (F8). This preview is the one place the photo always
 * shows; elsewhere it appears only when `MEDIA_AVATARS_DISPLAY` is on.
 */
export function ProfilePhotoForm({ initials, photoSrc }: { initials: string; photoSrc: string | null }) {
  const t = useTranslations("Account.photo");
  const tErrors = useTranslations("Account.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(updateProfilePhotoAction, IDLE);
  const [removeState, removeFormAction] = useGuardedActionState(removeProfilePhotoAction, IDLE);
  useActionFeedback(state, { success: t("saved") });
  useActionFeedback(removeState, { success: t("removed") });

  const error = state.error ?? removeState.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <UserAvatar initials={initials} photoSrc={photoSrc} size="lg" />
          <p className="min-w-0 text-sm text-text-secondary">{t("visibility")}</p>
        </div>

        {error ? <FormMessage>{tErrors.has(error) ? tErrors(error) : tErrors("failed")}</FormMessage> : null}

        <form
          action={async (formData) => {
            const photo = formData.get("photo");
            if (photo instanceof File && photo.size > 0) {
              formData.set("photo", await shrinkImageForUpload(photo, MAX_PHOTO_BYTES));
            }
            formAction(formData);
          }}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="locale" value={locale} />
          <Field id="account-photo" label={t("label")} hint={t("hint")}>
            <Input
              id="account-photo"
              name="photo"
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

        {photoSrc ? (
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
