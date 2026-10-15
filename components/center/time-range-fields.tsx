"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { TimePicker } from "@/components/ui/time-picker";
import { isValidTimeRange } from "@/lib/scheduling";
import { minutesBetween, suggestEndTime } from "@/lib/time-input";
import { cn } from "@/lib/utils";

/**
 * A start and an end time as one control (R6, docs/04 §11.15) — every start/end
 * pair in the product (class slot rows, New session, reschedule, the teacher
 * portal's request forms) is this, so the rule lives once:
 *
 * - choosing a **start** suggests the **end** as the start plus the previous
 *   duration (one hour when there was none), so a 4–6 slot moved to 5 becomes
 *   5–7 rather than leaving a broken range;
 * - an end that is not after the start is an inline error on the pair, and the
 *   pair posts `""` for nothing it cannot vouch for (each `TimePicker` posts
 *   its own parsed `"HH:mm"`, or nothing when its text is not a time).
 *
 * Controlled with `start`/`end` + `onChange`, or uncontrolled with
 * `defaultStart`/`defaultEnd` (the teacher portal forms). Posts `startName` /
 * `endName`.
 */
export function TimeRangeFields({
  idPrefix,
  startName = "startTime",
  endName = "endTime",
  startLabel,
  endLabel,
  start: controlledStart,
  end: controlledEnd,
  defaultStart = "",
  defaultEnd = "",
  onChange,
  error,
  required,
  disabled,
  className,
}: {
  idPrefix: string;
  startName?: string;
  endName?: string;
  startLabel: string;
  endLabel: string;
  start?: string;
  end?: string;
  defaultStart?: string;
  defaultEnd?: string;
  onChange?: (next: { start: string; end: string }) => void;
  /** Already-translated server/field error for the pair. */
  error?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("Shared.timePicker");
  const [inner, setInner] = useState({ start: defaultStart, end: defaultEnd });
  const start = controlledStart ?? inner.start;
  const end = controlledEnd ?? inner.end;

  function update(next: { start: string; end: string }) {
    setInner(next);
    onChange?.(next);
  }

  function changeStart(nextStart: string) {
    if (nextStart === "") return update({ start: "", end });
    const previousDuration = isValidTimeRange(start, end) ? minutesBetween(start, end) : null;
    update({ start: nextStart, end: suggestEndTime(nextStart, previousDuration) ?? end });
  }

  const reversed = start !== "" && end !== "" && !isValidTimeRange(start, end);
  const message = reversed ? t("endAfterStart") : error;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="grid grid-cols-2 gap-3">
        <Field id={`${idPrefix}-start`} label={startLabel}>
          <TimePicker
            id={`${idPrefix}-start`}
            name={startName}
            value={start}
            onValueChange={changeStart}
            required={required}
            disabled={disabled}
            aria-invalid={message ? true : undefined}
          />
        </Field>
        <Field id={`${idPrefix}-end`} label={endLabel}>
          <TimePicker
            id={`${idPrefix}-end`}
            name={endName}
            value={end}
            onValueChange={(nextEnd) => update({ start, end: nextEnd })}
            required={required}
            disabled={disabled}
            aria-invalid={message ? true : undefined}
          />
        </Field>
      </div>
      {message ? (
        <p role="alert" className="text-xs text-danger-fg">
          {message}
        </p>
      ) : null}
    </div>
  );
}
