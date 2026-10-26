"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useTranslations } from "next-intl";

import {
  CHECK_IN_CONFIRM_BUTTON_ID,
  CheckInConfirmPanel,
  type CheckInConfirmStudent,
} from "@/components/center/check-in-confirm-panel";
import type { PaymentMethodOption } from "@/components/center/payment-method-selector";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notify } from "@/components/ui/toast";
import type { SessionActionState } from "@/lib/validation/sessions";

/** Who the confirm panel is about — everything it shows, already on the page. */
export type CheckInTarget = CheckInConfirmStudent & {
  /** Actively enrolled in the session's class; a search pick is always a drop-in. */
  enrolled: boolean;
};

type RequestCheckIn = (target: CheckInTarget) => void;

const CheckInContext = createContext<RequestCheckIn | null>(null);

/** Opens the confirm panel for a student. Nothing is written by calling it. */
export function useRequestCheckIn(): RequestCheckIn {
  const request = useContext(CheckInContext);
  if (!request) throw new Error("useRequestCheckIn must be used inside SessionCheckInProvider.");
  return request;
}

/**
 * The session page's check-in contract (T2): **confirm, then write**. Picking a
 * student — the roster's Check in button, the add-attendee search, a candidate
 * row — only calls `requestCheckIn`, which opens reception's confirm panel in a
 * dialog (a full-screen sheet on a phone). No Server Action runs, and nothing
 * is stored on either side, until that panel's confirm button; the one write is
 * `checkInAction` — attendance and payment together, the same function the
 * reception desk uses. Cancel, Escape, closing the dialog or leaving the page
 * simply discards the pick (it is plain React state, gone with the page).
 *
 * The last payment method used in this visit is remembered here, in memory only.
 */
export function SessionCheckInProvider({
  sessionId,
  priceLabel,
  paymentMethods,
  canRecordPayment,
  children,
}: {
  sessionId: string;
  /** The session's price, formatted on the server; null for a free session. */
  priceLabel: string | null;
  paymentMethods: PaymentMethodOption[];
  /** `payment.record` — without it the panel checks in and records no payment. */
  canRecordPayment: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("Reception");
  const tAttendance = useTranslations("Sessions.attendance");

  const [open, setOpen] = useState(false);
  // Kept after closing so the dialog's exit transition still has content.
  const [target, setTarget] = useState<CheckInTarget | null>(null);
  const [generation, setGeneration] = useState(0);
  const [lastMethodId, setLastMethodId] = useState<string | null>(null);

  const requestCheckIn = useCallback<RequestCheckIn>((next) => {
    setTarget(next);
    setGeneration((current) => current + 1);
    setOpen(true);
  }, []);

  const cancel = useCallback(() => setOpen(false), []);

  const saved = useCallback(
    (result: SessionActionState, methodId: string, name: string) => {
      if (methodId) setLastMethodId(methodId);
      setOpen(false);
      notify(
        "success",
        result.alreadyCheckedIn
          ? t("sessionMode.alreadyCheckedInShort", { name })
          : t("sessionMode.checkedInAs", {
              name,
              status: tAttendance(result.attendanceStatus ?? "PRESENT"),
            }),
      );
    },
    [t, tAttendance],
  );

  return (
    <CheckInContext.Provider value={requestCheckIn}>
      {children}
      <Dialog open={open} onOpenChange={setOpen} disablePointerDismissal>
        <DialogContent
          // Enter confirms: focus lands on the confirm button, not the close X.
          initialFocus={() => document.getElementById(CHECK_IN_CONFIRM_BUTTON_ID)}
          className="overflow-hidden sm:max-h-[90vh]"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("sessionMode.confirmTitle")}</DialogTitle>
          </DialogHeader>
          {target ? (
            <CheckInConfirmPanel
              key={generation}
              variant="sheet"
              sessionId={sessionId}
              student={target}
              enrolled={target.enrolled}
              priceLabel={priceLabel}
              paymentMethods={paymentMethods}
              recordPayment={canRecordPayment}
              defaultMethodId={lastMethodId}
              onSaved={(result, methodId) => saved(result, methodId, target.name)}
              onCancel={cancel}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </CheckInContext.Provider>
  );
}
