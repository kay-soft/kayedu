"use client";

import * as React from "react";
import { Clock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatNumber, formatTime, formatTwoDigits } from "@/lib/format";
import {
  fromTimeParts,
  parseTimeInput,
  timeParts,
  type Meridiem,
  type TimeParseError,
} from "@/lib/time-input";
import { cn } from "@/lib/utils";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);
const QUICK_MINUTES = [0, 15, 30, 45] as const;

const LIST_BUTTON =
  "flex min-h-11 w-full items-center justify-center rounded-lg px-2 text-sm tabular-nums transition-ui-fast focus-ring " +
  "text-text-primary hover:bg-surface-hover active:bg-surface-active " +
  "aria-pressed:bg-brand aria-pressed:font-semibold aria-pressed:text-brand-foreground";

/**
 * The product's one time control (R6, docs/04-design-system.md §11.15) —
 * replaces every browser-native time field. Like the `DatePicker` beside it:
 * a 44px field that opens a popover, and a hidden input that posts the stored
 * **24-hour `"HH:mm"`** string, so a plain `<form>` serialises it with no
 * wiring and the database is untouched.
 *
 * Two ways in, one result:
 * - **Type it.** The field accepts `4`, `4pm`, `16:30`, `4:30 pm`, Arabic-Indic
 *   digits and ص / م — parsed by `lib/time-input.ts` (the one parser) when you
 *   leave the field or press Enter, then shown back in the locale's 12-hour
 *   format (`lib/format.ts`). Anything that is not a time gets an inline
 *   error and posts **nothing** — it is never guessed at.
 * - **Pick it.** The clock opens an hour list, a minute list with 00 / 15 /
 *   30 / 45 as quick picks, and an AM/PM toggle; each pick updates the field.
 */
