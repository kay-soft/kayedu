"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteClassAction,
  setClassActiveAction,
  updateClassAction,
} from "@/app/[locale]/(center)/classes/actions";
import type { TermOption } from "@/components/center/class-period-fields";
import { SessionSyncNotice } from "@/components/center/session-sync-notice";
import {
  ClassFields,
  type ClassFieldsValues,
  type ClassSlotInputs,
  type SelectOption,
} from "@/components/center/class-fields";
import type { RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import type { RoomLinkPair } from "@/lib/rooms";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

/** The delete blockers, in the order the refusal lists them (R4). */
const BLOCKER_KEYS = [
  "started",
  "attendees",
  "payments",
  "settlements",
  "ratings",
  "rescheduled",
  "enrollments",
  "reservations",
] as const;

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

/**
 * Edit a class's own fields — money config, room set, period and the
 * enrollment flags. Changing the teacher, the room set or the period
 * resyncs the class's upcoming sessions on save (R4): the clashes across
 * the whole period show in `SlotConflictNotice` as you edit, saving needs
 * one confirmation under WARN, and the notice after a save says what
 * happened to the sessions — including any kept because they already carry
 * records or custom changes.
 *
 * Delete is allowed only for a class that never ran; otherwise the refusal
 * names what stops it and offers Deactivate instead.
 */
export function ClassProfileForm({
  classGroupId,
  values,
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  terms,
  noneLabel,
  canDelete,
  active,
}: {
  classGroupId: string;
  values: ClassFieldsValues;
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  terms: TermOption[];
  noneLabel: string;
  canDelete: boolean;
  active: boolean;
}) {
  const t = useTranslations("Classes");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(updateClassAction, IDLE_CLASS_STATE);
  const [deleteState, deleteFormAction] = useActionState(
    deleteClassAction,
    IDLE_CLASS_STATE,
  );
  const [deactivateState, deactivateFormAction] = useActionState(
    setClassActiveAction,
    IDLE_CLASS_STATE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const tBlockers = useTranslations("Classes.deleteBlockers");
  // Only once the teacher, room set or period actually changes is there
  // anything new to check — the stored class was checked when it was saved.
  const [slotInputs, setSlotInputs] = useState<ClassSlotInputs | null>(null);
  const slotConflicts = useSlotConflicts(
    slotInputs
      ? {
          kind: "class",
          locale,
          classGroupId,
          ...slotInputs,
          // A half-picked period previews against the stored dates.
          startDate: slotInputs.startDate || undefined,
          endDate: slotInputs.endDate || undefined,
        }
      : null,
    state.error ? state : undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={classGroupId} />

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
        <FormMessage>{tErrors(state.error)}</FormMessage>
      ) : null}
      {deleteState.error === "classInUse" && deleteState.blockers ? (
        <div className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger" role="alert">
          <p className="font-medium">{tBlockers("title")}</p>
          <ul className="flex flex-col gap-1 ps-5">
            {BLOCKER_KEYS.filter((key) => (deleteState.blockers?.[key] ?? 0) > 0).map((key) => (
              <li key={key} className="list-disc">
                {tBlockers(key, { count: deleteState.blockers?.[key] ?? 0 })}
              </li>
            ))}
          </ul>
          {active ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="text-text-secondary">{tBlockers("deactivateHint")}</span>
              <Button
                type="submit"
                variant="outline"
                formAction={deactivateFormAction}
                formNoValidate
                className="h-11 w-full px-4 sm:ms-auto sm:w-auto"
              >
                {tCommon("deactivate")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : deleteState.error ? (
        <FormMessage>{tErrors(deleteState.error)}</FormMessage>
      ) : null}
      {deactivateState.status === "saved" ? (
        <SessionSyncNotice sessions={deactivateState.sessions} />
      ) : null}
      {state.status === "saved" ? (
        state.sessions ? (
          <SessionSyncNotice sessions={state.sessions} />
        ) : (
          <FormMessage tone="success">{tCommon("saved")}</FormMessage>
        )
      ) : null}

      <ClassFields
        idPrefix={`class-${classGroupId}`}
        values={values}
        teachers={teachers}
        subjects={subjects}
        grades={grades}
        educationSystems={educationSystems}
        educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
        rooms={rooms}
        roomLinks={roomLinks}
        terms={terms}
        noneLabel={noneLabel}
        fieldErrors={state.fieldErrors}
        onSlotInputsChange={setSlotInputs}
      />

      <SlotConflictNotice
        idPrefix={`class-${classGroupId}`}
        conflicts={slotConflicts.conflicts}
        policy={slotConflicts.policy}
        confirmed={slotConflicts.confirmed}
        onConfirmedChange={slotConflicts.setConfirmed}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SubmitButton className="w-full sm:w-auto" disabled={slotConflicts.blocked}>
          {tCommon("save")}
        </SubmitButton>

        {canDelete ? (
          <div className="sm:ms-auto">
            {confirmingDelete ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="text-xs text-text-secondary">
                  {t("deleteConfirm")}
                </span>
                <Button
                  type="submit"
                  variant="destructive"
                  formAction={deleteFormAction}
                  formNoValidate
                  className="h-11 w-full px-4 sm:w-auto"
                >
                  {tCommon("deleteYes")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full px-4 sm:w-auto"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                className="h-11 w-full px-4 sm:w-auto"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 className="size-4" />
                {tCommon("delete")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </form>
  );
}
