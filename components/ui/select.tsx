"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type SelectOptionItem = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

/**
 * Reads the options out of plain `<option>` children.
 *
 * The whole product already wrote its selects as `<option>` lists, and that
 * markup is the clearest way to express a short list inline — so this
 * component keeps accepting it rather than forcing every call site to build
 * an array. The `<option>` elements are never rendered; they are a
 * declaration of the list, and `Select` draws the real one.
 */
function optionsFromChildren(children: React.ReactNode): SelectOptionItem[] {
  const items: SelectOptionItem[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type !== "option") return;
    const props = child.props as React.ComponentProps<"option">;
    items.push({
      // A native `<option value={7}>` was coerced to "7" by the DOM; keep
      // that so a numeric option list posts the same string it always did.
      value: props.value === undefined ? "" : String(props.value),
      label: props.children,
      disabled: props.disabled,
    });
  });
  return items;
}

/**
 * The product's one dropdown control (docs/04-design-system.md §5 "Select").
 *
 * **Replaces the native `<select>`** the app shipped with. The old
 * `SelectInput` styled the closed control but handed the open list to the
 * browser, so the most-used control in the ERP dropped out of the design
 * system the moment anyone clicked it — different type, different metrics,
 * different highlight colour on every OS, and an option list that ignores the
 * app's direction in Arabic. Base UI's Select (already a dependency, like
 * `dialog.tsx` and `button.tsx`) renders the list itself, so the open state
 * is ours too: 44px rows, brand-tinted selection, a check on the chosen item,
 * full keyboard and type-ahead support, and correct RTL alignment.
 *
 * It still submits like a native select — Base UI renders a hidden input from
 * `name`/`value` — so every existing GET filter form and Server Action form
 * keeps working with no change to what it posts.
 *
 * `submitOnChange` reproduces the old `onChange={(e) => e.currentTarget.form
 * ?.requestSubmit()}` on the filter bars. It fires from an effect rather than
 * from the change handler so the hidden input is guaranteed to hold the new
 * value by the time the form serialises.
 */
function Select({
  id,
  name,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  options,
  children,
  placeholder,
  required,
  disabled,
  submitOnChange,
  className,
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: {
  id?: string;
  name?: string;
  defaultValue?: string;
  /** Pass with `onValueChange` for a controlled select; omit for uncontrolled. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** The list, as data. Mutually exclusive with `<option>` children. */
  options?: SelectOptionItem[];
  /** The list, as `<option>` markup — see `optionsFromChildren`. */
  children?: React.ReactNode;
  /** Shown when the value matches no option — a filter's "All" is an option, not this. */
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Re-submits the enclosing form as soon as a value is picked (filter bars). */
  submitOnChange?: boolean;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = controlledValue ?? uncontrolled;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const pendingSubmit = React.useRef(false);
  const items = React.useMemo(
    () => options ?? optionsFromChildren(children),
    [options, children],
  );

  React.useEffect(() => {
    if (!pendingSubmit.current) return;
    pendingSubmit.current = false;
    triggerRef.current?.closest("form")?.requestSubmit();
  }, [value]);

  const selected = items.find((option) => option.value === value);

  return (
    <SelectPrimitive.Root
      items={items}
      value={value}
      onValueChange={(raw: string | null) => {
        // Base UI models "nothing chosen" as null; the form contract here is
        // an empty string, the same thing a native select posted.
        const next = raw ?? "";
        if (controlledValue === undefined) setUncontrolled(next);
        if (submitOnChange) pendingSubmit.current = true;
        onValueChange?.(next);
      }}
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={triggerRef}
        id={id}
        aria-invalid={ariaInvalid}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className={cn(
          // Matches Input exactly (docs/04 §4/§6): 44px target, 8px radius.
          "flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border-control bg-surface px-3",
          "text-start text-sm text-foreground shadow-xs transition-ui outline-none select-none",
          "hover:border-border-control-hover hover:bg-surface-hover",
          "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
          "data-[popup-open]:border-brand data-[popup-open]:ring-3 data-[popup-open]:ring-brand/25",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
          className,
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate",
            // An empty choice ("Not set", "Choose a term") reads as a
            // placeholder, not as a chosen value (DES).
            selected && selected.value !== "" ? undefined : "text-text-placeholder",
          )}
        >
          {selected ? selected.label : (placeholder ?? "")}
        </span>
        <SelectPrimitive.Icon className="flex shrink-0 text-text-muted">
          {/* Points down, not forward — it must not mirror in RTL (docs/04 §7). */}
          <ChevronDown className="size-4" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50"
        >
          <SelectPrimitive.Popup
            className={cn(
              "max-h-[min(20rem,var(--available-height))] min-w-[var(--anchor-width)] max-w-[min(22rem,var(--available-width))]",
              "overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm shadow-popover outline-none",
              "origin-(--transform-origin) transition-ui",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {items.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "flex min-h-11 cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-primary outline-none",
                  "transition-ui-fast select-none",
                  "data-[highlighted]:bg-surface-hover",
                  "data-[selected]:font-medium data-[selected]:text-brand",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                )}
              >
                {/* The slot is always reserved, checked or not, so labels stay
                    on one baseline instead of shifting as the choice moves. */}
                <span className="flex size-4 shrink-0 items-center justify-center text-brand">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                  {option.label}
                </SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
