"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, CalendarClock, Plus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createScheduleAction,
  removeScheduleAction,
  updateScheduleAction,
} from "@/app/[locale]/(center)/classes/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { IDLE_CLASS_STATE, type ClassActionState } from "@/lib/validation/classes";
import { EmptyState } from "@/components/shared/empty-state";

export type ScheduleSlotRow = {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

const DAY_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;

function ConflictBanner({ state }: { state: ClassActionState }) {
  const t = useTranslations("Classes.schedule");
  if (!state.conflicts || state.conflicts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning-bg p-3 text-sm text-warning">
      {state.conflicts.map((conflict, index) => (
        <p key={index} className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {t(conflict.type === "room" ? "roomConflictWith" : "teacherConflictWith", {
              className: conflict.className,
            })}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * The Schedule Builder (docs/04-design-system.md §9): one row per weekly
 * slot, day/start/end editable in place, a conflict banner directly beneath
 * a row that double-books a teacher or (this class's single, fixed) room —
 * never a modal or toast. `+ Add time slot` appends a new row below the last.
 *
 * The reference mockup shows a per-slot room picker; this build keeps one
 * room per class (`ClassGroup.roomId`, docs/01-data-model.md §2) rather than
 * adding a room to `ClassSchedule` — the class's room is shown in the header
 * panel above instead (docs/04 §9, revised).
 */
export function ScheduleBuilder({
  classGroupId,
  slots,
}: {
  classGroupId: string;
  slots: ScheduleSlotRow[];
}) {
  const t = useTranslations("Classes.schedule");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs font-medium text-text-muted">
        <span>{t("slotsHeading")}</span>
        <span>{t("slotCount", { count: slots.length })}</span>
      </div>

      {slots.length === 0 ? (
        <EmptyState compact icon={<CalendarClock />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ul className="flex flex-col gap-3">
          {slots.map((slot) => (
            <ScheduleRow key={slot.id} classGroupId={classGroupId} slot={slot} />
          ))}
        </ul>
      )}

      <AddSlotForm classGroupId={classGroupId} />
    </div>
  );
}

function ScheduleRow({
  classGroupId,
  slot,
}: {
  classGroupId: string;
  slot: ScheduleSlotRow;
}) {
  const t = useTranslations("Classes.schedule");
  const tDays = useTranslations("Classes");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [state, updateAction] = useActionState(updateScheduleAction, IDLE_CLASS_STATE);
  const [removeState, removeAction] = useActionState(
    removeScheduleAction,
    IDLE_CLASS_STATE,
  );

  return (
    <li className="rounded-xl border border-border p-3">
      <form
        action={updateAction}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="id" value={slot.id} />
        <input type="hidden" name="classGroupId" value={classGroupId} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("day")}
          </label>
          <Select name="dayOfWeek" defaultValue={String(slot.dayOfWeek)}>
            {DAY_VALUES.map((day) => (
              <option key={day} value={day}>
                {tDays.raw("dayNames")[day] as string}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("start")}
          </label>
          <Input
            name="startTime"
            type="time"
            dir="ltr"
            defaultValue={slot.startTime}
            required
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("end")}
          </label>
          <Input
            name="endTime"
            type="time"
            dir="ltr"
            defaultValue={slot.endTime}
            required
          />
        </div>

        <div className="flex shrink-0 gap-2">
          <SubmitButton variant="outline">{t("save")}</SubmitButton>
        </div>
      </form>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-text-muted">
          {t("summary", { day: tDays.raw("dayNames")[slot.dayOfWeek] as string })}
        </span>
        <form action={removeAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={slot.id} />
          <Button
            type="submit"
            variant="ghost"
            className="size-9 p-0 text-text-muted hover:text-danger"
            aria-label={t("remove")}
          >
            <X className="size-4" />
          </Button>
        </form>
      </div>

      {state.error && state.error !== "scheduleConflict" ? (
        <div className="mt-2">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
      {state.fieldErrors ? (
        <div className="mt-2">
          <FormMessage>{tErrors(Object.values(state.fieldErrors)[0])}</FormMessage>
        </div>
      ) : null}
      {removeState.error ? (
        <div className="mt-2">
          <FormMessage>{tErrors(removeState.error)}</FormMessage>
        </div>
      ) : null}
      <div className="mt-2">
        <ConflictBanner state={state} />
      </div>
    </li>
  );
}

function AddSlotForm({ classGroupId }: { classGroupId: string }) {
  const t = useTranslations("Classes.schedule");
  const tDays = useTranslations("Classes");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(createScheduleAction, IDLE_CLASS_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full justify-start text-brand hover:text-brand"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        {t("addSlot")}
      </Button>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-border p-3">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="classGroupId" value={classGroupId} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("day")}
          </label>
          <Select name="dayOfWeek" defaultValue="0">
            {DAY_VALUES.map((day) => (
              <option key={day} value={day}>
                {tDays.raw("dayNames")[day] as string}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("start")}
          </label>
          <Input name="startTime" type="time" dir="ltr" required />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">
            {t("end")}
          </label>
          <Input name="endTime" type="time" dir="ltr" required />
        </div>

        <div className="flex shrink-0 gap-2">
          <SubmitButton>{t("addSlot")}</SubmitButton>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
        </div>
      </form>

      {state.error && state.error !== "scheduleConflict" ? (
        <div className="mt-2">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
      {state.fieldErrors ? (
        <div className="mt-2">
          <FormMessage>{tErrors(Object.values(state.fieldErrors)[0])}</FormMessage>
        </div>
      ) : null}
      <div className="mt-2">
        <ConflictBanner state={state} />
      </div>
    </div>
  );
}
