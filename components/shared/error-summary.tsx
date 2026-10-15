"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";

import { FormMessage } from "@/components/shared/form-message";

/**
 * The error summary at the top of a multi-section form (DES, Phase 3;
 * docs/04 §14.2): how many fields need attention, and a way to the first.
 * One error is clear enough beside its field, so the summary needs two. Each
 * field still says its own error inline — this is the signpost, not a copy.
 */
export function ErrorSummary({ fieldErrors }: { fieldErrors?: Record<string, string> | null }) {
  const t = useTranslations("Shared.errorSummary");
  const ref = useRef<HTMLDivElement>(null);
  const count = fieldErrors ? Object.keys(fieldErrors).length : 0;
  if (count < 2) return null;

  return (
    <div ref={ref}>
      <FormMessage>
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>{t("title", { count })}</span>
          <button
            type="button"
            className="min-h-11 rounded-sm font-medium underline underline-offset-2 focus-ring sm:min-h-0"
            onClick={() => {
              ref.current
                ?.closest("form")
                ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
            }}
          >
            {t("first")}
          </button>
        </span>
      </FormMessage>
    </div>
  );
}
