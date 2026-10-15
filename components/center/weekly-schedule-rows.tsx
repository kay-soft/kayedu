"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { TimeRangeFields } from "@/components/center/time-range-fields";
import { Field } from "@/components/shared/field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { weeklySlotsError, type WeeklySlotRow } from "@/lib/scheduling";
import { MAX_WEEKLY_SLOT_ROWS } from "@/lib/validation/classes";

type Row = { key: number; dayOfWeek: number; startTime: string; endTime: string };

const DAY_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The weekly schedule of a **new** class (R6, docs/04 §11.15): one row per
 * weekly slot — weekday, start, end — with Add row / Remove, at least one row
 * required (Remove is off on the last). Each row's times are the shared
 * `TimeRangeFields`, so choosing a start suggests the end. Two rows on the same
 * weekday that overlap are rejected inline on the second one, by the same
 * rule the server enforces (`lib/scheduling.ts`'s `weeklySlotsError`).
 *
 * The rows post as one JSON field, `slots`; `onChange` hands the parent the
 * rows as they stand (a half-typed row included) for the live conflict
 * preview, which checks only the complete, non-overlapping ones.
 */
export function WeeklyScheduleRows({
  idPrefix,
  defaultRows,
  onChange,
  error,
}: {
  idPrefix: string;
  defaultRows?: WeeklySlotRow[];
  onChange?: (rows: WeeklySlotRow[]) => void;
  /** Already-translated server error for the whole list. */
  error?: string;
}) {
  const t = useTranslations("Classes.schedule");
  const tDays = useTranslations("Classes");
  const tErrors = useTranslations("Classes.errors");
  const dayNames = tDays.raw("dayNames") as string[];

  const [rows, setRows] = useState<Row[]>(() =>
    (defaultRows && defaultRows.length > 0 ? defaultRows : [{ dayOfWeek: 6, startTime: "", endTime: "" }]).map(
      (row, index) => ({ key: index, ...row }),
    ),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  function commit(next: Row[]) {
    setRows(next);
    onChange?.(next.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime })));
  }

  function patch(key: number, change: Partial<Omit<Row, "key">>) {
    commit(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function addRow() {
    const last = rows[rows.length - 1];
    const used = new Set(rows.map((row) => row.dayOfWeek));
    const dayOfWeek = DAY_VALUES.find((day) => !used.has(day)) ?? ((last?.dayOfWeek ?? 5) + 1) % 7;
    setNextKey(nextKey + 1);
    commit([...rows, { key: nextKey, dayOfWeek, startTime: last?.startTime ?? "", endTime: last?.endTime ?? "" }]);
  }

  // Only the overlap is explained per row here; a reversed range is explained
  // by the row's own TimeRangeFields, an empty time by the server's message.
  const problem = weeklySlotsError(rows, { required: true });
  const overlapIndex = problem?.error === "slotOverlap" ? problem.index : -1;

  return (
    <div className="flex flex-col gap-3">
      <input
        type="hidden"
        name="slots"
        value={JSON.stringify(
          rows.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime })),
        )}
      />
      <ul className="flex flex-col gap-3">
        {rows.map((row, index) => (
          <li key={row.key} className="flex flex-col gap-1.5">
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start">
              <Field
                id={`${idPrefix}-day-${row.key}`}
                label={t("day")}
                className="sm:w-44 sm:shrink-0"
              >
                <Select
                  id={`${idPrefix}-day-${row.key}`}
                  value={String(row.dayOfWeek)}
                  onValueChange={(day) => patch(row.key, { dayOfWeek: Number(day) })}
                >
                  {DAY_VALUES.map((day) => (
                    <option key={day} value={day}>
                      {dayNames[day]}
                    </option>
                  ))}
                </Select>
              </Field>
              <TimeRangeFields
                idPrefix={`${idPrefix}-time-${row.key}`}
                // The rows post as one JSON `slots` field; these just must not collide.
                startName={`${idPrefix}-start-${row.key}`}
                endName={`${idPrefix}-end-${row.key}`}
                startLabel={t("start")}
                endLabel={t("end")}
                start={row.startTime}
                end={row.endTime}
                onChange={({ start, end }) => patch(row.key, { startTime: start, endTime: end })}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                disabled={rows.length === 1}
                aria-label={t("removeRow")}
                onClick={() => commit(rows.filter((candidate) => candidate.key !== row.key))}
                className="size-11 self-end p-0 text-text-muted hover:text-danger-fg sm:mt-[1.625rem] sm:self-start"
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            {overlapIndex === index ? (
              <p role="alert" className="text-xs text-danger-fg">
                {tErrors("slotOverlap")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= MAX_WEEKLY_SLOT_ROWS}
          onClick={addRow}
          className="h-11 w-full gap-2 px-4 sm:w-auto"
        >
          <Plus className="size-4" aria-hidden />
          {t("addRow")}
        </Button>
        <p className="text-xs text-text-muted">{t("rowsHint")}</p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
