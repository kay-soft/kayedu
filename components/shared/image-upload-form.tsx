"use client";

import { useId, type ReactNode } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { shrinkImageForUpload } from "@/components/center/resize-image";
import { ComingSoonNote } from "@/components/shared/coming-soon-note";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ACTION_STATE, type ActionState } from "@/lib/validation/form";

type Kind = "teacherPhoto" | "classCover";

type ServerAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The upload / remove controls for a teacher's photo or a class cover (U9) —
 * the one component behind both, the same shape the branch logo form uses: the
 * browser shrinks a large picture first (D-27 (b)), the server re-checks the
 * bytes, type and size. Messages live under `Media.<kind>`.
 *
 * `enabled` is the server's `MEDIA_UPLOADS_ENABLED`: off, the controls are
 * replaced by a "Coming soon" note and nothing can be sent.
 */
export function ImageUploadForm({
  kind,
  enabled,
  hasImage,
  uploadAction,
  removeAction,
  fields,
  fieldName,
  maxBytes,
  maxEdge,
  children,
}: {
  kind: Kind;
  enabled: boolean;
  hasImage: boolean;
  uploadAction: ServerAction;
  removeAction: ServerAction;
  /** Hidden fields posted with both actions (ids — each action re-resolves and re-checks them). */
  fields: Record<string, string>;
  /** The file input's name, as the upload action reads it. */
  fieldName: string;
  maxBytes: number;
  maxEdge: number;
  /** Extra controls inside the upload form (the teacher's "all my branches" box). */
  children?: ReactNode;
}) {
  const t = useTranslations(`Media.${kind}`);
  const tMedia = useTranslations("Media");
  const locale = useLocale();
  const inputId = useId();

  const [state, formAction] = useGuardedActionState(uploadAction, IDLE_ACTION_STATE);
  const [removeState, removeFormAction] = useGuardedActionState(removeAction, IDLE_ACTION_STATE);
  useActionFeedback(state, { success: t("saved") });
  useActionFeedback(removeState, { success: t("removed") });

  if (!enabled) return <ComingSoonNote />;

  const error = state.error ?? removeState.error;

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <FormMessage>{tMedia.has(`errors.${error}`) ? tMedia(`errors.${error}`) : tMedia("errors.failed")}</FormMessage>
      ) : null}

      <form
        action={async (formData) => {
          const file = formData.get(fieldName);
          if (file instanceof File && file.size > 0) {
            formData.set(fieldName, await shrinkImageForUpload(file, maxBytes, maxEdge));
          }
          formAction(formData);
        }}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="locale" value={locale} />
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Field id={inputId} label={t("label")} hint={t("hint")}>
          <Input
            id={inputId}
            name={fieldName}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            required
            className="py-2.5"
          />
        </Field>
        {children}
        <SubmitButton className="w-full sm:w-auto sm:self-start">
          <ImageUp className="size-4" aria-hidden />
          {t("upload")}
        </SubmitButton>
      </form>

      {hasImage ? (
        <ConfirmAction
          label={t("remove")}
          icon={<Trash2 className="size-4" aria-hidden />}
          variant="destructive"
          triggerClassName="w-full sm:w-auto sm:self-start"
          title={t("removeConfirm.title")}
          description={t("removeConfirm.body")}
          action={removeFormAction}
          fields={{ locale, ...fields }}
        />
      ) : null}
    </div>
  );
}
