"use client";

import { useEffect, useImperativeHandle, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { checkInAction } from "@/app/[locale]/(center)/reception/actions";
import {
  PaymentMethodSelector,
  type PaymentMethodOption,
} from "@/components/center/payment-method-selector";
import { StudentConfirmHeader } from "@/components/center/student-confirm-header";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";

/** The id the confirm button carries, so a dialog can focus it on open (Enter confirms). */
export const CHECK_IN_CONFIRM_BUTTON_ID = "check-in-confirm-button";

export type CheckInConfirmStudent = {
  id: string;
  name: string;
  code: string;
  /** A short-lived signed URL, or null with no photo on file / Storage unset. */
  photoUrl: string | null;
};

/** What the screen that owns the panel can do to it from outside. */
export type CheckInConfirmHandle = { submit: () => void };

/**
 * The one check-in confirm panel (R7, docs/04 §14.5; T2 shares it with the
 * session page): photo, name, code, Enrolled / Drop-in, the session's price, a
 * payment method (the last one used this visit by default), the "set
 * automatically" line, and **Cancel** + **Check in**. Confirming calls the one
 * `checkInAction` — attendance and payment in a single step; nothing is written
 * before that button (or Enter) and nothing is stored while the panel is open,
 * so Cancel, Escape, closing the dialog or leaving the page writes nothing.
 *
 * `inline` is the reception desk's boxed panel under the scan field; `sheet`
 * is the same content filling a dialog (the session page), with the actions in
 * a footer band — the dialog itself is the full-screen sheet on a phone.
 *
 * `recordPayment: false` is for a role that may check in but not take money
 * (`payment.record` not granted): the method block disappears and only the
 * attendance is written, exactly what that role could do on the roster before.
 */
export function CheckInConfirmPanel({
  sessionId,
  student,
  enrolled,
  booked = false,
  priceLabel,
  paymentMethods,
  recordPayment = true,
  defaultMethodId,
  variant = "inline",
  onSaved,
  onCancel,
  controlRef,
}: {
  sessionId: string;
  student: CheckInConfirmStudent;
  /** Actively enrolled in the session's class; otherwise a drop-in. */
  enrolled: boolean;
  /** F6 — a drop-in who booked this session online: shown "Booked". Price and payment are unchanged. */
  booked?: boolean;
  /** The session's price, formatted on the server; null for a free session (no price line). */
  priceLabel: string | null;
  paymentMethods: PaymentMethodOption[];
  recordPayment?: boolean;
  defaultMethodId?: string | null;
  variant?: "inline" | "sheet";
  /** The write succeeded. `methodId` is what was chosen ("" when none), for "last used". */
  onSaved: (result: SessionActionState, methodId: string) => void;
  onCancel: () => void;
  controlRef?: React.Ref<CheckInConfirmHandle>;
}) {
  const t = useTranslations("Reception");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();

  const formRef = useRef<HTMLFormElement>(null);
  const confirming = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useImperativeHandle(controlRef, () => ({
    // An Enter pressed while the panel is waiting is the confirm key.
    submit: () => {
      if (!confirming.current) formRef.current?.requestSubmit();
    },
  }));

  // Escape abandons the panel — nothing was written.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirming.current) return;
    confirming.current = true;
    const formData = new FormData(event.currentTarget);
    const methodId = String(formData.get("paymentMethodId") ?? "");

    startTransition(async () => {
      try {
        const result = await checkInAction(IDLE_SESSION_STATE, formData);
        if (result.error) {
          setError(result.error);
          return;
        }
        setError(null);
        onSaved(result, methodId);
      } catch {
        setError("failed");
      } finally {
        confirming.current = false;
      }
    });
  }

  const sheet = variant === "sheet";

  return (
    <form
      ref={formRef}
      onSubmit={confirm}
      className={cn(
        "flex flex-col",
        sheet ? "min-h-0 flex-1" : "gap-4 rounded-xl border border-brand/30 bg-brand/5 p-4",
      )}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="studentProfileId" value={student.id} />

      <div className={cn("flex flex-col gap-4", sheet && "flex-1 overflow-y-auto px-4 py-4 sm:px-6")}>
        <StudentConfirmHeader
          name={student.name}
          code={student.code}
          codeLabel={t("sessionMode.code")}
          photoUrl={student.photoUrl}
          badge={
            <Badge variant={enrolled ? "success" : booked ? "info" : "warning"}>
              {enrolled ? t("sessionMode.enrolled") : booked ? t("sessionMode.booked") : t("sessionMode.dropIn")}
            </Badge>
          }
        />

        {priceLabel ? (
          <p className="flex items-baseline justify-between gap-3 rounded-lg bg-surface px-3 py-2 text-sm">
            <span className="text-text-secondary">{t("sessionMode.price")}</span>
            <span className="font-semibold tabular-nums text-text-primary">{priceLabel}</span>
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          {recordPayment ? (
            <>
              <span className="text-xs font-medium text-text-secondary">{t("methodLabel")}</span>
              <PaymentMethodSelector methods={paymentMethods} defaultMethodId={defaultMethodId} />
            </>
          ) : null}
          <p className="text-xs text-text-muted">{t("statusAuto")}</p>
        </div>

        {error ? (
          <FormMessage>{error === "failed" ? t("sessionMode.failed") : tErrors(error)}</FormMessage>
        ) : null}
      </div>

      <div
        className={cn(
          "flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end",
          // The dialog's footer band: the device's safe area under the stacked buttons on a phone.
          sheet &&
            "border-t border-border px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4",
        )}
      >
        {/* A phone has no Enter key (docs/04 §14.5). */}
        <p className="hidden text-xs text-text-secondary sm:me-auto sm:block">{t("sessionMode.enterHint")}</p>
        <Button type="button" variant="outline" className="h-11 w-full px-5 sm:w-auto" onClick={onCancel}>
          {t("sessionMode.cancel")}
        </Button>
        <Button
          id={CHECK_IN_CONFIRM_BUTTON_ID}
          type="submit"
          disabled={pending}
          className="h-11 w-full px-5 sm:w-auto"
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
