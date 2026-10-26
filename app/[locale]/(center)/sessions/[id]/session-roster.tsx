"use client";

import { useState } from "react";
import { AlertTriangle, Ban, LogIn, Undo2, Users } from "lucide-react";
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
  type PaymentMethodOption,
} from "@/components/center/payment-method-selector";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRequestCheckIn } from "@/app/[locale]/(center)/sessions/[id]/session-check-in-provider";
import { Link } from "@/lib/i18n/navigation";
import { formatMoney } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";
import { EmptyState } from "@/components/shared/empty-state";
import { Ltr } from "@/components/shared/ltr";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

const STATUS_VARIANT = { PRESENT: "success", LATE: "warning", ABSENT: "danger" } as const;

export type RosterRowData = {
  studentProfileId: string;
  attendeeId: string | null;
  name: string;
  studentCode: string;
  isDropIn: boolean;
  /** On the class's active enrolments — what the confirm panel's Enrolled / Drop-in badge shows. */
  enrolled: boolean;
  /** A short-lived signed URL for the confirm panel; only an unmarked row carries one. */
  photoUrl: string | null;
  status: AttendanceStatusValue | null;
  /** `methodLabel` is the payment's frozen `methodLabelSnapshot` (R1), never the live name. */
  payment: { id: string; amount: number; methodLabel: string; refunded: boolean } | null;
  consecutiveAbsences: number;
};

/**
 * The session roster (spec §4.1 item 7): every actively-enrolled student
 * (marked or not) plus any drop-ins. An unmarked row gets a **Check in**
 * button that opens reception's confirm panel (T2: confirm, then write — the
 * button itself calls no Server Action; the panel's confirm is the one write,
 * attendance and payment together). The server decides Present or Late from
 * the clock (R2), there is no status picker. A marked row gets the Attendance control for
 * corrections while the session is live, and, once PRESENT/LATE, the money —
 * record a payment, void one already recorded, or (M14) refund one.
 *
 * Switching a paid student to Absent voids their payment (R2). The row says
 * so in plain words before anyone clicks, and the click opens a
 * confirmation dialog instead of submitting straight away. Its reason is
 * **required** (SEC-2b, D-13): the void is refused without one, here and on
 * the server.
 *
 * `canRecord`/`canCorrect`/`canRecordPayment`/`canVoid`/`canRefund` only
 * hide controls; the server actions re-check every permission (docs/02 §6).
 * `readOnly` — cancelled, rescheduled (M15) or closed (R2) — renders no
 * attendance or payment control at all.
 */
export function SessionRoster({
  sessionId,
  rows,
  canRecord,
  canCorrect,
  canRecordPayment,
  canVoid,
  canRefund,
  paymentMethods,
  readOnly = false,
}: {
  sessionId: string;
  rows: RosterRowData[];
  canRecord: boolean;
  canCorrect: boolean;
  canRecordPayment: boolean;
  canVoid: boolean;
  canRefund: boolean;
  /** The centre's active methods (R1), oldest first. */
  paymentMethods: PaymentMethodOption[];
  /** Cancelled, already-rescheduled (M15) or closed (R2) — no attendance/payment control renders. */
  readOnly?: boolean;
}) {
  const t = useTranslations("Sessions.roster");

  if (rows.length === 0) {
    return <EmptyState compact icon={<Users />} title={t("empty")} description={t("emptyHint")} />;
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <AttendeeRow
          key={row.studentProfileId}
          sessionId={sessionId}
          row={row}
          canRecord={canRecord}
          canCorrect={canCorrect}
          canRecordPayment={canRecordPayment}
          canVoid={canVoid}
          canRefund={canRefund}
          paymentMethods={paymentMethods}
          readOnly={readOnly}
        />
      ))}
    </ul>
  );
}

