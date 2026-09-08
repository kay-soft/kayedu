"use client";

import { useState } from "react";
import { Banknote, CreditCard, Smartphone, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type PaymentMethodValue = "CASH" | "INSTAPAY" | "WALLET" | "VISA";

const ORDER: PaymentMethodValue[] = ["CASH", "INSTAPAY", "WALLET", "VISA"];

const ICONS: Record<PaymentMethodValue, typeof Banknote> = {
  CASH: Banknote,
  INSTAPAY: Smartphone,
  WALLET: Wallet,
  VISA: CreditCard,
};

/**
 * Payment method selector (docs/04-design-system.md §5): icon + label
 * buttons in a row, selected state uses a brand-colored ring, Cash
 * preselected by default. This is client selection state (unlike the
 * Attendance control) because the method is chosen *before* the surrounding
 * form's single submit button records the payment — so it renders a hidden
 * `name="method"` input the submit carries along.
 */
export function PaymentMethodSelector({
  name = "method",
  defaultValue = "CASH",
}: {
  name?: string;
  defaultValue?: PaymentMethodValue;
}) {
  const t = useTranslations("Sessions.paymentMethod");
  const [selected, setSelected] = useState<PaymentMethodValue>(defaultValue);

  return (
    <div role="group" aria-label={t("groupLabel")} className="flex flex-wrap gap-2">
      <input type="hidden" name={name} value={selected} />
      {ORDER.map((method) => {
        const Icon = ICONS[method];
        const isSelected = selected === method;
        return (
          <button
            key={method}
            type="button"
            onClick={() => setSelected(method)}
            aria-pressed={isSelected}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-ui focus-ring",
              isSelected
                ? "border-brand bg-brand/10 text-brand ring-2 ring-brand/30"
                : "border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-hover active:bg-surface-active",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {t(method)}
          </button>
        );
      })}
    </div>
  );
}
