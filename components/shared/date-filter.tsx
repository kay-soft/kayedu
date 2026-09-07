"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DateFilterValue = {
  range: "day" | "week" | "month" | "date" | "range";
  /** "YYYY-MM-DD" — only meaningful when range === "date". */
  date: string;
  /** "YYYY-MM-DD" — only meaningful when range === "range". */
  from: string;
  to: string;
};

const QUICK: DateFilterValue["range"][] = ["day", "week", "month"];

/**
 * The ONE shared date filter (M18, docs/04-design-system.md §11.7): Day /
 * Week (today −7) / Month (1st → today) quick buttons, a specific-date
 * picker, a range picker, an Apply action, and a reset back to today's
 * default. Every screen that filters by date renders this — never its own
 * ad-hoc controls.
 *
 * Not its own `<form>` — a fragment meant to sit inside the page's existing
 * filter `<form>` alongside whatever else that screen filters by (a teacher
 * select on Analytics, status/subject/class on Sessions), so one submit
 * carries every field. Buttons apply immediately (`type="submit"`, native
 * form navigation); the two pickers wait for the Apply button, so a custom
 * range never re-queries after only the first of its two dates is picked.
 */
export function DateFilter({
  value,
  todayIso,
  resetHref,
}: {
  value: DateFilterValue;
  /** Today's date, "YYYY-MM-DD" — computed server-side so it can't drift from the query's own "now". */
  todayIso: string;
  /** Where "Reset" navigates — the bare page path, no query string. */
  resetHref: string;
}) {
  const t = useTranslations("Shared.dateFilter");
  const locale = useLocale();
  const [picker, setPicker] = useState<"none" | "date" | "range">(
    value.range === "date" ? "date" : value.range === "range" ? "range" : "none",
  );

  const activeLabel = describeDateFilter(value, locale, t);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex gap-1 rounded-lg border border-border bg-surface p-1"
          role="group"
          aria-label={t("groupLabel")}
        >
          {QUICK.map((kind) => {
            const selected = picker === "none" && value.range === kind;
            return (
              <button
                key={kind}
                type="submit"
                name="range"
                value={kind}
                onClick={() => setPicker("none")}
                aria-pressed={selected}
                className={cn(
                  "min-h-9 rounded-md px-3 text-sm font-medium transition-colors",
                  selected
                    ? "bg-brand text-brand-fg"
                    : "text-text-secondary hover:bg-surface-subtle",
                )}
              >
                {t(kind)}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setPicker(picker === "date" ? "none" : "date")}
          className={cn(
            "min-h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
            picker === "date"
              ? "border-brand text-brand"
              : "border-border text-text-secondary hover:bg-surface-subtle",
          )}
        >
          {t("pickDate")}
        </button>
        <button
          type="button"
          onClick={() => setPicker(picker === "range" ? "none" : "range")}
          className={cn(
            "min-h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
            picker === "range"
              ? "border-brand text-brand"
              : "border-border text-text-secondary hover:bg-surface-subtle",
          )}
        >
          {t("pickRange")}
        </button>

        <span className="text-xs text-text-muted">{activeLabel}</span>
      </div>

      {picker === "date" ? (
        <div className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="date" />
          <input
            type="date"
            name="date"
            dir="ltr"
            defaultValue={value.date || todayIso}
            className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
          />
          <button
            type="submit"
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg"
          >
            {t("apply")}
          </button>
        </div>
      ) : null}

      {picker === "range" ? (
        <div className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="range" />
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-from" className="text-xs font-medium text-text-secondary">
              {t("from")}
            </label>
            <input
              id="filter-from"
              type="date"
              name="from"
              dir="ltr"
              defaultValue={value.from || todayIso}
              className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-to" className="text-xs font-medium text-text-secondary">
              {t("to")}
            </label>
            <input
              id="filter-to"
              type="date"
              name="to"
              dir="ltr"
              defaultValue={value.to || todayIso}
              className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
            />
          </div>
          <button
            type="submit"
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg"
          >
            {t("apply")}
          </button>
        </div>
      ) : null}

      <a
        href={resetHref}
        className="w-fit text-xs font-medium text-text-secondary underline-offset-2 hover:underline"
      >
        {t("reset")}
      </a>
    </div>
  );
}

function describeDateFilter(
  value: DateFilterValue,
  locale: string,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  switch (value.range) {
    case "day":
      return t("activeDay");
    case "week":
      return t("activeWeek");
    case "month":
      return t("activeMonth");
    case "date":
      return value.date
        ? formatDate(new Date(`${value.date}T00:00:00.000Z`), locale)
        : t("activeDay");
    case "range": {
      if (!value.from && !value.to) return t("activeRange", { from: "—", to: "—" });
      const from = value.from ? formatDate(new Date(`${value.from}T00:00:00.000Z`), locale) : "—";
      const to = value.to ? formatDate(new Date(`${value.to}T00:00:00.000Z`), locale) : "—";
      return t("activeRange", { from, to });
    }
  }
}
