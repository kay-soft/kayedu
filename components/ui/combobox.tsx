"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronDown, X } from "lucide-react";

import { matchesPicker } from "@/lib/picker-search";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  /** Matched through `lib/phone.ts` and shown under the name. */
  phone?: string | null;
  /** A muted second line (when there is no phone). */
  description?: string | null;
};

/**
 * The product's one searchable picker (R6, docs/04-design-system.md §11.16) —
 * for any list long enough that scrolling it is slower than typing: the
 * centre's teachers (every class and session dialog) and its classes (the
 * New session dialog).
 *
 * Type to filter — by name **and** phone, the phone through `lib/phone.ts`
 * (`lib/picker-search.ts`), any format, no minimum length; arrow keys move,
 * Enter picks, Escape closes; a "no results" row; a clear button; a chevron
 * that opens the whole list. Built on Base UI's Combobox (already a
 * dependency), so the input is `role="combobox"`, the list a `listbox` with
 * `option` rows and `aria-activedescendant` — the accessibility is the
 * primitive's, not re-invented. The list is portalled, so a dialog's
 * scrolling body never clips it.
 *
 * Posts the chosen option's `value` under `name`, like the `Select` it sits
 * beside. The list is whatever the server already scoped to the centre; this
 * only filters it.
 */
export function Combobox({
  id,
  name,
  options,
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  placeholder,
  emptyLabel,
  clearLabel,
  openLabel,
  required,
  disabled,
  className,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  name?: string;
  options: ComboboxOption[];
  /** Pass with `onValueChange` for a controlled picker; omit for uncontrolled. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** "No teachers match" — already translated. */
  emptyLabel: string;
  clearLabel: string;
  openLabel: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = controlledValue ?? uncontrolled;
  const selected = options.find((option) => option.value === current) ?? null;

  return (
    <ComboboxPrimitive.Root
      items={options}
      value={selected}
      onValueChange={(next: ComboboxOption | null) => {
        const nextValue = next?.value ?? "";
        setUncontrolled(nextValue);
        onValueChange?.(nextValue);
      }}
      itemToStringLabel={(option: ComboboxOption) => option.label}
      itemToStringValue={(option: ComboboxOption) => option.value}
      isItemEqualToValue={(a: ComboboxOption, b: ComboboxOption) => a.value === b.value}
      filter={(option: ComboboxOption, query: string) => matchesPicker(query, option)}
      name={name}
      required={required}
      disabled={disabled}
      autoHighlight
    >
      <ComboboxPrimitive.InputGroup className={cn("relative flex w-full min-w-0", className)}>
        <ComboboxPrimitive.Input
          id={id}
          placeholder={placeholder}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          className={cn(
            "flex h-11 w-full min-w-0 rounded-lg border border-border-control bg-surface ps-3 text-sm text-foreground shadow-xs outline-none transition-colors",
            selected ? "pe-[5.25rem]" : "pe-11",
            "placeholder:text-text-placeholder",
            "hover:border-border-control-hover",
            "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
          )}
        />
        <div className="absolute inset-y-0 end-0 flex items-center">
          <ComboboxPrimitive.Clear
            aria-label={clearLabel}
            className="flex size-11 items-center justify-center rounded-lg text-text-muted transition-ui-fast focus-ring hover:text-text-primary"
          >
            <X className="size-4" aria-hidden />
          </ComboboxPrimitive.Clear>
          <ComboboxPrimitive.Trigger
            aria-label={openLabel}
            className="flex size-11 items-center justify-center rounded-lg text-text-muted transition-ui-fast focus-ring hover:text-text-primary"
          >
            <ChevronDown className="size-4" aria-hidden />
          </ComboboxPrimitive.Trigger>
        </div>
      </ComboboxPrimitive.InputGroup>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner sideOffset={6} className="z-50 outline-none">
          <ComboboxPrimitive.Popup
            className={cn(
              "w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin)",
              "rounded-xl border border-border bg-popover text-sm text-popover-foreground shadow-popover",
              "transition-ui",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            <ComboboxPrimitive.Empty className="px-3 py-4 text-sm text-text-muted empty:hidden">
              {emptyLabel}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="scrollbar-neutral max-h-[min(18rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-none data-[empty]:p-0">
              {(option: ComboboxOption) => (
                <ComboboxPrimitive.Item
                  key={option.value}
                  value={option}
                  className={cn(
                    "flex min-h-11 w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start outline-none select-none",
                    "data-[highlighted]:bg-brand/10",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-text-primary">{option.label}</span>
                    {option.phone ? (
                      <span dir="ltr" className="block truncate text-start text-xs tabular-nums text-text-muted">
                        {formatPhone(option.phone)}
                      </span>
                    ) : option.description ? (
                      <span className="block truncate text-xs text-text-muted">{option.description}</span>
                    ) : null}
                  </span>
                  <ComboboxPrimitive.ItemIndicator className="shrink-0 text-brand">
                    <Check className="size-4" aria-hidden />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
