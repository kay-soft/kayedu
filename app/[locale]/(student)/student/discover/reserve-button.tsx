"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { reserveClassAction } from "@/app/[locale]/(student)/student/discover/actions";
import { DialogShell } from "@/components/shared/dialog-shell";
import { JoinSummaryList } from "@/components/student/join-summary-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JoinSummary } from "@/lib/join-summary";
import { cn } from "@/lib/utils";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * The card's action slot (docs/04-design-system.md §10): a solid button for
 * instant enroll, an outlined one for "Request to Join", or — once a request
 * lands — a `Pending` badge in the same position, no button shown. A
 * successful instant-enroll flips this card straight to the `Enrolled` state
 * without a page reload, since the server action's `revalidatePath` refreshes
 * this route's data.
 *
 * **U8 — nothing is joined without a confirmation.** The button only opens a
 * dialog (class, branch, teacher, schedule and period, price, what happens
 * next); the form posts from the dialog's Confirm. `defaultOpen` is how a
 * guest who signed in from Explore with that intent gets the dialog back —
 * it opens, it never submits.
 */
export function ReserveButton({
  centerId,
  classGroupId,
  requiresConfirmation,
  summary,
  defaultOpen = false,
}: {
  centerId: string;
  classGroupId: string;
  requiresConfirmation: boolean;
  summary: JoinSummary;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("StudentDiscover");
  const tErrors = useTranslations("StudentDiscover.errors");
  const tJoin = useTranslations("StudentActions.join");
  const locale = useLocale();
  const [open, setOpen] = useState(defaultOpen);

  const [state, formAction, pending] = useGuardedActionState(reserveClassAction, IDLE_STUDENT_STATE);

  if (state.status === "pending" || state.status === "enrolled") {
    return (
      <Badge variant={state.status === "enrolled" ? "success" : "warning"} className="w-full justify-center py-2">
        {state.status === "enrolled" ? t("card.enrolled") : t("card.pending")}
      </Badge>
    );
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // The sign-in intent is spent once the dialog is dismissed: drop it from
    // the URL so a reload does not open the dialog again.
    if (!next && typeof window !== "undefined" && window.location.search.includes("join=")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("join");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {state.error ? (
        <p className="text-xs text-danger-fg">
          {/* coolingOff and sessionFull (F6) both name a date. */}
          {state.errorDate ? tErrors(state.error, { date: state.errorDate }) : tErrors(state.error)}
        </p>
      ) : null}
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={requiresConfirmation ? tJoin("requestTitle") : tJoin("enrolTitle")}
        description={requiresConfirmation ? tJoin("requestOutcome") : tJoin("enrolOutcome")}
        cancelLabel={tJoin("cancel")}
        submitLabel={tJoin("confirm")}
        submitPending={pending}
        trigger={
          // "Request to join" is the outlined brand button of docs/04 §10 — it had
          // rendered as a grey filled block that read as disabled.
          <Button
            type="button"
            variant={requiresConfirmation ? "outline" : "default"}
            className={cn(
              "h-11 w-full",
              requiresConfirmation &&
                "border-brand/50 text-brand hover:border-brand hover:bg-brand/10 hover:text-brand",
            )}
          >
            {requiresConfirmation ? t("card.requestToJoin") : t("card.enroll")}
          </Button>
        }
        formProps={{ action: formAction, onSubmit: () => onOpenChange(false) }}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="centerId" value={centerId} />
        <input type="hidden" name="classGroupId" value={classGroupId} />
        <JoinSummaryList summary={summary} />
      </DialogShell>
    </div>
  );
}
