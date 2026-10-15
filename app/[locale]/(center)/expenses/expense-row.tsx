"use client";

import { useState } from "react";
import { Ban } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { voidExpenseAction } from "@/app/[locale]/(center)/expenses/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

export type ExpenseRowData = {
  id: string;
  date: string;
  categoryName: string | null;
  amount: number;
  note: string | null;
  /** D-24 — a voided expense stays listed, out of every total. */
  voided: { reason: string | null; at: string | null; byName: string | null } | null;
};

/**
 * One expense entry. Stacked card below `md`, table row from `md` up (docs/04
 * §6). An expense is never deleted (D-24): "Void" asks for a reason, and a
 * voided row stays here, struck through, with who voided it and why.
 */
export function ExpenseRow({ expense, timeZone }: { expense: ExpenseRowData; timeZone: string }) {
  const t = useTranslations("Expenses");
  const tErrors = useTranslations("Expenses.errors");
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useGuardedActionState(voidExpenseAction, IDLE_ACTION_STATE);
  const tToast = useTranslations("Toasts");
  useActionFeedback(state, { success: tToast("expenseVoided") });
  const voided = expense.voided;
  // A void stays legible (D-24, §11.9): struck through, never also faded.
  const struck = voided ? "line-through text-text-secondary" : "";

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:flex-wrap md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex md:w-32 md:shrink-0 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">{t("columns.date")}</span>
        <span className={`truncate text-sm text-text-secondary ${struck}`}>
          {formatDate(new Date(expense.date), locale)}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-secondary md:sr-only">{t("columns.category")}</span>
        <span className={`truncate text-sm text-text-primary ${struck}`}>
          {expense.categoryName ?? t("fields.categoryNone")}
        </span>
      </div>

      <div className="flex min-w-0 flex-[2] flex-col">
        <span className="text-xs text-text-secondary md:sr-only">{t("columns.note")}</span>
        <span className={`truncate text-sm text-text-secondary ${struck}`}>{expense.note ?? "—"}</span>
      </div>

      <div className="flex flex-col md:w-32 md:shrink-0 md:text-end">
        <span className="text-xs text-text-secondary md:sr-only">{t("columns.amount")}</span>
        <span className={`text-sm font-medium whitespace-nowrap tabular-nums text-text-primary ${struck}`}>
          {formatMoney(expense.amount, locale)}
        </span>
      </div>

      <div className="shrink-0 md:w-32 md:text-end">
        {voided ? (
          <Badge variant="danger">{t("voidedBadge")}</Badge>
        ) : confirming ? null : (
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full px-4 md:w-auto"
            onClick={() => setConfirming(true)}
          >
            <Ban className="size-4" aria-hidden />
            {t("void")}
          </Button>
        )}
      </div>

      {voided ? (
        <p className="text-xs text-text-secondary md:basis-full">
          {t("voidedMeta", {
            name: voided.byName ?? t("unknownActor"),
            time: voided.at ? formatDateTime(new Date(voided.at), locale, timeZone) : "—",
          })}
          {voided.reason ? ` · ${t("voidReasonLine", { reason: voided.reason })}` : null}
        </p>
      ) : confirming ? (
        <form action={formAction} className="flex flex-col gap-2 md:basis-full md:flex-row md:items-end">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={expense.id} />
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="text-text-secondary">{t("voidReason")}</span>
            <Input
              name="reason"
              required
              maxLength={200}
              autoFocus
              autoComplete="off"
              aria-invalid={state.fieldErrors?.reason ? true : undefined}
              className="h-11"
            />
          </label>
          <div className="flex gap-2">
            {/* Pending state: a slow void cannot be submitted twice. */}
            <SubmitButton variant="destructive" className="px-3">
              {t("voidYes")}
            </SubmitButton>
            <Button type="button" variant="outline" className="h-11 px-3" onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {state.error || state.fieldErrors?.reason ? (
        <div className="md:w-full md:basis-full">
          <FormMessage>{tErrors(state.error ?? state.fieldErrors?.reason ?? "required")}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
