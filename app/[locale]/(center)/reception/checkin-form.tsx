"use client";

import { useActionState, useState } from "react";
import { UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { checkInAction } from "@/app/[locale]/(center)/reception/actions";
import {
  PaymentMethodSelector,
  type PaymentMethodOption,
} from "@/components/center/payment-method-selector";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";
import type { LiveSessionOption } from "@/app/[locale]/(center)/reception/live-session-rail";

/**
 * The Reception Desk's "one flow" (spec §4.1 item 8): pick a session and a
 * payment method, then one submit checks the student in and records the
 * payment via `checkInAction` (`attend = pay, or not counted`, spec §2/§5).
 * There is no attendance-status picker (R2): the server sets Present or Late
 * from the arrival time and the class's late threshold, and a wrong mark is
 * corrected afterwards from the session roster while the session is live.
 * The session is picked with plain selection state because this form's
 * single submit needs both values together.
 */
export function CheckInForm({
  studentProfileId,
  studentName,
  studentPhotoUrl,
  sessions,
  paymentMethods,
}: {
  studentProfileId: string;
  studentName: string;
  /** A short-lived signed URL, or null with no photo on file / Storage unset. */
  studentPhotoUrl: string | null;
  sessions: LiveSessionOption[];
  /** The centre's active methods (R1), oldest first. */
  paymentMethods: PaymentMethodOption[];
}) {
  const t = useTranslations("Reception");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();

  const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? "");
  const [state, formAction] = useActionState(checkInAction, IDLE_SESSION_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="flex items-center gap-3">
        {studentPhotoUrl ? (
          // A short-lived signed Storage URL, not a static/remote asset next/image can optimize.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={studentPhotoUrl}
            alt=""
            className="size-14 shrink-0 rounded-full border border-border object-cover"
          />
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle text-text-muted">
            <UserRound className="size-6" aria-hidden />
          </span>
        )}
        <p className="text-sm text-text-secondary">
          {t("checkingIn", { name: studentName })}
        </p>
      </div>

      {sessions.length === 0 ? (
        <FormMessage tone="info">{t("noLiveSessions")}</FormMessage>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">{t("sessionLabel")}</span>
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                onClick={() => setSessionId(session.sessionId)}
                aria-pressed={sessionId === session.sessionId}
                className={cn(
                  "flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-ui",
                  sessionId === session.sessionId
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-hover active:bg-surface-active",
                )}
              >
                <span className="min-w-0 truncate font-medium">{session.className}</span>
                <span className="shrink-0 tabular-nums" dir="ltr">
                  {formatTime(session.startTime, locale)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-secondary">{t("methodLabel")}</span>
        <PaymentMethodSelector methods={paymentMethods} />
        <p className="text-xs text-text-muted">{t("statusAuto")}</p>
      </div>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("checkedIn")}</FormMessage>
      ) : null}

      {sessions.length > 0 ? (
        <SubmitButton className="w-full sm:w-auto">{t("submit")}</SubmitButton>
      ) : null}
    </form>
  );
}
