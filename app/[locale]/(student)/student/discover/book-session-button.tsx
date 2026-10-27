"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { bookSessionAction } from "@/app/[locale]/(student)/student/reservations/booking-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      disabled={pending}
      aria-busy={pending || undefined}
      className="h-11 w-full border-brand/50 text-brand hover:border-brand hover:bg-brand/10 hover:text-brand sm:w-auto"
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  );
}

/**
 * "Attend this session only" on one upcoming session (F6). Once it lands,
 * the slot shows the outcome in place — Booked, or Requested when the class
 * needs approval — like the Enrol button does (docs/04 §10).
 */
export function BookSessionButton({ centerId, sessionId }: { centerId: string; sessionId: string }) {
  const t = useTranslations("StudentDiscover.sessions");
  const tErrors = useTranslations("StudentDiscover.sessions.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(bookSessionAction, IDLE_STUDENT_STATE);

  if (state.status === "booked") return <Badge variant="info">{t("booked")}</Badge>;
  if (state.status === "bookingPending") return <Badge variant="warning">{t("requested")}</Badge>;

  return (
    <form action={formAction} className="flex flex-col items-stretch gap-1 sm:items-end">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />
      <input type="hidden" name="sessionId" value={sessionId} />
      {state.error ? <p className="text-xs text-danger-fg">{tErrors(state.error)}</p> : null}
      <Submit label={t("attendOnly")} />
    </form>
  );
}
