"use client";

import { useState } from "react";
import { CalendarClock, Send, Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  extendAssessmentAction,
  publishAssessmentAction,
  unpublishAssessmentAction,
} from "@/app/[locale]/(teacher)/teacher/assessments/publish-actions";
import {
  assistantExtendAssessmentAction,
  assistantPublishAssessmentAction,
  assistantUnpublishAssessmentAction,
} from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { TimePicker } from "@/components/ui/time-picker";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { TEACHER_SURFACE, surfaceFields, type AssessmentSurface } from "@/lib/routes";
import { IDLE_ASSESSMENT_STATE } from "@/lib/validation/assessments";

/** W7b: `surface` (default the teacher) picks the teacher's action or the assistant's. */
type Identity = { centerId: string; assessmentId: string; surface?: AssessmentSurface };

/** Publish the last saved version, after a confirmation. Disabled until it is ready. */
export function PublishAssessment({ centerId, assessmentId, ready, surface = TEACHER_SURFACE }: Identity & { ready: boolean }) {
  const t = useTranslations("TeacherAssessments.publish");
  const tErrors = useTranslations("TeacherAssessments.errors");
  const locale = useLocale();
  const [state, action] = useGuardedActionState(
    surface.kind === "assistant" ? assistantPublishAssessmentAction : publishAssessmentAction,
    IDLE_ASSESSMENT_STATE,
  );
  useActionFeedback(state, { success: () => t("done") });

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        label={t("label")}
        icon={<Send className="size-4" aria-hidden />}
        variant="default"
        tone="default"
        triggerClassName="self-start"
        disabled={!ready}
        title={t("title")}
        description={t("body")}
        action={action}
        fields={{ locale, centerId, assessmentId, ...surfaceFields(surface) }}
      />
      {!ready ? <p className="text-xs text-text-muted">{t("notReadyHint")}</p> : null}
      {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
    </div>
  );
}

/** Back to a draft, only while no student has started. */
export function UnpublishAssessment({ centerId, assessmentId, surface = TEACHER_SURFACE }: Identity) {
  const t = useTranslations("TeacherAssessments.unpublish");
  const tErrors = useTranslations("TeacherAssessments.errors");
  const locale = useLocale();
  const [state, action] = useGuardedActionState(
    surface.kind === "assistant" ? assistantUnpublishAssessmentAction : unpublishAssessmentAction,
    IDLE_ASSESSMENT_STATE,
  );
  useActionFeedback(state, { success: () => t("done") });

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        label={t("label")}
        icon={<Undo2 className="size-4" aria-hidden />}
        variant="outline"
        tone="default"
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

/** A later closing time or deadline: the only change allowed once students have started (D-W08). */
export function ExtendAssessment({
  centerId,
  assessmentId,
  zone,
  todayIso,
  current,
  surface = TEACHER_SURFACE,
}: Identity & { zone: string; todayIso: string; current: { date: string; time: string } }) {
  const t = useTranslations("TeacherAssessments.extend");
  const tErrors = useTranslations("TeacherAssessments.errors");
  const locale = useLocale();
  const [state, action] = useGuardedActionState(
    surface.kind === "assistant" ? assistantExtendAssessmentAction : extendAssessmentAction,
    IDLE_ASSESSMENT_STATE,
  );
  useActionFeedback(state, { success: () => t("done") });
  const [time, setTime] = useState(current.time);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />
      <input type="hidden" name="assessmentId" value={assessmentId} />
      {Object.entries(surfaceFields(surface)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="text-xs text-text-muted">{t("zone", { zone })}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="extend-date" className="text-xs text-text-secondary">{t("date")}</Label>
          <DatePicker id="extend-date" name="date" defaultValue={current.date} todayIso={todayIso} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="extend-time" className="text-xs text-text-secondary">{t("time")}</Label>
          <TimePicker id="extend-time" name="time" value={time} onValueChange={setTime} />
        </div>
      </div>
      {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
      <SubmitButton variant="outline" className="self-start" pendingLabel={t("saving")}>
        <CalendarClock className="size-4" aria-hidden />
        {t("label")}
      </SubmitButton>
    </form>
  );
}
