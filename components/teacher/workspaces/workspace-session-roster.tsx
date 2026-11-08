"use client";

import { useState } from "react";
import { Ban, Lock, LogIn, Undo2, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  workspaceCheckInAction,
  workspaceCloseSessionAction,
  workspaceRecordPaymentAction,
  workspaceRefundPaymentAction,
  workspaceSetAttendanceAction,
  workspaceVoidPaymentAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/session-actions";
import { AttendanceControl } from "@/components/center/attendance-control";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogShell } from "@/components/shared/dialog-shell";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorkspaceSessionRosterRow } from "@/lib/db/workspace-attendance";
import { formatMoney } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_SESSION_STATE, type WorkspaceSessionActionState } from "@/lib/validation/workspace-sessions";

/** Present = green, late = amber, absent = red — always with the word (CLAUDE.md rule 8, docs/04 §14.7). */
const STATUS_VARIANT = { PRESENT: "success", LATE: "warning", ABSENT: "danger" } as const;

/**
 * A workspace session's roster (W8c, D-W40 item 9; docs/04 §11.37). The
 * class's enrolled students as stacked cards at every width. A row not yet
 * checked in — or "Not arrived" again after a void or refund (T5) — has
 * **Check in** (the server decides Present or Late from the clock; R2). A
 * checked-in row has the Attendance control for corrections while the session
 * is live; switching a paid student to Absent opens a dialog that says the
 * payment will be voided and needs a reason (D-13). Then the money: **Record
 * payment** with the amount shown read-only — the session's price, frozen by
 * the server (no amount is ever posted) — and, once paid, **Void** and
 * **Refund** with their reasons and the U2 wording. `writable` (premium, not
 * archived) and `readOnly` (closed, cancelled, rescheduled) only hide
 * controls; the server refuses every write anyway.
 */
export function WorkspaceSessionRoster({
  workspaceId,
  sessionId,
  rows,
  priceLabel,
  writable,
  readOnly,
}: {
  workspaceId: string;
  sessionId: string;
  rows: WorkspaceSessionRosterRow[];
  /** The session's price, formatted — what a payment will freeze. */
  priceLabel: string;
  writable: boolean;
  readOnly: boolean;
}) {
  const t = useTranslations("WorkspaceSession");
  if (rows.length === 0) {
    return <EmptyState compact icon={<Users />} title={t("rosterEmpty")} description={t("rosterEmptyHint")} />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <RosterRow
          key={row.studentProfileId}
          workspaceId={workspaceId}
          sessionId={sessionId}
          row={row}
          priceLabel={priceLabel}
          live={writable && !readOnly}
        />
      ))}
    </ul>
  );
}

