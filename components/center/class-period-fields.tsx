"use client";

import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { formatDayRange } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** A centre term preset, dates as "YYYY-MM-DD". */
export type TermOption = { id: string; name: string; startDate: string; endDate: string };

export type ClassPeriodValue = { startDate: string; endDate: string };

/**
 * "Class period" (R4, docs/04-design-system.md §11.13) — the start and end
 * date every class has, in two modes:
 *
 * - **Choose a term** lists the centre's active terms; picking one COPIES
 *   its dates into the two date fields below. The term itself is never
 *   posted — the class only ever stores dates, so editing the term later
 *   moves no class.
 * - **Custom dates** — the two shared `DatePicker`s on their own.
 *
 * The dates stay editable after a term fills them; touching either switches
 * to custom (the term no longer describes them). With no terms configured,
 * a hint links to Settings → Terms. Two segments are a segmented control,
 * not a dropdown (docs/04 §5), each a 44px target.
 */
export function ClassPeriodFields({
  idPrefix,
  terms,
  defaultValue,
  startError,
  endError,
  onChange,
}: {
  idPrefix: string;
  terms: TermOption[];
  defaultValue: ClassPeriodValue;
  startError?: string;
  endError?: string;
  onChange?: (next: ClassPeriodValue) => void;
}) {
  const t = useTranslations("Classes.period");
  const locale = useLocale();
  const hasTerms = terms.length > 0;
  const [mode, setMode] = useState<"term" | "custom">(
    hasTerms && !defaultValue.startDate ? "term" : "custom",
  );
  const [termId, setTermId] = useState("");
  const [dates, setDates] = useState(defaultValue);
  // Bumped when a term fills the dates, so the pickers remount on them.
  const [fillCount, setFillCount] = useState(0);

  function update(next: ClassPeriodValue) {
    setDates(next);
    onChange?.(next);
  }

  function pickTerm(id: string) {
    setTermId(id);
    const term = terms.find((row) => row.id === id);
    if (!term) return;
    update({ startDate: term.startDate, endDate: term.endDate });
    setFillCount((count) => count + 1);
  }

  function editDate(field: keyof ClassPeriodValue, value: string) {
    update({ ...dates, [field]: value });
    if (termId) {
      setTermId("");
      setMode("custom");
    }
  }

  const label = (term: TermOption) =>
    `${term.name} · ${formatDayRange(
      new Date(`${term.startDate}T00:00:00.000Z`),
      new Date(`${term.endDate}T00:00:00.000Z`),
      locale,
    )}`;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-3 sm:p-4">
      {/* Title and mode control side by side only from xl: the section is half
          a dialog wide, and from sm the segments had wrapped inside their track. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <CalendarRange className="size-4 text-text-muted" aria-hidden />
          {t("title")}
        </p>
        <div
          role="group"
          aria-label={t("modeLabel")}
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5"
        >
          {(["term", "custom"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={value === "term" && !hasTerms}
              onClick={() => setMode(value)}
              className={cn(
                "flex h-full min-w-11 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap",
                "transition-ui focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                mode === value
                  ? "bg-surface text-text-primary shadow-card"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
              )}
            >
              {value === "term" ? t("modeTerm") : t("modeCustom")}
            </button>
          ))}
        </div>
      </div>

      {!hasTerms ? (
        <p className="text-xs text-text-muted">
          {t.rich("noTerms", {
            link: (chunks) => (
              <Link href={ROUTES.centerSettingsTerms} className="font-medium text-brand hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : mode === "term" ? (
        <Field id={`${idPrefix}-term`} label={t("term")} hint={t("termHint")}>
          <Select id={`${idPrefix}-term`} value={termId} onValueChange={pickTerm}>
            <option value="" disabled>
              {t("termPlaceholder")}
            </option>
            {terms.map((term) => (
              <option key={term.id} value={term.id}>
                {label(term)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-startDate`} label={t("startDate")} error={startError}>
          <DatePicker
            key={`start-${fillCount}`}
            id={`${idPrefix}-startDate`}
            name="startDate"
            defaultValue={dates.startDate}
            required
            onValueChange={(value) => editDate("startDate", value)}
            aria-invalid={startError ? true : undefined}
          />
        </Field>
        <Field id={`${idPrefix}-endDate`} label={t("endDate")} error={endError}>
          <DatePicker
            key={`end-${fillCount}`}
            id={`${idPrefix}-endDate`}
            name="endDate"
            defaultValue={dates.endDate}
            required
            onValueChange={(value) => editDate("endDate", value)}
            aria-invalid={endError ? true : undefined}
          />
        </Field>
      </div>
      <p className="text-xs text-text-muted">{t("hint")}</p>
    </div>
  );
}
