"use client";

import { useActionState, useState } from "react";
import { UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { checkInAction } from "@/app/[locale]/(center)/reception/actions";
import type { AttendanceStatusValue } from "@/components/center/attendance-control";
import { PaymentMethodSelector } from "@/components/center/payment-method-selector";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { cn } from "@/lib/utils";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";
import type { LiveSessionOption } from "@/app/[locale]/(center)/reception/live-session-rail";

const STATUS_ORDER: AttendanceStatusValue[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED"];

const TINT: Record<AttendanceStatusValue, string> = {
  PRESENT: "bg-success-bg text-success ring-1 ring-success/30",
  LATE: "bg-warning-bg text-warning ring-1 ring-warning/30",
  ABSENT: "bg-danger-bg text-danger ring-1 ring-danger/30",
  EXCUSED: "bg-info-bg text-info ring-1 ring-info/30",
};

/**
 * The Reception Desk's "one flow" (spec §4.1 item 8): pick a session, an
 * attendance status and — only for PRESENT/LATE — a payment method, then one
 * submit does both writes via `checkInAction` (`attend = pay, or not
 * counted`, spec §2/§5). Session and status are picked with plain selection
 * state (not per-click submits like the roster's Attendance control) because
 * this form's single submit needs all three values together.
 */
export function CheckInForm({
  studentProfileId,
  studentName,
  studentPhotoUrl,
  sessions,
}: {
  studentProfileId: string;
  studentName: string;
  /** A short-lived signed URL, or null with no photo on file / Storage unset. */
  studentPhotoUrl: string | null;
  sessions: LiveSessionOption[];
}) {
  const t = useTranslations("Reception");
  const tAttendance = useTranslations("Sessions.attendance");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();

  const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? "");
  const [status, setStatus] = useState<AttendanceStatusValue>("PRESENT");
  const [state, formAction] = useActionState(checkInAction, IDLE_SESSION_STATE);

  const payable = status === "PRESENT" || status === "LATE";

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="status" value={status} />

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
                  "flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors",
                  sessionId === session.sessionId
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border bg-surface text-text-secondary hover:bg-surface-subtle",
                )}
              >
                <span className="min-w-0 truncate font-medium">{session.className}</span>
                <span className="shrink-0 tabular-nums" dir="ltr">
                  {session.startTime}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-secondary">{t("statusLabel")}</span>
        <div className="inline-flex flex-wrap gap-1.5" role="group" aria-label={tAttendance("groupLabel")}>
          {STATUS_ORDER.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              aria-pressed={status === value}
              className={cn(
                "min-h-12 min-w-12 rounded-lg px-4 text-base font-medium transition-colors",
                status === value
                  ? TINT[value]
                  : "border border-border bg-surface text-text-secondary hover:bg-surface-subtle",
              )}
            >
              {tAttendance(value)}
            </button>
          ))}
        </div>
      </div>

      {payable ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">{t("methodLabel")}</span>
          <PaymentMethodSelector />
        </div>
      ) : null}

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
