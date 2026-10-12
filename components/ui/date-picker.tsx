"use client";

import * as React from "react";
import { CalendarDays, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A single date, picked from the app's own calendar rather than the browser's
 * (docs/04-design-system.md §5 "Date control"). Drop-in for the
 * `<input type="date">` this replaces everywhere: same `name`, same
 * `"YYYY-MM-DD"` value posted, same 44px control height as `Input`.
 *
 * The value lives in a real (hidden) input rather than in the trigger, so a
 * plain `<form>` — GET filter or Server Action — serialises it with no
 * client-side wiring at the call site.
 */
export function DatePicker({
  id,
  name,
  defaultValue = "",
  todayIso,
  required,
  disabled,
  clearable,
  submitOnChange,
  placeholder,
  className,
  onValueChange,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  name: string;
  defaultValue?: string;
  /**
   * Today, for the "today" marker and the month the calendar opens on. Pass
   * it from the server wherever the page already computes a server "now" (the
   * filter bars do), so the two cannot disagree; where there is no such value
   * it falls back to the viewer's own date. Nothing is submitted from it, and
   * the calendar only mounts once the popover opens, so the fallback cannot
   * cause a hydration mismatch.
   */
  todayIso?: string;
  required?: boolean;
  disabled?: boolean;
  /** Adds an inline clear affordance for a filter that has an "any date" state. */
  clearable?: boolean;
  /** Re-submits the enclosing form as soon as a date is picked (filter bars). */
  submitOnChange?: boolean;
  placeholder?: string;
  className?: string;
  /** Told the new "YYYY-MM-DD" (or "") whenever the date changes. */
  onValueChange?: (value: string) => void;
  "aria-invalid"?: boolean;
}) {
  const t = useTranslations("Shared.calendar");
  const locale = useLocale();
  const [value, setValue] = React.useState(defaultValue);
  const [fallbackToday] = React.useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const pendingSubmit = React.useRef(false);

  React.useEffect(() => {
    if (!pendingSubmit.current) return;
    pendingSubmit.current = false;
    rootRef.current?.closest("form")?.requestSubmit();
  }, [value]);

  function commit(next: string) {
    setValue(next);
    onValueChange?.(next);
    if (submitOnChange) pendingSubmit.current = true;
  }

  const parsed = value ? new Date(`${value}T00:00:00.000Z`) : null;
  const label =
    parsed && !Number.isNaN(parsed.getTime())
      ? formatDate(parsed, locale)
      : (placeholder ?? t("pickDate"));

  return (
    <div ref={rootRef} className={cn("relative flex w-full min-w-0", className)}>
      <input type="hidden" name={name} value={value} required={required} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          className={cn(
            "flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3",
            "text-start text-sm shadow-xs transition-ui outline-none",
            "hover:border-border-strong hover:bg-surface-hover",
            "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
            "data-[popup-open]:border-brand data-[popup-open]:ring-3 data-[popup-open]:ring-brand/25",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
            value ? "text-foreground" : "text-text-muted",
            clearable && value ? "pe-11" : undefined,
          )}
        >
          {/* A calendar icon has no direction — it must not mirror (docs/04 §7). */}
          <CalendarDays className="size-4 shrink-0 text-text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </PopoverTrigger>
        <PopoverContent className="p-0">
          <Calendar
            mode="single"
            value={{ from: value || null, to: null }}
            onChange={(next) => {
              commit(next.from ?? "");
              setOpen(false);
            }}
            todayIso={todayIso ?? fallbackToday}
          />
        </PopoverContent>
      </Popover>

      {clearable && value ? (
        <button
          type="button"
          onClick={() => commit("")}
          aria-label={t("clear")}
          className="absolute end-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted transition-ui-fast focus-ring hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
