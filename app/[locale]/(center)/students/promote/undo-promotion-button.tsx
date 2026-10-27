"use client";

import { Undo2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { undoPromotionAction } from "@/app/[locale]/(center)/students/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { IDLE_PEOPLE_STATE } from "@/lib/validation/people";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * Undo the latest promotion (F4): one confirm, one action. The batch id is the
 * only thing posted — the server re-checks that it is this branch's latest
 * not-yet-undone batch, inside its 14 days, and reverts only students still in
 * the To grade. The result is a toast, since both homes (the Students banner
 * and the history row) re-render from the revalidated data.
 */
export function UndoPromotionButton({
  batchId,
  fromLabel,
  toLabel,
  className,
}: {
  batchId: string;
  fromLabel: string;
  toLabel: string;
  className?: string;
}) {
  const t = useTranslations("Students.promote");
  const tErrors = useTranslations("People.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(undoPromotionAction, IDLE_PEOPLE_STATE);
  useActionFeedback(state, {
    success: (status, result) =>
      status === "saved"
        ? t("undoDone", { reverted: result.count ?? 0, skipped: result.skipped ?? 0 })
        : null,
    error: (key) => (tErrors.has(key) ? tErrors(key) : tErrors("generic")),
  });

  return (
    <ConfirmAction
      label={t("undo")}
      icon={<Undo2 className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName={className ?? "w-full sm:w-auto"}
      title={t("undoTitle")}
      description={t("undoDescription", { from: fromLabel, to: toLabel })}
      confirmLabel={t("undoConfirm")}
      tone="default"
      action={formAction}
      fields={{ locale, batchId }}
    />
  );
}
