"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** One of the centre's *active* methods (R1), as a picker shows it. */
export type PaymentMethodOption = { id: string; name: string };

/**
 * Payment method selector (docs/04-design-system.md §5): icon + label
 * buttons in a row, selected state uses a brand-colored ring, the centre's
 * first method preselected. The options are the centre's own active
 * `CenterPaymentMethod` rows (R1) — the page reads them server-side, so a
 * deactivated method simply never appears here. This is client selection
 * state (unlike the Attendance control) because the method is chosen
 * *before* the surrounding form's single submit button records the payment —
 * so it renders a hidden `name="paymentMethodId"` input the submit carries
 * along. The server re-resolves that id (this centre, active) regardless.
 */
export function PaymentMethodSelector({
  methods,
  name = "paymentMethodId",
  defaultMethodId,
}: {
  methods: PaymentMethodOption[];
  name?: string;
  /** Preselect this method when it is still offered (R7: the last one used at the desk). */
  defaultMethodId?: string | null;
}) {
  const t = useTranslations("Sessions.paymentMethod");
  const [selected, setSelected] = useState<string>(
    methods.find((method) => method.id === defaultMethodId)?.id ?? methods[0]?.id ?? "",
  );

  if (methods.length === 0) {
    return <p className="text-sm text-text-muted">{t("noneActive")}</p>;
  }

  return (
    <div role="group" aria-label={t("groupLabel")} className="flex flex-wrap gap-2">
      <input type="hidden" name={name} value={selected} />
      {methods.map((method) => {
        const isSelected = selected === method.id;
        return (
          <button
            key={method.id}
            type="button"
            onClick={() => setSelected(method.id)}
            aria-pressed={isSelected}
            className={cn(
              "flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-ui focus-ring",
              isSelected
                ? "border-brand bg-brand/10 text-brand ring-2 ring-brand/30"
                : "border-border bg-surface text-text-secondary hover:border-border-strong hover:bg-surface-hover active:bg-surface-active",
            )}
          >
            <Wallet className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{method.name}</span>
          </button>
        );
      })}
    </div>
  );
}
