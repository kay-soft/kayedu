import type { ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * A labelled boolean setting. The whole row is the label, so the touch target
 * is the full width rather than a 16px checkbox (docs/04 §6).
 *
 * Uncontrolled by default (`defaultChecked`); pass `checked` + `onCheckedChange`
 * when another field on the form has to react to it.
 */
export function ToggleRow({
  name,
  label,
  description,
  defaultChecked,
  checked,
  onCheckedChange,
  disabled,
  note,
  className,
}: {
  name: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  note?: ReactNode;
  className?: string;
}) {
  const id = `toggle-${name}`;

  return (
    <div
      className={cn(
        "rounded-xl border border-border p-3 sm:p-4",
        disabled && "opacity-60",
        className,
      )}
    >
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-start justify-between gap-3"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text-primary">
            {label}
          </span>
          {description ? (
            <span className="mt-1 block text-xs text-text-secondary">
              {description}
            </span>
          ) : null}
        </span>
        <Switch
          id={id}
          name={name}
          disabled={disabled}
          className="mt-0.5"
          {...(checked === undefined
            ? { defaultChecked }
            : { checked, onCheckedChange: (next) => onCheckedChange?.(next) })}
        />
      </label>
      {note ? <div className="mt-3">{note}</div> : null}
    </div>
  );
}
