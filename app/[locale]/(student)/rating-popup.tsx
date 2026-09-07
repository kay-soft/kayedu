"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  skipSessionRatingAction,
  submitSessionRatingAction,
} from "@/app/[locale]/(student)/actions";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IDLE_RATING_STATE } from "@/lib/validation/ratings";
import { cn } from "@/lib/utils";

export type PendingRatingSessionView = {
  sessionId: string;
  date: string;
  centerName: string;
  teacherName: string;
  subjectName: string | null;
};

const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * The login pop-up (M17, spec §5 "Teacher ratings"): sessions this student
 * attended in the last 7 days that they haven't rated or skipped yet.
 * Genuinely skippable — closing the dialog (X, backdrop, Escape) never
 * writes anything, and an explicit "Skip" on one session persists server-side
 * (`skipSessionRatingAction`) so that exact session never resurfaces, on this
 * device or any other, at this login or any future one. Nothing here can
 * block navigation: it is an overlay over the ordinary student shell, not a
 * gate the rest of the app waits on.
 */
export function RatingPopup({ sessions }: { sessions: PendingRatingSessionView[] }) {
  const [remaining, setRemaining] = useState(sessions);
  const [open, setOpen] = useState(sessions.length > 0);

  const t = useTranslations("RatingPopup");

  if (remaining.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {remaining.map((session) => (
            <RatingRow
              key={session.sessionId}
              session={session}
              onResolved={() =>
                setRemaining((prev) => prev.filter((item) => item.sessionId !== session.sessionId))
              }
            />
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RatingRow({
  session,
  onResolved,
}: {
  session: PendingRatingSessionView;
  onResolved: () => void;
}) {
  const t = useTranslations("RatingPopup");
  const [submitState, submitAction, submitPending] = useActionState(
    submitSessionRatingAction,
    IDLE_RATING_STATE,
  );
  const [skipState, skipAction, skipPending] = useActionState(
    skipSessionRatingAction,
    IDLE_RATING_STATE,
  );

  useEffect(() => {
    if (submitState.status === "rated") onResolved();
  }, [submitState.status, onResolved]);

  useEffect(() => {
    if (skipState.status === "skipped") onResolved();
  }, [skipState.status, onResolved]);

  const pending = submitPending || skipPending;
  const error = submitState.error ?? skipState.error;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">
          {session.subjectName ?? t("session")}
        </p>
        <p className="truncate text-xs text-text-muted">
          {t("meta", { teacher: session.teacherName, center: session.centerName, date: session.date })}
        </p>
      </div>

      <form action={submitAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="sessionId" value={session.sessionId} />
        {SCORES.map((score) => (
          <button
            key={score}
            type="submit"
            name="score"
            value={score}
            disabled={pending}
            aria-label={t("scoreLabel", { score })}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-sm font-semibold text-text-primary",
              "hover:bg-surface-subtle disabled:opacity-50",
            )}
          >
            {score}
          </button>
        ))}
      </form>

      {error ? <p className="text-xs text-danger">{t(`errors.${error}`)}</p> : null}

      <form action={skipAction}>
        <input type="hidden" name="sessionId" value={session.sessionId} />
        <button
          type="submit"
          disabled={pending}
          className="text-xs font-medium text-text-muted underline hover:text-text-secondary disabled:opacity-50"
        >
          {t("skip")}
        </button>
      </form>
    </div>
  );
}
