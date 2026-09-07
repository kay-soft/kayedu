"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  cancelSessionAction,
  rescheduleSessionAction,
} from "@/app/[locale]/(center)/sessions/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

/**
 * Cancel / reschedule a session (spec §7 acceptance criterion 11, closing the
 * gap flagged since M5 — docs/02 §11). Cancelling never touches money or
 * attendance rows (CLAUDE.md rule 2); a manager who needs that too uses the
 * roster's own void/correct controls, unchanged. `canCancel`/`canReschedule`
 * only hide controls — the server actions re-check every permission.
 *
 * `locked` (M15) covers both terminal states a session can reach here:
 * CANCELLED (it never happened) and RESCHEDULED (it moved to a replacement,
 * `rescheduledToId` — the replacement's own detail page is where cancel/
 * reschedule become available again, not this one).
 */
export function SessionLifecycleActions({
  sessionId,
  date,
  startTime,
  endTime,
  locked,
  canCancel,
  canReschedule,
}: {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  locked: boolean;
  canCancel: boolean;
  canReschedule: boolean;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();

  const [cancelState, cancelFormAction] = useActionState(
    cancelSessionAction,
    IDLE_SESSION_STATE,
  );
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleState, rescheduleFormAction] = useActionState(
    rescheduleSessionAction,
    IDLE_SESSION_STATE,
  );

  if (locked || (!canCancel && !canReschedule)) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {canReschedule ? (
          <button
            type="button"
            onClick={() => setRescheduleOpen((open) => !open)}
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-xs font-medium text-text-secondary hover:bg-surface-subtle"
          >
            {t("reschedule")}
          </button>
        ) : null}
        {canCancel ? (
          <form action={cancelFormAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <SubmitButton variant="destructive">{t("cancel")}</SubmitButton>
          </form>
        ) : null}
      </div>
      {cancelState.error ? <FormMessage>{tErrors(cancelState.error)}</FormMessage> : null}

      {rescheduleOpen ? (
        <form
          action={rescheduleFormAction}
          className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-end"
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="sessionId" value={sessionId} />
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("fields.date")}
            <input
              type="date"
              name="date"
              defaultValue={date}
              required
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("fields.startTime")}
            <input
              type="time"
              name="startTime"
              defaultValue={startTime}
              required
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("fields.endTime")}
            <input
              type="time"
              name="endTime"
              defaultValue={endTime}
              required
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <SubmitButton>{t("save")}</SubmitButton>
        </form>
      ) : null}
      {rescheduleState.error ? (
        <FormMessage>{tErrors(rescheduleState.error)}</FormMessage>
      ) : null}
      {rescheduleState.status === "rescheduled" ? (
        <>
          {rescheduleState.conflicts && rescheduleState.conflicts.length > 0 ? (
            <FormMessage tone="warning">
              {t("rescheduledWithConflict", {
                count: rescheduleState.conflicts.length,
              })}
            </FormMessage>
          ) : (
            <FormMessage tone="info">{t("rescheduled")}</FormMessage>
          )}
          {rescheduleState.newSessionId ? (
            <Link
              href={ROUTES.centerSession(rescheduleState.newSessionId)}
              className="text-sm font-medium text-brand hover:underline"
            >
              {t("viewNewSession")}
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