export function TimePicker({
  id,
  name,
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  required,
  disabled,
  placeholder,
  className,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  name: string;
  /** Pass with `onValueChange` for a controlled field; omit for uncontrolled. */
  value?: string;
  defaultValue?: string;
  /** Told the new `"HH:mm"` — or `""` when the field is empty or its text is not a time. */
  onValueChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-invalid"?: boolean;
}) {
  const t = useTranslations("Shared.timePicker");
  const locale = useLocale();
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = controlledValue ?? uncontrolled;
  const [text, setText] = React.useState(() => (value ? formatTime(value, locale) : ""));
  const [parseError, setParseError] = React.useState<TimeParseError | null>(null);
  const [open, setOpen] = React.useState(false);
  // What this field last told its parent — a different `value` is the parent's.
  const lastEmitted = React.useRef(value);
  const errorId = React.useId();

  React.useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setText(value ? formatTime(value, locale) : "");
    setParseError(null);
  }, [value, locale]);

  const parts = timeParts(value);
  const [draft, setDraft] = React.useState<{ hour12: number | null; minute: number; meridiem: Meridiem }>({
    hour12: parts?.hour12 ?? null,
    minute: parts?.minute ?? 0,
    meridiem: parts?.meridiem ?? "PM",
  });

  function emit(next: string) {
    lastEmitted.current = next;
    setUncontrolled(next);
    onValueChange?.(next);
  }

  function commitText() {
    const trimmed = text.trim();
    if (trimmed === "") {
      setParseError(null);
      if (value !== "") emit("");
      return;
    }
    const parsed = parseTimeInput(trimmed, { defaultMeridiem: parts?.meridiem });
    if (parsed.ok) {
      setParseError(null);
      emit(parsed.value);
      setText(formatTime(parsed.value, locale));
    } else {
      // Never coerce: the field keeps what was typed, shows why, and posts nothing.
      setParseError(parsed.error);
      if (value !== "") emit("");
    }
  }

  function pick(patch: Partial<{ hour12: number; minute: number; meridiem: Meridiem }>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (next.hour12 === null) return;
    const result = fromTimeParts(next.hour12, next.minute, next.meridiem);
    setParseError(null);
    emit(result);
    setText(formatTime(result, locale));
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      const current = timeParts(value);
      setDraft({
        hour12: current?.hour12 ?? null,
        minute: current?.minute ?? 0,
        meridiem: current?.meridiem ?? "PM",
      });
    }
  }

  const invalid = ariaInvalid || parseError !== null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="relative flex w-full min-w-0">
        <input type="hidden" name={name} value={value} required={required} />
        <input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          // No `dir="ltr"` (DES): the value is a locale-formatted time that
          // carries its own direction (docs/04 §3). An LTR input inside an RTL
          // page put its end padding on the right while the clock button sat
          // at the logical end (the left) — the button covered the time.
          disabled={disabled}
          value={text}
          placeholder={placeholder ?? t("placeholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={parseError ? errorId : undefined}
          onChange={(event) => setText(event.currentTarget.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Enter commits the text — it must not submit the surrounding form.
              event.preventDefault();
              commitText();
            }
          }}
          className={cn(
            "flex h-11 w-full min-w-0 rounded-lg border border-border-control bg-surface ps-3 pe-11 text-start text-sm text-foreground shadow-xs outline-none transition-ui",
            "placeholder:text-text-placeholder hover:border-border-control-hover",
            "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
          )}
        />
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger
            disabled={disabled}
            aria-label={t("open")}
            className="absolute inset-y-0 end-0 flex size-11 items-center justify-center rounded-lg text-text-muted transition-ui-fast focus-ring hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
          >
            {/* A clock face has no direction — it must not mirror (docs/04 §7). */}
            <Clock className="size-4" aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="end" className="p-3">
            <div className="flex flex-col gap-3">
              <div className="flex gap-3">
                <PickerColumn label={t("hours")}>
                  {HOURS.map((hour) => (
                    <button
                      key={hour}
                      type="button"
                      aria-pressed={draft.hour12 === hour}
                      onClick={() => pick({ hour12: hour })}
                      className={LIST_BUTTON}
                    >
                      {formatNumber(hour, locale)}
                    </button>
                  ))}
                </PickerColumn>

                <div className="flex w-24 flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-secondary">{t("minutes")}</span>
                  <div className="grid grid-cols-2 gap-1" role="group" aria-label={t("quickMinutes")}>
                    {QUICK_MINUTES.map((minute) => (
                      <button
                        key={minute}
                        type="button"
                        aria-pressed={draft.minute === minute}
                        onClick={() => pick({ minute })}
                        className={cn(LIST_BUTTON, "border border-border")}
                      >
                        {formatTwoDigits(minute, locale)}
                      </button>
                    ))}
                  </div>
                  <ScrollList label={t("minutes")}>
                    {MINUTES.map((minute) => (
                      <button
                        key={minute}
                        type="button"
                        aria-pressed={draft.minute === minute}
                        onClick={() => pick({ minute })}
                        className={LIST_BUTTON}
                      >
                        {formatTwoDigits(minute, locale)}
                      </button>
                    ))}
                  </ScrollList>
                </div>

                <div className="flex w-16 flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-secondary">{t("period")}</span>
                  {(["AM", "PM"] as const).map((meridiem) => (
                    <button
                      key={meridiem}
                      type="button"
                      aria-pressed={draft.meridiem === meridiem}
                      onClick={() => pick({ meridiem })}
                      className={cn(LIST_BUTTON, "border border-border")}
                    >
                      {meridiem === "AM" ? t("am") : t("pm")}
                    </button>
                  ))}
                </div>
              </div>
              <Button type="button" className="h-11 w-full" onClick={() => onOpenChange(false)}>
                {t("done")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {parseError ? (
        <p id={errorId} role="alert" className="text-xs text-danger-fg">
          {parseError === "outOfRange" ? t("outOfRange") : t("invalid")}
        </p>
      ) : null}
    </div>
  );
}

function PickerColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-14 flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <ScrollList label={label} tall>
        {children}
      </ScrollList>
    </div>
  );
}

/** A scrolling column of picks that opens with the chosen one in view. */
function ScrollList({
  label,
  tall,
  children,
}: {
  label: string;
  tall?: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const list = ref.current;
    const chosen = list?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (list && chosen) list.scrollTop = chosen.offsetTop - list.clientHeight / 2 + chosen.clientHeight / 2;
  }, []);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn("relative flex flex-col gap-0.5 overflow-y-auto", tall ? "max-h-56" : "max-h-36")}
    >
      {children}
    </div>
  );
}
