"use client";

import { useActionState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  removeStudentPhotoAction,
  uploadStudentPhotoAction,
} from "@/app/[locale]/(center)/students/actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";

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

  const [state, formAction] = useActionState(
    uploadStudentPhotoAction,
    IDLE_PEOPLE_STATE,
  );
  const [removeState, removeFormAction] = useActionState(
    removeStudentPhotoAction,
    IDLE_PEOPLE_STATE,
  );

  const error = state.error ?? removeState.error;

  return (
    <div className="flex flex-col gap-3">
      {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}

      <form action={formAction} className="flex flex-col gap-3">
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

      {hasPhoto ? (
        <form action={removeFormAction}>
          <input type="hidden" name="locale" value={locale} />
          <input
            type="hidden"
            name="studentProfileId"
            value={studentProfileId}
          />
          <SubmitButton variant="destructive" className="w-full sm:w-auto">
            <Trash2 className="size-4" />
            {t("remove")}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
