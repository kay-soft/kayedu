"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { deleteExpenseAction } from "@/app/[locale]/(center)/expenses/actions";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/lib/format";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

export type ExpenseRowData = {
  id: string;
  date: string;
  categoryName: string | null;
  amount: number;
  note: string | null;
};

/** One expense entry. Stacked card below `md`, table row from `md` up (docs/04 §6). */
export function ExpenseRow({ expense }: { expense: ExpenseRowData }) {
  const t = useTranslations("Expenses");
  const tErrors = useTranslations("Expenses.errors");
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useActionState(deleteExpenseAction, IDLE_ACTION_STATE);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex w-32 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.date")}</span>
        <span className="truncate text-sm text-text-secondary">
          {formatDate(new Date(expense.date), locale)}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.category")}</span>
        <span className="truncate text-sm text-text-primary">
          {expense.categoryName ?? t("fields.categoryNone")}
        </span>
      </div>

      <div className="flex min-w-0 flex-[2] flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.note")}</span>
        <span className="truncate text-sm text-text-secondary">{expense.note ?? "—"}</span>
      </div>

      <div className="flex w-28 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.amount")}</span>
        <span className="truncate text-sm font-medium tabular-nums text-text-primary">
          {formatMoney(expense.amount, locale)}
        </span>
      </div>

      <div className="shrink-0 md:w-32 md:text-end">
        {confirming ? (
          <form action={formAction} className="flex items-center justify-end gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="id" value={expense.id} />
            <Button type="submit" variant="destructive" className="h-11 px-3">
              {t("deleteYes")}
            </Button>
            <Button type="button" variant="outline" className="h-11 px-3" onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full px-4 md:w-auto"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-4" />
            {t("delete")}
          </Button>
        )}
      </div>

      {state.error ? (
        <div className="md:w-full md:basis-full">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
    </li>
  );
}
