"use client";

import { startTransition } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createExpenseAction } from "@/app/[locale]/(center)/expenses/actions";
import { Field } from "@/components/shared/field";
import { ErrorSummary } from "@/components/shared/error-summary";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { IDLE_ACTION_STATE } from "@/lib/validation/form";
import { expenseCreateSchema } from "@/lib/validation/analytics";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { useClientValidation } from "@/lib/ui/client-validation";

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
  todayIso,
}: {
  categories: ExpenseCategoryOption[];
  /** Remounts the form (clearing it) after a successful create. */
  rowCount: number;
  /** The centre's calendar day (R7b), computed on the server — never the browser's. */
  todayIso: string;
}) {
  const t = useTranslations("Expenses");
  const tErrors = useTranslations("Expenses.errors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(createExpenseAction, IDLE_ACTION_STATE);
  // The action's own schema, run before the round trip (docs/04 §14.2).
  const { clientErrors, check } = useClientValidation(expenseCreateSchema);
  const fieldErrors = clientErrors ?? state.fieldErrors;
  const tToast = useTranslations("Toasts");
  useActionFeedback(state, { success: tToast("expenseAdded") });

  return (
    // `startTransition` with the form's own FormData, not `<form action>`: React
    // 19 resets an uncontrolled form once its action returns, so a refused
    // amount cleared everything typed (DES, docs/04 §14.7). A success still
    // empties it — the key follows the row count.
    <form
      key={`expense-${rowCount}`}
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
    if (!check(event.currentTarget, formData)) return;
        startTransition(() => formAction(formData));
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <ErrorSummary fieldErrors={fieldErrors} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          id="expense-categoryId"
          label={t("fields.category")}
          optional
          error={fieldErrors?.categoryId ? tErrors(fieldErrors.categoryId) : undefined}
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
          error={fieldErrors?.amount ? tErrors(fieldErrors.amount) : undefined}
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
          error={fieldErrors?.date ? tErrors(fieldErrors.date) : undefined}
        >
          <DatePicker
            id="expense-date"
            name="date"
            defaultValue={todayIso}
            todayIso={todayIso}
            required
          />
        </Field>

        <Field
          id="expense-note"
          label={t("fields.note")}
          optional
          error={fieldErrors?.note ? tErrors(fieldErrors.note) : undefined}
        >
          <Input id="expense-note" name="note" maxLength={200} placeholder={t("fields.notePlaceholder")} />
        </Field>
      </div>

      <SubmitButton className="w-full sm:w-auto sm:self-start">{t("add")}</SubmitButton>
    </form>
  );
}
