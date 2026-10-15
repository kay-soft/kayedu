"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { reserveClassAction } from "@/app/[locale]/(student)/student/discover/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
 */
function SubmitAction({
  requiresConfirmation,
  enrollLabel,
  requestLabel,
}: {
  requiresConfirmation: boolean;
  enrollLabel: string;
  requestLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    // "Request to join" is the outlined brand button of docs/04 §10 — it had
    // rendered as a grey filled block that read as disabled.
    <Button
      type="submit"
      variant={requiresConfirmation ? "outline" : "default"}
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        "h-11 w-full",
        requiresConfirmation && "border-brand/50 text-brand hover:border-brand hover:bg-brand/10 hover:text-brand",
      )}
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {requiresConfirmation ? requestLabel : enrollLabel}
    </Button>
  );
}

export function ReserveButton({
  centerId,
  classGroupId,
  requiresConfirmation,
}: {
  centerId: string;
  classGroupId: string;
  requiresConfirmation: boolean;
}) {
  const t = useTranslations("StudentDiscover");
  const tErrors = useTranslations("StudentDiscover.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(reserveClassAction, IDLE_STUDENT_STATE);

  if (state.status === "pending" || state.status === "enrolled") {
    return (
      <Badge variant={state.status === "enrolled" ? "success" : "warning"} className="w-full justify-center py-2">
        {state.status === "enrolled" ? t("card.enrolled") : t("card.pending")}
      </Badge>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />
      {state.error ? (
        <p className="text-xs text-danger-fg">
          {state.error === "coolingOff" && state.errorDate
            ? tErrors("coolingOff", { date: state.errorDate })
            : tErrors(state.error)}
        </p>
      ) : null}
      <SubmitAction
        requiresConfirmation={requiresConfirmation}
        enrollLabel={t("card.enroll")}
        requestLabel={t("card.requestToJoin")}
      />
    </form>
  );
}
