"use client";

import { CalendarOff, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createHolidayAction,
  removeHolidayAction,
} from "@/app/[locale]/(center)/classes/actions";
import { SessionSyncNotice } from "@/components/center/session-sync-notice";
import { FormMessage } from "@/components/shared/form-message";
import { Field } from "@/components/shared/field";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { formatDay } from "@/lib/format";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";
import { EmptyState } from "@/components/shared/empty-state";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export type HolidayRow = { id: string; date: string; name: string | null };

/**
 * The center's holiday calendar (docs/02-architecture.md §11): a date here is
 * skipped whenever a class's sessions are created, whichever class's
 * schedule would otherwise have landed on it. R4: classes already have
 * sessions for their whole period, so adding a holiday also removes that
 * day's untouched sessions; ones with records or custom changes are kept,
 * and the notice says how many (staff cancel those by hand). Removing a
 * holiday does not bring sessions back (OD-10).
 */
export function HolidayCalendar({ holidays }: { holidays: HolidayRow[] }) {
  const t = useTranslations("Classes.holidays");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [createState, createAction] = useGuardedActionState(
    createHolidayAction,
    IDLE_CLASS_STATE,
  );
  const [removeState, removeAction] = useGuardedActionState(
    removeHolidayAction,
    IDLE_CLASS_STATE,
  );

  return (
    <div className="flex flex-col gap-4">
      {createState.error ? (
        <FormMessage>{tErrors(createState.error)}</FormMessage>
      ) : null}
      {createState.status === "created" && createState.sessions ? (
        <SessionSyncNotice sessions={createState.sessions} />
      ) : null}
      {removeState.error ? (
        <FormMessage>{tErrors(removeState.error)}</FormMessage>
      ) : null}

      {holidays.length === 0 ? (
        <EmptyState compact icon={<CalendarOff />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {holidays.map((holiday) => (
            <li
              key={holiday.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">
                  {formatDay(new Date(holiday.date), locale)}
                </p>
                {holiday.name ? (
                  <p className="truncate text-xs text-text-muted">{holiday.name}</p>
                ) : null}
              </div>
              <form action={removeAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="id" value={holiday.id} />
                <Button
                  type="submit"
                  variant="ghost"
                  className="size-11 shrink-0 p-0"
                  aria-label={t("remove")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form
        action={createAction}
        className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end"
        noValidate
      >
        <input type="hidden" name="locale" value={locale} />

        <Field
          id="holiday-date"
          label={t("date")}
          className="sm:w-48"
          error={
            createState.fieldErrors?.date
              ? tErrors(createState.fieldErrors.date)
              : undefined
          }
        >
          <DatePicker id="holiday-date" name="date" required />
        </Field>

        <Field id="holiday-name" label={t("name")} optional className="flex-1">
          <Input id="holiday-name" name="name" maxLength={120} placeholder={t("namePlaceholder")} />
        </Field>

        <SubmitButton className="sm:w-auto">{t("add")}</SubmitButton>
      </form>
    </div>
  );
}
