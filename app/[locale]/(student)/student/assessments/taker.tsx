"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Clock, ListChecks, RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  attemptHeartbeatAction,
  saveAnswerAction,
  submitAttemptAction,
} from "@/app/[locale]/(student)/student/assessments/actions";
import { DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StudentTaking } from "@/lib/db/assessment-attempts";
import { formatNumber, formatTwoDigits } from "@/lib/format";
import { logBestEffort } from "@/lib/log";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * The taking screen (W3a, docs/04 §11.34): one question at a time, a grid of
 * every question with answered markers, a sticky header with the countdown and
 * the saved indicator, a review screen, and a confirmation before submit.
 *
 * Nothing here decides anything. It receives the student shape only (rule 11).
 * The countdown is `endsAtMs − serverNowMs` from the server, run on a monotonic
 * clock, so the device's clock never moves it (D-W09), and every answer of the
 * server re-anchors it. When it ends the client submits, but the server is
 * authoritative regardless. A one-sitting exam also sends a heartbeat and a beacon when the page closes; a reload counts as closing, because
 * a browser cannot tell the two apart.
 */
export function AssessmentTaker({
  title,
  oneSitting,
  timed,
  heartbeatSeconds,
  taking,
}: {
  title: string;
  oneSitting: boolean;
  timed: boolean;
  heartbeatSeconds: number;
  taking: StudentTaking;
}) {
  const t = useTranslations("StudentAssessments.take");
  const tErrors = useTranslations("StudentAssessments.errors");
  const locale = useLocale();
  const router = useRouter();
  const { attemptId, questions } = taking;

  const [answers, setAnswers] = useState<Record<string, string | null>>(taking.answers);
  const [index, setIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftMs, setLeftMs] = useState(taking.clock.endsAtMs - taking.clock.serverNowMs);

  const done = useRef(false);
  const queue = useRef(new Map<string, string | null>());
  const draining = useRef<Promise<boolean> | null>(null);
  const anchor = useRef({ leftMs: taking.clock.endsAtMs - taking.clock.serverNowMs, at: 0 });

  /** The attempt is over (the server said so, or the submit went through): show the result. */
  const finish = useCallback(() => {
    done.current = true;
    router.refresh();
  }, [router]);

  /** Sends the queued answers in order. True when nothing is left unsaved. */
  const drain = useCallback((): Promise<boolean> => {
    if (draining.current) return draining.current;
    const run = (async () => {
      if (queue.current.size === 0) return true;
      setSave("saving");
      try {
        while (queue.current.size > 0) {
          const [questionId, optionId] = queue.current.entries().next().value as [string, string | null];
          const result = await saveAnswerAction(attemptId, questionId, optionId);
          if (!result.ok && result.error === "submitted") {
            finish();
            return false;
          }
          if (!result.ok && result.error !== "invalidOption" && result.error !== "notFound") {
            setSave("failed");
            return false;
          }
          if (queue.current.get(questionId) === optionId) queue.current.delete(questionId);
        }
        setSave("saved");
        return true;
      } catch {
        setSave("failed");
        return false;
      }
    })();
    draining.current = run;
    void run.finally(() => {
      draining.current = null;
    });
    return run;
  }, [attemptId, finish]);

  /** `force`: the countdown ended, so what was saved is submitted either way. */
  const submit = useCallback(async (force = false) => {
    if (done.current) return;
    setSubmitting(true);
    setError(null);
    const saved = await drain();
    if (done.current) return;
    if (!saved && !force) {
      setError("network");
      setSubmitting(false);
      return;
    }
    try {
      const result = await submitAttemptAction(locale, attemptId);
      if (result.ok) {
        finish();
        return;
      }
      setError(result.error);
    } catch {
      setError("network");
    }
    setSubmitting(false);
  }, [attemptId, drain, finish, locale]);

  const reanchor = useCallback((clock: { endsAtMs: number; serverNowMs: number }) => {
    anchor.current = { leftMs: clock.endsAtMs - clock.serverNowMs, at: performance.now() };
  }, []);

  const beat = useCallback(async () => {
    if (done.current) return;
    try {
      const result = await attemptHeartbeatAction(attemptId);
      if (result.ok) reanchor(result as { endsAtMs: number; serverNowMs: number });
      else if (result.error === "submitted") finish();
    } catch (cause) {
      // Nothing to show the student: the next heartbeat, or the grace, covers it.
      logBestEffort("assessment heartbeat")(cause);
    }
  }, [attemptId, finish, reanchor]);

  // The countdown: a monotonic clock from the server's remaining time.
  useEffect(() => {
    anchor.current = { leftMs: taking.clock.endsAtMs - taking.clock.serverNowMs, at: performance.now() };
    let expired = false;
    const tick = () => {
      const left = anchor.current.leftMs - (performance.now() - anchor.current.at);
      setLeftMs(Math.max(0, left));
      if (left <= 0 && !expired && !done.current) {
        expired = true;
        void submit(true);
      }
    };
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [submit, taking.clock.endsAtMs, taking.clock.serverNowMs]);

  // Coming back to the tab asks the server for the time again: timers sleep in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [beat]);

  // Saving again as soon as the connection returns.
  useEffect(() => {
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [drain]);

  // One sitting: the heartbeat, the warning and the beacon (D-W02, D-W31).
  useEffect(() => {
    if (!oneSitting) return;
    const heartbeat = window.setInterval(() => void beat(), heartbeatSeconds * 1_000);
    const warn = (event: BeforeUnloadEvent) => {
      if (done.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const close = (event: PageTransitionEvent) => {
      if (event.persisted || done.current) return;
      navigator.sendBeacon(ROUTES.assessmentAttemptClose(attemptId));
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", close);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", close);
    };
  }, [attemptId, beat, heartbeatSeconds, oneSitting]);

  const choose = (questionId: string, optionId: string | null) => {
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
    queue.current.delete(questionId);
    queue.current.set(questionId, optionId);
    void drain();
  };

  const isAnswered = (questionId: string) => (answers[questionId] ?? null) !== null;
  const unanswered = questions.filter((question) => !isAnswered(question.id)).length;
  const total = questions.length;
  const current = questions[Math.min(index, total - 1)];

  const seconds = Math.ceil(leftMs / 1_000);
  const days = Math.floor(seconds / 86_400);
  const clock = [
    days > 0 ? `${formatNumber(days, locale)}${t("daysShort")}` : null,
    [Math.floor((seconds % 86_400) / 3_600), Math.floor((seconds % 3_600) / 60), seconds % 60]
      .map((part) => formatTwoDigits(part, locale))
      .join(":"),
  ]
    .filter(Boolean)
    .join(" ");

  const grid = (
    <nav aria-label={t("gridLabel")}>
      <ul className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {questions.map((question, position) => {
          const answered = isAnswered(question.id);
          const here = !reviewing && position === index;
          return (
            <li key={question.id}>
              <button
                type="button"
                aria-current={here ? "step" : undefined}
                aria-label={t(answered ? "gridAnswered" : "gridUnanswered", { n: position + 1 })}
                onClick={() => {
                  setIndex(position);
                  setReviewing(false);
                }}
                className={cn(
                  "relative flex h-11 w-full items-center justify-center rounded-lg border border-border text-sm font-medium tabular-nums text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  answered && "border-brand bg-brand/10",
                  here && "ring-2 ring-brand",
                )}
              >
                {formatNumber(position + 1, locale)}
                {answered ? <Check className="absolute end-0.5 top-0.5 size-3 text-brand" aria-hidden /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="flex flex-col">
      <header className="sticky top-16 z-10 -mx-4 -mt-4 flex sm:-mt-6 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 shadow-card sm:-mx-6 sm:px-6">
        <div className="flex min-w-0 flex-col">
          <h1 dir="auto" className="truncate text-sm font-medium text-text-primary">{title}</h1>
          <span className="flex flex-wrap items-center gap-2 text-xs text-text-secondary" aria-live="polite">
            {save === "saving" ? t("saving") : null}
            {save === "saved" ? t("saved") : null}
            {save === "idle" ? t("autosaves") : null}
            {save === "failed" ? (
              <button
                type="button"
                onClick={() => void drain()}
                className="inline-flex min-h-11 items-center gap-1 font-medium text-danger-fg underline"
              >
                <RefreshCw className="size-3" aria-hidden />
                {t("saveFailed")}
              </button>
            ) : null}
          </span>
        </div>
        <div
          role="timer"
          aria-live="off"
          aria-label={t(timed ? "timeLeft" : "timeUntilDeadline")}
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-sm font-semibold tabular-nums text-text-primary",
            seconds <= 300 && "text-warning-fg",
            seconds <= 60 && "text-danger-fg",
          )}
        >
          <Clock className="size-4" aria-hidden />
          <span dir="ltr">{clock}</span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-4">
        {oneSitting ? (
          <FormMessage tone="warning">
            <span className="inline-flex items-center gap-2">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {t("oneSittingReminder")}
            </span>
          </FormMessage>
        ) : null}

        {error ? <FormMessage>{tErrors(error)}</FormMessage> : null}

        {reviewing ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("reviewTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <p className="text-text-secondary">
                {t("reviewCounts", { answered: total - unanswered, total })}
              </p>
              {grid}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                  <span>{t("questionOf", { n: index + 1, total })}</span>
                  <span>{t("pointsLabel", { count: current.points })}</span>
                </div>
                <p dir="auto" className="whitespace-pre-line break-words text-base font-medium text-text-primary">{current.text}</p>
                <div role="radiogroup" aria-label={t("questionOf", { n: index + 1, total })} className="flex flex-col gap-2">
                  {current.options.map((option) => (
                    <label
                      key={option.id}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 py-2 hover:bg-surface-hover has-[:checked]:border-brand has-[:checked]:bg-brand/5"
                    >
                      <input
                        type="radio"
                        name={`answer-${current.id}`}
                        checked={answers[current.id] === option.id}
                        onChange={() => choose(current.id, option.id)}
                        className="size-5 shrink-0 accent-brand"
                      />
                      <span dir="auto" className="min-w-0 break-words text-sm text-text-primary">{option.text}</span>
                    </label>
                  ))}
                </div>
                {isAnswered(current.id) ? (
                  <Button type="button" variant="ghost" className="self-start" onClick={() => choose(current.id, null)}>
                    {t("clearAnswer")}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardContent>{grid}</CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-2 border-t border-border bg-surface px-4 py-3 shadow-card sm:-mx-6 sm:px-6">
        {reviewing ? (
          <>
            <Button type="button" variant="outline" onClick={() => setReviewing(false)}>
              {t("backToQuestions")}
            </Button>
            <DialogShell
              open={confirming}
              onOpenChange={setConfirming}
              size="narrow"
              trigger={<Button type="button" disabled={submitting}>{t("submit")}</Button>}
              title={t("confirmTitle")}
              description={unanswered > 0 ? t("confirmUnanswered", { count: unanswered }) : t("confirmAllAnswered")}
              cancelLabel={t("keepGoing")}
              submitLabel={t("submit")}
              submitPending={submitting}
              formProps={{
                onSubmit: (event) => {
                  event.preventDefault();
                  setConfirming(false);
                  void submit();
                },
              }}
            >
              <p className="text-sm text-text-secondary">{t("confirmFinal")}</p>
            </DialogShell>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={index === 0} onClick={() => setIndex((value) => value - 1)}>
              <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
              {t("previous")}
            </Button>
            {index < total - 1 ? (
              <Button type="button" variant="outline" onClick={() => setIndex((value) => value + 1)}>
                {t("next")}
                <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
              </Button>
            ) : (
              <Button type="button" onClick={() => setReviewing(true)}>
                <ListChecks className="size-4" aria-hidden />
                {t("review")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
