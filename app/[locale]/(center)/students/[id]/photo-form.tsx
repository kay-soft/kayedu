"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  removeStudentPhotoAction,
  uploadStudentPhotoAction,
} from "@/app/[locale]/(center)/students/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { shrinkImageForUpload } from "@/components/center/resize-image";
import { MAX_PHOTO_BYTES } from "@/lib/storage-paths";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The student's photo for their ID card. Stored in Supabase Storage under
 * `avatars/{centerId}/…` (docs/02 §10) and kept on `StudentProfile`, not on the
 * global `User`: a photo this center took for its own card is this center's
 * data, and must not follow the person to another center.
 */
export function PhotoForm({
  studentProfileId,
  hasPhoto,
}: {
  studentProfileId: string;
  hasPhoto: boolean;
}) {
  const t = useTranslations("Students.photo");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    uploadStudentPhotoAction,
    IDLE_PEOPLE_STATE,
  );
  const [removeState, removeFormAction] = useGuardedActionState(
    removeStudentPhotoAction,
    IDLE_PEOPLE_STATE,
  );
  const tToast = useTranslations("Toasts");
  useActionFeedback(state, { success: tToast("photoSaved") });
  useActionFeedback(removeState, { success: tToast("photoRemoved") });

  const error = state.error ?? removeState.error;

  return (
    <div className="flex flex-col gap-3">
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}

      <form
        action={async (formData) => {
          // D-27 (b): shrink a large phone photo before it is sent, so it
          // fits the ~1 MB cap instead of failing on upload.
          const photo = formData.get("photo");
          if (photo instanceof File && photo.size > 0) {
            formData.set("photo", await shrinkImageForUpload(photo, MAX_PHOTO_BYTES));
          }
          formAction(formData);
        }}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="locale" value={locale} />
        <input
          type="hidden"
          name="studentProfileId"
          value={studentProfileId}
        />

        <Field id="student-photo" label={t("label")} hint={t("hint")}>
          <Input
            id="student-photo"
            name="photo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            required
            className="py-2.5"
          />
        </Field>

        <div className="flex flex-col gap-2 sm:flex-row">
          <SubmitButton className="w-full sm:w-auto">
            <ImageUp className="size-4" />
            {t("upload")}
          </SubmitButton>
        </div>
      </form>

      {/* Removing deletes the stored file, so it asks first (docs/04 §14.6);
          it had been one tap. */}
      {hasPhoto ? (
        <ConfirmAction
          label={t("remove")}
          icon={<Trash2 className="size-4" aria-hidden />}
          variant="destructive"
          triggerClassName="w-full sm:w-auto sm:self-start"
          title={t("removeConfirm.title")}
          description={t("removeConfirm.body")}
          action={removeFormAction}
          fields={{ locale, studentProfileId }}
        />
      ) : null}
    </div>
  );
}
