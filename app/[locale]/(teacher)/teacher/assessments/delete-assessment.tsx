"use client";

import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { assistantDeleteAssessmentAction } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/actions";
import { deleteAssessmentAction } from "@/app/[locale]/(teacher)/teacher/assessments/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { TEACHER_SURFACE, surfaceFields, type AssessmentSurface } from "@/lib/routes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ASSESSMENT_STATE } from "@/lib/validation/assessments";

/**
 * Delete a draft, or a published row no student has started, after a confirmation
 * that says what goes with it (docs/04 §14.6).
 */
export function DeleteAssessment({
  centerId,
  assessmentId,
  published,
  surface = TEACHER_SURFACE,
}: {
  centerId: string;
  assessmentId: string;
  published?: boolean;
  /** W7b: posts to the assistant's action on an assistant's page. */
  surface?: AssessmentSurface;
}) {
  const t = useTranslations(published ? "TeacherAssessments.published.delete" : "TeacherAssessments.builder.delete");
  const tErrors = useTranslations("TeacherAssessments.errors");
  const locale = useLocale();
  const [state, action] = useGuardedActionState(
    surface.kind === "assistant" ? assistantDeleteAssessmentAction : deleteAssessmentAction,
    IDLE_ASSESSMENT_STATE,
  );

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        label={t("label")}
        icon={<Trash2 className="size-4" aria-hidden />}
        variant="destructive"
        triggerClassName="self-start"
        title={t("title")}
        description={t("body")}
        action={action}
        fields={{ locale, centerId, assessmentId, ...surfaceFields(surface) }}
      />
      {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
    </div>
  );
}
