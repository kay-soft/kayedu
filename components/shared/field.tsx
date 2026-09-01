import type { ReactNode } from "react";

import { FieldError } from "@/components/shared/form-message";
import { Label } from "@/components/ui/label";

/**
 * One labelled form control with its hint and error. Every people form is
 * built from these, so spacing, label size and error placement stay identical
 * across screens instead of being re-invented per form (docs/04 §4).
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Already-translated message; the caller owns the i18n lookup. */
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-text-muted">{hint}</p> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/** A label→value pair, used by the detail panels and the paper printout. */
export function DetailRow({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string | null | undefined;
  /** Phone numbers and emails stay LTR in both locales (docs/04 §7). */
  ltr?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border-subtle py-2 last:border-0 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="text-xs font-medium text-text-muted sm:w-40 sm:shrink-0">
        {label}
      </span>
      <span
        className="min-w-0 text-sm break-words text-text-primary"
        dir={ltr ? "ltr" : undefined}
      >
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}
