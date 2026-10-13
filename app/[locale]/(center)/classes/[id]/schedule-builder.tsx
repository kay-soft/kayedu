"use client";

import { useActionState, useState } from "react";
import { CalendarClock, Plus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createScheduleAction,
  removeScheduleAction,
  updateScheduleAction,
} from "@/app/[locale]/(center)/classes/actions";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { SessionSyncNotice } from "@/components/center/session-sync-notice";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { isValidTimeRange } from "@/lib/scheduling";
import { IDLE_CLASS_STATE, type ClassActionState } from "@/lib/validation/classes";
import { EmptyState } from "@/components/shared/empty-state";

export type ScheduleSlotRow = {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

const DAY_VALUES = [0, 1, 2, 3, 4, 5, 6] as const;

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

/**
 * A slot being edited, and the live conflict state for it (R3) — since R4,
 * every session the slot would create across the class's whole period.
 */
function useSlotDraft(
  classGroupId: string,
  initial: { dayOfWeek: string; startTime: string; endTime: string },
  state: ClassActionState,
  scheduleId?: string,
) {
  const locale = useLocale();
  const [draft, setDraft] = useState(initial);
  const edited =
    draft.dayOfWeek !== initial.dayOfWeek ||
    draft.startTime !== initial.startTime ||
    draft.endTime !== initial.endTime;
  const checkable = edited && isValidTimeRange(draft.startTime, draft.endTime);
  const conflicts = useSlotConflicts(
    checkable
      ? {
          kind: "schedule",
          locale,
          classGroupId,
          ...(scheduleId ? { scheduleId } : {}),
          dayOfWeek: Number(draft.dayOfWeek),
          startTime: draft.startTime,
          endTime: draft.endTime,
        }
      : null,
    state.error ? state : undefined,
  );
  return { draft, setDraft, conflicts };
}

/**
 * The Schedule Builder (docs/04-design-system.md §9): one row per weekly
 * slot, day/start/end editable in place, and `SlotConflictNotice` directly
 * beneath a row that double-books the teacher or any room of this class's
 * room set (R3) — never a modal or toast. The clash is previewed live as the
 * slot is edited; under WARN saving needs "I understand, create anyway",
 * under DENY it is refused. `+ Add time slot` appends a new row below the
 * last.
 *
 * R4: every add, move or removal resyncs the class's upcoming sessions for
 * its whole period, so the conflict list covers the whole range, and the
 * notice after a save says what happened to the sessions.
 *
 * The reference mockup shows a per-slot room picker; this build keeps the
 * room set per class (`ClassGroup.roomId` + extra rooms,
 * docs/01-data-model.md §2) rather than adding a room to `ClassSchedule` —
 * the class's rooms are shown in the header panel above instead (docs/04 §9,
 * revised).
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
  const { draft, setDraft, conflicts } = useSlotDraft(
    classGroupId,
    {
      dayOfWeek: String(slot.dayOfWeek),
      startTime: slot.startTime,
      endTime: slot.endTime,
    },
    state,
    slot.id,
  );

  return (
    <li className="rounded-xl border border-border p-3">
      <form action={updateAction} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="id" value={slot.id} />
        <input type="hidden" name="classGroupId" value={classGroupId} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">
              {t("day")}
            </label>
            <Select
              name="dayOfWeek"
              value={draft.dayOfWeek}
              onValueChange={(dayOfWeek) => setDraft({ ...draft, dayOfWeek })}
            >
              {DAY_VALUES.map((day) => (
                <option key={day} value={day}>
                  {tDays.raw("dayNames")[day] as string}
                </option>
              ))}
            </Select>
          </div>

          <TimeRangeFields
            idPrefix={`slot-${slot.id}`}
            startLabel={t("start")}
            endLabel={t("end")}
            start={draft.startTime}
            end={draft.endTime}
            onChange={({ start, end }) => setDraft({ ...draft, startTime: start, endTime: end })}
            required
            className="min-w-0 flex-[2]"
          />

          <div className="flex shrink-0 gap-2">
            <SubmitButton variant="outline" disabled={conflicts.blocked}>
              {t("save")}
            </SubmitButton>
          </div>
        </div>

        <SlotConflictNotice
          idPrefix={`slot-${slot.id}`}
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
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
            className="size-11 p-0 text-text-muted hover:text-danger"
            aria-label={t("remove")}
          >
            <X className="size-4" />
          </Button>
        </form>
      </div>

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
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
      {state.status === "saved" && state.conflicts && state.conflicts.length > 0 ? (
        <div className="mt-2">
          <FormMessage tone="warning">
            {t("savedWithConflict", { count: state.conflicts.length })}
          </FormMessage>
        </div>
      ) : null}
      {state.status === "saved" && state.sessions ? (
        <div className="mt-2">
          <SessionSyncNotice sessions={state.sessions} />
        </div>
      ) : null}
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
  const { draft, setDraft, conflicts } = useSlotDraft(
    classGroupId,
    { dayOfWeek: "0", startTime: "", endTime: "" },
    state,
  );

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
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="classGroupId" value={classGroupId} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">
              {t("day")}
            </label>
            <Select
              name="dayOfWeek"
              value={draft.dayOfWeek}
              onValueChange={(dayOfWeek) => setDraft({ ...draft, dayOfWeek })}
            >
              {DAY_VALUES.map((day) => (
                <option key={day} value={day}>
                  {tDays.raw("dayNames")[day] as string}
                </option>
              ))}
            </Select>
          </div>

          <TimeRangeFields
            idPrefix={`slot-new-${classGroupId}`}
            startLabel={t("start")}
            endLabel={t("end")}
            start={draft.startTime}
            end={draft.endTime}
            onChange={({ start, end }) => setDraft({ ...draft, startTime: start, endTime: end })}
            required
            className="min-w-0 flex-[2]"
          />

          <div className="flex shrink-0 gap-2">
            <SubmitButton disabled={conflicts.blocked}>{t("addSlot")}</SubmitButton>
            <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>

        <SlotConflictNotice
          idPrefix={`slot-new-${classGroupId}`}
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </form>

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
        <div className="mt-2">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}
      {state.fieldErrors ? (
        <div className="mt-2">
          <FormMessage>{tErrors(Object.values(state.fieldErrors)[0])}</FormMessage>
        </div>
      ) : null}
      {state.status === "created" && state.conflicts && state.conflicts.length > 0 ? (
        <div className="mt-2">
          <FormMessage tone="warning">
            {t("savedWithConflict", { count: state.conflicts.length })}
          </FormMessage>
        </div>
      ) : null}
      {state.status === "created" && state.sessions ? (
        <div className="mt-2">
          <SessionSyncNotice sessions={state.sessions} />
        </div>
      ) : null}
    </div>
  );
}
