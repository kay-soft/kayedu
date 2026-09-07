"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Ban, Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  recordPaymentAction,
  refundPaymentAction,
  setAttendanceAction,
  voidPaymentAction,
} from "@/app/[locale]/(center)/sessions/actions";
import {
  AttendanceControl,
  type AttendanceStatusValue,
} from "@/components/center/attendance-control";
import {
  PaymentMethodSelector,
  type PaymentMethodValue,
} from "@/components/center/payment-method-selector";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

export type RosterRowData = {
  studentProfileId: string;
  attendeeId: string | null;
  name: string;
  studentCode: string;
  isDropIn: boolean;
  status: AttendanceStatusValue | null;
  payment: { id: string; amount: number; method: PaymentMethodValue; refunded: boolean } | null;
  consecutiveAbsences: number;
};

/**
 * The session roster (spec §4.1 item 7): every actively-enrolled student
 * (marked or not) plus any drop-ins, each with the Attendance control and,
 * once PRESENT/LATE, the money — record a payment, void one already
 * recorded, or (M14) refund one already recorded. `canCorrect`/
 * `canRecordPayment`/`canVoid`/`canRefund` only hide controls; the server
 * actions re-check every permission (docs/02 §6).
 */
export function SessionRoster({
  sessionId,
  rows,
  canCorrect,
  canRecordPayment,
  canVoid,
  canRefund,
  allowExcused,
  readOnly = false,
}: {
  sessionId: string;
  rows: RosterRowData[];
  canCorrect: boolean;
  canRecordPayment: boolean;
  canVoid: boolean;
  canRefund: boolean;
  allowExcused: boolean;
  /** Cancelled or already-rescheduled (M15) — no attendance/payment control renders. */
  readOnly?: boolean;
}) {
  const t = useTranslations("Sessions.roster");

  if (rows.length === 0) {
    return <p className="text-sm text-text-muted">{t("empty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <AttendeeRow
          key={row.studentProfileId}
          sessionId={sessionId}
          row={row}
          canCorrect={canCorrect}
          canRecordPayment={canRecordPayment}
          canVoid={canVoid}
          canRefund={canRefund}
          allowExcused={allowExcused}
          readOnly={readOnly}
        />
      ))}
    </ul>
  );
}