function RosterRow({
  workspaceId,
  sessionId,
  row,
  priceLabel,
  live,
}: {
  workspaceId: string;
  sessionId: string;
  row: WorkspaceSessionRosterRow;
  priceLabel: string;
  live: boolean;
}) {
  const t = useTranslations("WorkspaceSession");
  const tRoster = useTranslations("Sessions.roster");
  const tAttendance = useTranslations("Sessions.attendance");
  const tErrors = useTranslations("WorkspaceSession.errors");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();
  const name = fullName(row);

  const [absentOpen, setAbsentOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [checkInState, checkInAction] = useGuardedActionState(workspaceCheckInAction, IDLE_WORKSPACE_SESSION_STATE);
  const [attendanceState, attendanceAction, attendancePending] = useGuardedActionState(
    async (previous: WorkspaceSessionActionState, formData: FormData) => {
      const next = await workspaceSetAttendanceAction(previous, formData);
      if (next.status) setAbsentOpen(false);
      return next;
    },
    IDLE_WORKSPACE_SESSION_STATE,
  );
  const [paymentState, paymentAction] = useGuardedActionState(workspaceRecordPaymentAction, IDLE_WORKSPACE_SESSION_STATE);
  const [voidState, voidAction] = useGuardedActionState(workspaceVoidPaymentAction, IDLE_WORKSPACE_SESSION_STATE);
  const [refundState, refundAction] = useGuardedActionState(workspaceRefundPaymentAction, IDLE_WORKSPACE_SESSION_STATE);

  const checkedIn = row.status !== null && !row.notArrived;
  const payable = checkedIn && (row.status === "PRESENT" || row.status === "LATE");
  const activePayment = row.payment && !row.payment.refunded ? row.payment : null;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="sessionId" value={sessionId} />
    </>
  );
  const studentFields = (
    <>
      {hidden}
      <input type="hidden" name="studentProfileId" value={row.studentProfileId} />
    </>
  );
  const statusLabel = row.notArrived
    ? tAttendance("NOT_ARRIVED")
    : row.status
      ? tAttendance(row.status)
      : t("notCheckedIn");

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-text-primary">{name}</p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <Ltr>{row.studentCode}</Ltr>
            {row.enrolled ? null : <span>{t("noLongerEnrolled")}</span>}
          </p>
        </div>
        {/* The status is always a word (never colour alone); "Not arrived" and "Not checked in" are neutral. */}
        <Badge variant={checkedIn && row.status ? STATUS_VARIANT[row.status] : "neutral"} className="shrink-0">
          {statusLabel}
        </Badge>
      </div>

      {live && !checkedIn && row.enrolled ? (
        <form action={checkInAction}>
          {studentFields}
          <SubmitButton className="h-11 w-full px-4 sm:w-auto">
            <LogIn className="size-4" aria-hidden />
            {tRoster("checkIn")}
          </SubmitButton>
        </form>
      ) : null}
      {checkInState.error ? <FormMessage>{tErrors(checkInState.error)}</FormMessage> : null}

      {live && checkedIn && row.status ? (
        <div className="flex flex-col gap-2">
          <AttendanceControl
            formAction={attendanceAction}
            value={row.status}
            pending={attendancePending}
            hiddenFields={
              <>
                {studentFields}
                <input type="hidden" name="confirmVoid" value="false" />
              </>
            }
            interceptStatus={activePayment ? "ABSENT" : undefined}
            onIntercept={() => setAbsentOpen(true)}
          />
          {activePayment ? <p className="text-xs text-text-muted">{tRoster("paidAbsentNote")}</p> : null}
          {attendanceState.error && !absentOpen ? <FormMessage>{tErrors(attendanceState.error)}</FormMessage> : null}
        </div>
      ) : null}

      {activePayment && live ? (
        <DialogShell
          open={absentOpen}
          onOpenChange={setAbsentOpen}
          size="narrow"
          title={tRoster("voidDialog.title", { name })}
          description={tRoster("voidDialog.body", { name, amount: formatMoney(activePayment.amount, locale) })}
          formProps={{ action: attendanceAction }}
          cancelLabel={tRoster("voidDialog.cancel")}
          submitLabel={tRoster("voidDialog.confirm")}
          submitVariant="destructive"
          submitPending={attendancePending}
        >
          {studentFields}
          <input type="hidden" name="status" value="ABSENT" />
          <input type="hidden" name="confirmVoid" value="true" />
          <div className="flex flex-col gap-2">
            <Label htmlFor={`ws-absent-reason-${row.studentProfileId}`}>{tRoster("voidDialog.reasonLabel")}</Label>
            <Input
              id={`ws-absent-reason-${row.studentProfileId}`}
              name="reason"
              required
              maxLength={200}
              placeholder={tRoster("voidDialog.reasonPlaceholder")}
              aria-invalid={attendanceState.fieldErrors?.reason ? true : undefined}
            />
            {attendanceState.fieldErrors?.reason ? <FormMessage>{tErrors(attendanceState.fieldErrors.reason)}</FormMessage> : null}
            {attendanceState.error ? <FormMessage>{tErrors(attendanceState.error)}</FormMessage> : null}
          </div>
        </DialogShell>
      ) : null}

      {row.payment ? (
        <div className="flex flex-col gap-2 rounded-lg bg-success-bg px-3 py-2">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-success-fg">
            {tRoster("paid", { amount: formatMoney(row.payment.amount, locale), method: row.payment.methodLabel })}
            {row.payment.refunded ? <Badge variant="neutral">{tRoster("refunded")}</Badge> : null}
          </p>
          {live && activePayment ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {voidOpen ? (
                <form action={voidAction} className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <div id={`ws-${row.studentProfileId}-void-help`} className="flex basis-full flex-col gap-1 text-xs text-text-secondary">
                    <p>{tRoster("voidHelp")}</p>
                    <p>{tRoster("reversalResets")}</p>
                  </div>
                  {hidden}
                  <input type="hidden" name="paymentId" value={activePayment.id} />
                  <Input
                    type="text"
                    name="reason"
                    required
                    maxLength={200}
                    autoFocus
                    autoComplete="off"
                    aria-label={tRoster("voidReasonPlaceholder")}
                    aria-describedby={`ws-${row.studentProfileId}-void-help`}
                    placeholder={tRoster("voidReasonPlaceholder")}
                    className="min-w-0 flex-1"
                  />
                  <SubmitButton variant="destructive">{tRoster("confirmVoid")}</SubmitButton>
                  <Button type="button" variant="outline" className="h-11 px-4" onClick={() => setVoidOpen(false)}>
                    {tCommon("cancel")}
                  </Button>
                </form>
              ) : refundOpen ? null : (
                <button
                  type="button"
                  onClick={() => setVoidOpen(true)}
                  className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-danger-fg transition-ui focus-ring hover:bg-danger-bg"
                >
                  <Ban className="size-4" aria-hidden />
                  {tRoster("void")}
                </button>
              )}
              {refundOpen ? (
                <form action={refundAction} className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <div id={`ws-${row.studentProfileId}-refund-help`} className="flex basis-full flex-col gap-1 text-xs text-text-secondary">
                    <p>{t("refundHelp")}</p>
                    <p>{tRoster("reversalResets")}</p>
                  </div>
                  {hidden}
                  <input type="hidden" name="paymentId" value={activePayment.id} />
                  <Input
                    type="text"
                    name="reason"
                    required
                    maxLength={200}
                    autoFocus
                    autoComplete="off"
                    aria-label={tRoster("refundReasonPlaceholder")}
                    aria-describedby={`ws-${row.studentProfileId}-refund-help`}
                    placeholder={tRoster("refundReasonPlaceholder")}
                    className="min-w-0 flex-1"
                  />
                  <SubmitButton variant="destructive">{tRoster("confirmRefund")}</SubmitButton>
                  <Button type="button" variant="outline" className="h-11 px-4" onClick={() => setRefundOpen(false)}>
                    {tCommon("cancel")}
                  </Button>
                </form>
              ) : voidOpen ? null : (
                <button
                  type="button"
                  onClick={() => setRefundOpen(true)}
                  className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary"
                >
                  <Undo2 className="size-4" aria-hidden />
                  {tRoster("refund")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : live && payable ? (
        <form action={paymentAction} className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          {hidden}
          <input type="hidden" name="attendeeId" value={row.attendeeId ?? ""} />
          {/* Read-only: the server freezes the session's own price (D-W40 item 9). */}
          <p className="text-sm text-text-primary">{t("amount", { amount: priceLabel })}</p>
          <p className="text-xs text-text-muted">{t("amountNote")}</p>
          <SubmitButton className="w-full sm:w-auto sm:self-start">{tRoster("recordPayment")}</SubmitButton>
        </form>
      ) : null}
      {paymentState.error ? <FormMessage>{tErrors(paymentState.error)}</FormMessage> : null}
      {voidState.fieldErrors?.reason ? <FormMessage>{tErrors(voidState.fieldErrors.reason)}</FormMessage> : null}
      {voidState.error ? <FormMessage>{tErrors(voidState.error)}</FormMessage> : null}
      {refundState.fieldErrors?.reason ? <FormMessage>{tErrors(refundState.fieldErrors.reason)}</FormMessage> : null}
      {refundState.error ? <FormMessage>{tErrors(refundState.error)}</FormMessage> : null}
    </li>
  );
}

/**
 * "End session" in a workspace (R2, D-W40 item 5) — the branch button's
 * dialog and wording (`Sessions.endSession`): ending is permanent, enrolled
 * no-shows become Absent, there is no reopen.
 */
export function WorkspaceEndSessionButton({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const t = useTranslations("Sessions.endSession");
  const tErrors = useTranslations("WorkspaceSession.errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useGuardedActionState(
    async (previous: WorkspaceSessionActionState, formData: FormData) => {
      const next = await workspaceCloseSessionAction(previous, formData);
      if (next.status === "closed") setOpen(false);
      return next;
    },
    IDLE_WORKSPACE_SESSION_STATE,
  );
  return (
    <>
      <ActionBarButton variant="destructive" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        <Lock className="size-4" aria-hidden />
        {t("button")}
      </ActionBarButton>
      {state.error && !open ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        size="narrow"
        title={t("dialogTitle")}
        description={t("dialogBody")}
        formProps={{ action: formAction }}
        cancelLabel={t("cancel")}
        submitLabel={t("confirm")}
        submitVariant="destructive"
        submitPending={pending}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <div className="flex flex-col gap-3">
          <FormMessage tone="warning">{t("irreversible")}</FormMessage>
          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        </div>
      </DialogShell>
    </>
  );
}
