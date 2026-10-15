"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
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
import { useGuardedActionState } from "@/lib/ui/action-feedback";

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
  const [submitState, submitAction, submitPending] = useGuardedActionState(
    submitSessionRatingAction,
    IDLE_RATING_STATE,
  );
  const [skipState, skipAction, skipPending] = useGuardedActionState(
    skipSessionRatingAction,
    IDLE_RATING_STATE,
  );

  useEffect(() => {
    if (submitState.status === "rated") onResolved();
  }, [submitState.status, onResolved]);

  useEffect(() => {
    if (skipState.status === "skipped") onResolved();
  }, [skipState.status, onResolved]);

  const [hovered, setHovered] = useState(0);
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

      {/* Stars, not numbers (docs/04 §11.5) — with the run up to the pointer
          filling as a preview, so the score is legible before it is committed.
          Still one submit per star: a click is the whole interaction, with no
          separate confirm step. */}
      <form
        action={submitAction}
        className="flex flex-wrap items-center gap-1"
        onMouseLeave={() => setHovered(0)}
      >
        <input type="hidden" name="sessionId" value={session.sessionId} />
        {SCORES.map((score) => (
          <button
            key={score}
            type="submit"
            name="score"
            value={score}
            disabled={pending}
            aria-label={t("scoreLabel", { score })}
            onMouseEnter={() => setHovered(score)}
            onFocus={() => setHovered(score)}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-lg",
              "transition-ui-fast focus-ring hover:bg-surface-hover active:bg-surface-active",
              "disabled:pointer-events-none disabled:opacity-50",
              score <= hovered ? "text-warning-fg" : "text-text-muted",
            )}
          >
            <Star
              className="size-6"
              aria-hidden
              fill={score <= hovered ? "currentColor" : "none"}
            />
          </button>
        ))}
      </form>

      {error ? <p className="text-xs text-danger-fg">{t(`errors.${error}`)}</p> : null}

      <form action={skipAction}>
        <input type="hidden" name="sessionId" value={session.sessionId} />
        <button
          type="submit"
          disabled={pending}
          // A real button of its own weight (docs/04 §11.5) — it had been
          // plain text that read as a caption.
          className={cn(
            "flex min-h-11 items-center rounded-lg border border-border-control bg-surface px-4 text-sm font-medium text-text-secondary",
            "transition-ui-fast focus-ring hover:border-border-control-hover hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {t("skip")}
        </button>
      </form>
    </div>
  );
}
