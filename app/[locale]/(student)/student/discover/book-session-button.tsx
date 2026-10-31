"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SessionBookingMode } from "@prisma/client";

import { bookSessionAction } from "@/app/[locale]/(student)/student/reservations/booking-actions";
import { CancelBookingButton } from "@/app/[locale]/(student)/student/reservations/cancel-booking-button";
import { DialogShell } from "@/components/shared/dialog-shell";
import { JoinSummaryList } from "@/components/student/join-summary-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JoinSummary } from "@/lib/join-summary";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * "Attend this session only" on one upcoming session (F6). Once it lands,
 * the slot shows the outcome in place — Booked, or Requested when the class
 * needs approval — like the Enrol button does (docs/04 §10).
 *
 * **U8:** the button opens a confirmation first (class, branch, teacher, the
 * session's date and time, the price, "nothing is charged now", and whether
 * the seat is booked at once or the branch reviews it); the booking is made
 * from the dialog's Confirm.
 */
export function BookSessionButton({
  centerId,
  sessionId,
  mode,
  summary,
}: {
  centerId: string;
  sessionId: string;
  mode: SessionBookingMode;
  summary: JoinSummary;
}) {
  const t = useTranslations("StudentDiscover.sessions");
  const tErrors = useTranslations("StudentDiscover.sessions.errors");
  const tJoin = useTranslations("StudentActions.join");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useGuardedActionState(bookSessionAction, IDLE_STUDENT_STATE);

  if (state.status === "booked") return <Badge variant="info">{t("booked")}</Badge>;
  if (state.status === "bookingPending") return <Badge variant="warning">{t("requested")}</Badge>;

  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      {state.error ? <p className="text-xs text-danger-fg">{tErrors(state.error)}</p> : null}
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        size="narrow"
        title={tJoin("bookTitle")}
        description={mode === "APPROVAL" ? tJoin("bookApprovalOutcome") : tJoin("bookInstantOutcome")}
        cancelLabel={tJoin("cancel")}
        submitLabel={tJoin("confirm")}
        submitPending={pending}
        trigger={
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full border-brand/50 text-brand hover:border-brand hover:bg-brand/10 hover:text-brand sm:w-auto"
          >
            {t("attendOnly")}
          </Button>
        }
        formProps={{ action: formAction, onSubmit: () => setOpen(false) }}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="centerId" value={centerId} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <JoinSummaryList summary={summary} />
      </DialogShell>
    </div>
  );
}

/** The student's own booking on a session, in place of the button: its badge, and Cancel until it starts. */
export function MyBookingSlot({
  centerId,
  bookingId,
  status,
}: {
  centerId: string;
  bookingId: string;
  status: "PENDING" | "CONFIRMED";
}) {
  const t = useTranslations("StudentDiscover.sessions");
  return (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <Badge variant={status === "CONFIRMED" ? "info" : "warning"}>
        {status === "CONFIRMED" ? t("booked") : t("requested")}
      </Badge>
      <CancelBookingButton centerId={centerId} bookingId={bookingId} />
    </div>
  );
}
