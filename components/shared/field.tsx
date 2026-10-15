"use client";

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { FieldError } from "@/components/shared/form-message";
import { Ltr } from "@/components/shared/ltr";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  // DES (docs/04 §14.1): a screen reader hears *why* a field is invalid — the
  // hint and the error are wired to the control. Only for a plain text field
  // (Input / Textarea / a DOM element), where the props reach the DOM; a
  // composite control (Select, DatePicker) is described by its own label.
  const control =
    isValidElement(children) &&
    (typeof children.type === "string" || children.type === Input || children.type === Textarea)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby":
            (children.props as Record<string, unknown>)["aria-describedby"] ?? describedBy,
          "aria-invalid":
            (children.props as Record<string, unknown>)["aria-invalid"] ?? (error ? true : undefined),
        })
      : children;

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="font-normal text-text-muted">{t("optional")}</span>
        ) : null}
      </Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/** A label→value pair, used by the detail panels and the paper printout. */
export function DetailRow({
  label,
  value,
  ltr,
  stacked,
}: {
  label: string;
  value: string | null | undefined;
  /** Phone numbers and emails stay LTR in both locales (docs/04 §7). */
  ltr?: boolean;
  /** Keep the label over the value at every width — for a half-width column,
   *  where a side label left an email too narrow to fit (DES, docs/04 §14.10). */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 border-b border-border-subtle py-2 last:border-0",
        !stacked && "sm:flex-row sm:items-baseline sm:gap-3",
      )}
    >
      <span className={cn("text-xs font-medium text-text-secondary", !stacked && "sm:w-36 sm:shrink-0")}>
        {label}
      </span>
      <span className="min-w-0 text-sm break-words text-text-primary">
        {value && value.length > 0 ? ltr ? <Ltr>{value}</Ltr> : value : "—"}
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
