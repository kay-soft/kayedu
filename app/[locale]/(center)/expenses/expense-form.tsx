"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createExpenseAction } from "@/app/[locale]/(center)/expenses/actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";

export type ExpenseCategoryOption = { value: string; label: string };

/**
 * Add-expense form (spec §4.1 item 6: category, amount, date, note). One
 * submit records an append-and-audit `Expense` row (`createExpenseAction`) —
 * there is no in-place edit, matching the money-adjacent "correct by
 * void/delete, not silent overwrite" spirit (CLAUDE.md rule 2).
 */
export function ExpenseForm({
  categories,
  rowCount,
}: {
  categories: ExpenseCategoryOption[];
  /** Remounts the form (clearing it) after a successful create. */
  rowCount: number;
}) {
  const t = useTranslations("Expenses");
  const tErrors = useTranslations("Expenses.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(createExpenseAction, IDLE_ACTION_STATE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form key={`expense-${rowCount}`} action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          id="expense-categoryId"
          label={t("fields.category")}
          optional
          error={state.fieldErrors?.categoryId ? tErrors(state.fieldErrors.categoryId) : undefined}
        >
          <Select id="expense-categoryId" name="categoryId" defaultValue="">
            <option value="">{t("fields.categoryNone")}</option>
            {categories.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="expense-amount"
          label={t("fields.amount")}
          hint={t("fields.amountHint")}
          error={state.fieldErrors?.amount ? tErrors(state.fieldErrors.amount) : undefined}
        >
          <Input
            id="expense-amount"
            name="amount"
            type="number"
            dir="ltr"
            inputMode="decimal"
            min={0}
            step="0.01"
            required
          />
        </Field>

        <Field
          id="expense-date"
          label={t("fields.date")}
          error={state.fieldErrors?.date ? tErrors(state.fieldErrors.date) : undefined}
        >
          <DatePicker
            id="expense-date"
            name="date"
            defaultValue={today}
            todayIso={today}
            required
          />
        </Field>

        <Field
          id="expense-note"
          label={t("fields.note")}
          optional
          error={state.fieldErrors?.note ? tErrors(state.fieldErrors.note) : undefined}
        >
          <Input id="expense-note" name="note" maxLength={200} placeholder={t("fields.notePlaceholder")} />
        </Field>
      </div>

      <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
    </form>
  );
}