function AttendeeRow({
  sessionId,
  row,
  canCorrect,
  canRecordPayment,
  canVoid,
  canRefund,
  allowExcused,
  readOnly,
}: {
  sessionId: string;
  row: RosterRowData;
  canCorrect: boolean;
  canRecordPayment: boolean;
  canVoid: boolean;
  canRefund: boolean;
  allowExcused: boolean;
  readOnly: boolean;
}) {
  const t = useTranslations("Sessions.roster");
  const tErrors = useTranslations("Sessions.errors");
  const tAttendance = useTranslations("Sessions.attendance");
  const locale = useLocale();

  const [attendanceState, attendanceFormAction, attendancePending] =
    useActionState(setAttendanceAction, IDLE_SESSION_STATE);
  const [paymentState, paymentFormAction] = useActionState(
    recordPaymentAction,
    IDLE_SESSION_STATE,
  );
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidState, voidFormAction] = useActionState(
    voidPaymentAction,
    IDLE_SESSION_STATE,
  );
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundState, refundFormAction] = useActionState(
    refundPaymentAction,
    IDLE_SESSION_STATE,
  );

  const alreadyMarked = row.status !== null;
  const attendanceLocked = alreadyMarked && !canCorrect;
  const payable = row.status === "PRESENT" || row.status === "LATE";

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={ROUTES.centerStudent(row.studentProfileId)}
            className="truncate text-sm font-medium text-brand hover:underline"
          >
            {row.name}
          </Link>
          <p className="flex items-center gap-2 text-xs text-text-muted" dir="ltr">
            <span>{row.studentCode}</span>
            {row.isDropIn ? (
              <Badge variant="info">{t("dropIn")}</Badge>
            ) : null}
          </p>
        </div>
      </div>

      {row.consecutiveAbsences >= 2 ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("consecutiveAbsentAlert", { count: row.consecutiveAbsences })}
        </p>
      ) : null}

      {readOnly ? (
        <Badge variant="neutral">
          {row.status ? tAttendance(row.status) : t("unmarked")}
        </Badge>
      ) : (
        <>
          <AttendanceControl
            formAction={attendanceFormAction}
            value={row.status}
            pending={attendancePending || attendanceLocked}
            allowExcused={allowExcused}
            hiddenFields={
              <>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="sessionId" value={sessionId} />
                <input type="hidden" name="studentProfileId" value={row.studentProfileId} />
              </>
            }
          />
          {attendanceState.error ? (
            <FormMessage>{tErrors(attendanceState.error)}</FormMessage>
          ) : null}
        </>
      )}

      {readOnly ? (
        row.payment ? (
          <p className="text-sm font-medium text-success">
            {t("paid", {
              amount: formatMoney(row.payment.amount, locale),
              method: t(`method.${row.payment.method}`),
            })}
          </p>
        ) : null
      ) : payable ? (
        row.payment ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-success-bg px-3 py-2">
            <p className="text-sm font-medium text-success">
              {t("paid", {
                amount: formatMoney(row.payment.amount, locale),
                method: t(`method.${row.payment.method}`),
              })}
              {row.payment.refunded ? (
                <span className="ms-2 inline-flex items-center rounded-full bg-info-bg px-2 py-0.5 text-xs font-medium text-info">
                  {t("refunded")}
                </span>
              ) : null}
            </p>
            {row.payment.refunded ? null : (
              <div className="flex flex-wrap items-center gap-2">
                {canVoid ? (
                  voidOpen ? (
                    <form
                      action={voidFormAction}
                      className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"
                    >
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="paymentId" value={row.payment.id} />
                      <input
                        type="text"
                        name="reason"
                        required
                        maxLength={200}
                        placeholder={t("voidReasonPlaceholder")}
                        className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
                      />
                      <SubmitButton variant="destructive">
                        {t("confirmVoid")}
                      </SubmitButton>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setVoidOpen(true)}
                      className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-xs font-medium text-danger hover:bg-danger-bg"
                    >
                      <Ban className="size-3.5" aria-hidden />
                      {t("void")}
                    </button>
                  )
                ) : null}
                {canRefund ? (
                  refundOpen ? (
                    <form
                      action={refundFormAction}
                      className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row"
                    >
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="paymentId" value={row.payment.id} />
                      <input
                        type="text"
                        name="reason"
                        required
                        maxLength={200}
                        placeholder={t("refundReasonPlaceholder")}
                        className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
                      />
                      <SubmitButton variant="destructive">
                        {t("confirmRefund")}
                      </SubmitButton>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRefundOpen(true)}
                      className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-xs font-medium text-info hover:bg-info-bg"
                    >
                      <Undo2 className="size-3.5" aria-hidden />
                      {t("refund")}
                    </button>
                  )
                ) : null}
              </div>
            )}
          </div>
        ) : canRecordPayment ? (
          <form
            action={paymentFormAction}
            className="flex flex-col gap-2 border-t border-border-subtle pt-3"
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionAttendeeId" value={row.attendeeId ?? ""} />
            <PaymentMethodSelector />
            <SubmitButton className="w-full sm:w-auto" variant="outline">
              {t("recordPayment")}
            </SubmitButton>
          </form>
        ) : null
      ) : null}
      {paymentState.error ? (
        <FormMessage>{tErrors(paymentState.error)}</FormMessage>
      ) : null}
      {voidState.error ? <FormMessage>{tErrors(voidState.error)}</FormMessage> : null}
      {refundState.error ? <FormMessage>{tErrors(refundState.error)}</FormMessage> : null}
    </li>
  );
}