function AttendeeRow({
  sessionId,
  row,
  canRecord,
  canCorrect,
  canRecordPayment,
  canVoid,
  canRefund,
  paymentMethods,
  readOnly,
}: {
  sessionId: string;
  row: RosterRowData;
  canRecord: boolean;
  canCorrect: boolean;
  canRecordPayment: boolean;
  canVoid: boolean;
  canRefund: boolean;
  paymentMethods: PaymentMethodOption[];
  readOnly: boolean;
}) {
  const t = useTranslations("Sessions.roster");
  const tErrors = useTranslations("Sessions.errors");
  const tAttendance = useTranslations("Sessions.attendance");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();

  const [absentConfirmOpen, setAbsentConfirmOpen] = useState(false);
  const [attendanceState, attendanceFormAction, attendancePending] = useGuardedActionState(
    async (previous: SessionActionState, formData: FormData) => {
      const next = await setAttendanceAction(previous, formData);
      // The void-on-absent dialog closes once the change has landed.
      if (next.status) setAbsentConfirmOpen(false);
      return next;
    },
    IDLE_SESSION_STATE,
  );
  const requestCheckIn = useRequestCheckIn();
  const [paymentState, paymentFormAction] = useGuardedActionState(
    recordPaymentAction,
    IDLE_SESSION_STATE,
  );
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidState, voidFormAction] = useGuardedActionState(
    voidPaymentAction,
    IDLE_SESSION_STATE,
  );
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundState, refundFormAction] = useGuardedActionState(
    refundPaymentAction,
    IDLE_SESSION_STATE,
  );

  const alreadyMarked = row.status !== null;
  const payable = row.status === "PRESENT" || row.status === "LATE";
  // An active payment a switch to Absent would void (R2) — a refunded one
  // already went back in cash and is left alone.
  const voidableOnAbsent = Boolean(row.payment && !row.payment.refunded);

  const hiddenRowFields = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="studentProfileId" value={row.studentProfileId} />
    </>
  );

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={ROUTES.centerStudent(row.studentProfileId)}
            className="truncate rounded-sm text-sm font-medium text-brand focus-ring hover:underline"
          >
            {row.name}
          </Link>
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Ltr>{row.studentCode}</Ltr>
            {row.isDropIn ? (
              <Badge variant="info">{t("dropIn")}</Badge>
            ) : null}
          </p>
        </div>
      </div>

      {row.consecutiveAbsences >= 2 ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("consecutiveAbsentAlert", { count: row.consecutiveAbsences })}
        </p>
      ) : null}

      {readOnly || (!alreadyMarked && !canRecord) ? (
        // Present / late / absent keep their colours on a closed roster too
        // (they had all been grey) — docs/04 §2.
        <Badge variant={row.status ? STATUS_VARIANT[row.status] : "neutral"}>
          {row.status ? tAttendance(row.status) : t("unmarked")}
        </Badge>
      ) : !alreadyMarked ? (
        // Opens the confirm panel; nothing is written until its confirm button.
        <Button
          type="button"
          className="h-11 w-full px-4 sm:w-auto sm:self-start"
          onClick={() =>
            requestCheckIn({
              id: row.studentProfileId,
              name: row.name,
              code: row.studentCode,
              photoUrl: row.photoUrl,
              enrolled: row.enrolled,
            })
          }
        >
          <LogIn className="size-4" aria-hidden />
          {t("checkIn")}
        </Button>
      ) : (
        <>
          <AttendanceControl
            formAction={attendanceFormAction}
            value={row.status}
            pending={attendancePending || !canCorrect}
            hiddenFields={hiddenRowFields}
            interceptStatus={voidableOnAbsent && canVoid ? "ABSENT" : undefined}
            onIntercept={() => setAbsentConfirmOpen(true)}
          />
          {voidableOnAbsent && canCorrect ? (
            <p className="text-xs text-text-muted">{t("paidAbsentNote")}</p>
          ) : null}
          {attendanceState.error && !absentConfirmOpen ? (
            <FormMessage>{tErrors(attendanceState.error)}</FormMessage>
          ) : null}
          {row.payment && voidableOnAbsent ? (
            <Dialog open={absentConfirmOpen} onOpenChange={setAbsentConfirmOpen}>
              <DialogContent>
                <form action={attendanceFormAction} className="flex flex-1 flex-col">
                  {hiddenRowFields}
                  <input type="hidden" name="status" value="ABSENT" />
                  <input type="hidden" name="confirmVoid" value="true" />
                  <DialogHeader>
                    <DialogTitle>{t("voidDialog.title", { name: row.name })}</DialogTitle>
                    <DialogDescription>
                      {t("voidDialog.body", {
                        name: row.name,
                        amount: formatMoney(row.payment.amount, locale),
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogBody className="flex flex-col gap-2">
                    <Label htmlFor={`absent-reason-${row.studentProfileId}`}>
                      {t("voidDialog.reasonLabel")}
                    </Label>
                    <Input
                      id={`absent-reason-${row.studentProfileId}`}
                      name="reason"
                      required
                      maxLength={200}
                      placeholder={t("voidDialog.reasonPlaceholder")}
                      aria-invalid={attendanceState.fieldErrors?.reason ? true : undefined}
                    />
                    {attendanceState.fieldErrors?.reason ? (
                      <FormMessage>{tErrors(attendanceState.fieldErrors.reason)}</FormMessage>
                    ) : null}
                    {attendanceState.error ? (
                      <FormMessage>{tErrors(attendanceState.error)}</FormMessage>
                    ) : null}
                  </DialogBody>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 px-4"
                      onClick={() => setAbsentConfirmOpen(false)}
                    >
                      {t("voidDialog.cancel")}
                    </Button>
                    <SubmitButton variant="destructive">{t("voidDialog.confirm")}</SubmitButton>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null}
        </>
      )}

      {readOnly ? (
        row.payment ? (
          <p className="text-sm font-medium text-success-fg">
            {t("paid", {
              amount: formatMoney(row.payment.amount, locale),
              method: row.payment.methodLabel,
            })}
          </p>
        ) : null
      ) : payable ? (
        row.payment ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-success-bg px-3 py-2">
            <p className="text-sm font-medium text-success-fg">
              {t("paid", {
                amount: formatMoney(row.payment.amount, locale),
                method: row.payment.methodLabel,
              })}
              {/* A refund is not "upcoming": no status blue (docs/04 §11.9). */}
              {row.payment.refunded ? (
                <Badge variant="neutral" className="ms-2">
                  {t("refunded")}
                </Badge>
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
                      <Input
                        type="text"
                        name="reason"
                        required
                        maxLength={200}
                        autoFocus
                        autoComplete="off"
                        // A labelled field (it had been a bare input with a placeholder).
                        aria-label={t("voidReasonPlaceholder")}
                        placeholder={t("voidReasonPlaceholder")}
                        className="min-w-0 flex-1"
                      />
                      <SubmitButton variant="destructive">
                        {t("confirmVoid")}
                      </SubmitButton>
                      <Button type="button" variant="outline" className="h-11 px-4" onClick={() => setVoidOpen(false)}>
                        {tCommon("cancel")}
                      </Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setVoidOpen(true)}
                      // 44px — the hardest-to-undo money verbs on the screen.
                      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-danger-fg transition-ui focus-ring hover:bg-danger-bg"
                    >
                      <Ban className="size-4" aria-hidden />
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
                      <Input
                        type="text"
                        name="reason"
                        required
                        maxLength={200}
                        autoFocus
                        autoComplete="off"
                        // A labelled field (it had been a bare input with a placeholder).
                        aria-label={t("refundReasonPlaceholder")}
                        placeholder={t("refundReasonPlaceholder")}
                        className="min-w-0 flex-1"
                      />
                      <SubmitButton variant="destructive">
                        {t("confirmRefund")}
                      </SubmitButton>
                      <Button type="button" variant="outline" className="h-11 px-4" onClick={() => setRefundOpen(false)}>
                        {tCommon("cancel")}
                      </Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRefundOpen(true)}
                      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary"
                    >
                      <Undo2 className="size-4" aria-hidden />
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
            <PaymentMethodSelector methods={paymentMethods} />
            {/* Recording the payment is the row's next step: the primary. */}
            <SubmitButton className="w-full sm:w-auto sm:self-start">
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
