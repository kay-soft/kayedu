"use client";

import { useActionState, useState } from "react";
import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  approveSessionRequestAction,
  declineSessionRequestAction,
} from "@/app/[locale]/(center)/approvals/actions";
import { SlotConflictNotice } from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IDLE_APPROVALS_STATE } from "@/lib/validation/approvals";

/** Errors `SlotConflictNotice` already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["conflict", "conflictsNeedConfirmation"]);

/**
 * Accept / decline one NEW_SESSION request. R3: accepting a slot that
 * double-books a room or the teacher comes back refused **with the
 * conflicts**, shown in `SlotConflictNotice` inside the accept form — under
 * WARN the approver ticks "I understand, create anyway" and accepts again;
 * under DENY there is no override.
 */
export function SessionRequestActions({ id }: { id: string }) {
  const t = useTranslations("Approvals");
  const tErrors = useTranslations("Approvals.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useActionState(
    approveSessionRequestAction,
    IDLE_APPROVALS_STATE,
  );
  const [declineState, declineAction] = useActionState(
    declineSessionRequestAction,
    IDLE_APPROVALS_STATE,
  );
  const [confirmedFor, setConfirmedFor] = useState<object | null>(null);

  if (approveState.status === "approved") {
    return <Badge variant="success">{t("changeRequests.approved")}</Badge>;
  }
  if (declineState.status === "declined") {
    return <Badge variant="danger">{t("changeRequests.declined")}</Badge>;
  }

  const error = approveState.error ?? declineState.error;
  const conflicts = approveState.conflicts ?? [];
  const policy = approveState.conflictPolicy ?? "WARN";
  const confirmed = confirmedFor === approveState;
  const blocked = conflicts.length > 0 && (policy === "DENY" || !confirmed);

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:items-end">
      {error && !CONFLICT_ERRORS.has(error) ? (
        <FormMessage className="text-xs">{tErrors(error)}</FormMessage>
      ) : null}
      <form id={`approve-session-${id}`} action={approveAction} className="w-full">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="id" value={id} />
        <SlotConflictNotice
          idPrefix={`approve-session-${id}`}
          conflicts={conflicts}
          policy={policy}
          confirmed={confirmed}
          onConfirmedChange={(value) => setConfirmedFor(value ? approveState : null)}
        />
      </form>
      <div className="flex gap-2">
        <form action={declineAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="outline">
            <X className="size-4" />
            {t("decline")}
          </SubmitButton>
        </form>
        <ApproveButton formId={`approve-session-${id}`} disabled={blocked} label={t("approve")} />
      </div>
    </div>
  );
}

/**
 * The accept button lives beside "Decline" but submits the accept form above
 * it (`form=`), so the conflict notice and its checkbox post with it.
 */
function ApproveButton({
  formId,
  disabled,
  label,
}: {
  formId: string;
  disabled: boolean;
  label: string;
}) {
  return (
    <Button type="submit" form={formId} disabled={disabled} className="h-11 px-4">
      <Check className="size-4" />
      {label}
    </Button>
  );
}
