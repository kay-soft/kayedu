"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { FieldError } from "@/components/shared/form-message";
import { Label } from "@/components/ui/label";

/**
 * One labelled form control with its hint and error. Every people form is
 * built from these, so spacing, label size and error placement stay identical
 * across screens instead of being re-invented per form (docs/04 §4).
 *
 * `optional` is the mandatory form convention (docs/04 §5 "Form fields"): a
 * field that is genuinely always optional gets a dimmed "(optional)" beside
 * its label, so staff never have to guess or hit a validation error to find
 * out. Never set it on a field that is *conditionally* required (e.g. "phone
 * or email") — a hint sentence says that better than a wrong "(optional)" tag.
 */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  /** Already-translated message; the caller owns the i18n lookup. */
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations("Shared");

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="font-normal text-text-muted">{t("optional")}</span>
        ) : null}
      </Label>
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

/**
 * A titled group of fields inside a form that lives in a card (R10b, the edit
 * form on the student and teacher pages): a 14px semibold heading, an optional
 * one-line hint, then the fields. Groups are separated by a hairline, not
 * boxed — a bordered `FormSection` inside a `Card` would be a card in a card.
 * (`FormSection` in `dialog-shell.tsx` is the boxed form of the same idea,
 * for a dialog body.)
 */
export function FormGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border-subtle pt-5 first:border-t-0 first:pt-0">
      <header>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs text-text-muted">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
