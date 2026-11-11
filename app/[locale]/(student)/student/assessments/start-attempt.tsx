"use client";

import { useState } from "react";
import { Play, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { startAttemptAction } from "@/app/[locale]/(student)/student/assessments/actions";
import { DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_START_STATE } from "@/lib/validation/student-assessments";

/**
 * Start, after a confirmation that says what is about to run (W3a, docs/04
 * §11.34): the title, class and branch, the duration, the window or deadline, that
 * the timer does not pause, and for a one-sitting exam what closing the page does.
 */
export function StartAttempt({
  assessmentId,
  title,
  classLabel,
  branchName,
  durationLine,
  windowLabel,
  windowValue,
  timed,
  oneSitting,
}: {
  assessmentId: string;
  title: string;
  classLabel: string;
  branchName: string;
  durationLine: string;
  windowLabel: string;
  windowValue: string;
  timed: boolean;
  oneSitting: boolean;
}) {
  const t = useTranslations("StudentAssessments");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useGuardedActionState(startAttemptAction, IDLE_START_STATE);

  return (
    <div className="flex flex-col gap-2">
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        size="narrow"
        trigger={
          <Button type="button" className="self-start">
            <Play className="size-4" aria-hidden />
            {t("start.label")}
          </Button>
        }
        title={t("start.title")}
        cancelLabel={t("start.cancel")}
        submitLabel={t("start.confirm")}
        submitPending={pending}
        formProps={{ action, onSubmit: () => setOpen(false) }}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="assessmentId" value={assessmentId} />
        <div className="flex flex-col gap-3 text-sm">
          <p dir="auto" className="break-words font-medium text-text-primary">{title}</p>
          <p className="text-text-secondary">{[classLabel, branchName].join(" · ")}</p>
          <dl className="flex flex-col gap-1 text-text-secondary">
            <div className="flex justify-between gap-3">
              <dt>{t("durationLabel")}</dt>
              <dd className="text-end font-medium text-text-primary">{durationLine}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>{windowLabel}</dt>
              <dd className="text-end font-medium text-text-primary">{windowValue}</dd>
            </div>
          </dl>
          <p className="text-text-secondary">{t(timed ? "start.noPause" : "start.resumable")}</p>
          {oneSitting ? (
            <FormMessage tone="warning">
              <span className="inline-flex items-center gap-2">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                {t("start.oneSitting")}
              </span>
            </FormMessage>
          ) : null}
        </div>
      </DialogShell>
      {state.error ? <FormMessage className="text-xs">{t(`errors.${state.error}`)}</FormMessage> : null}
    </div>
  );
}
