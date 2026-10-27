"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
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
  type ClassPlacementInputs,
  type SelectOption,
} from "@/components/center/class-fields";
import type { RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { TeacherPicker, type TeacherOption } from "@/components/center/teacher-picker";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import type { RoomLinkPair } from "@/lib/rooms";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

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
  "bookings",
] as const;

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

type EditClassProps = {
  classGroupId: string;
  values: ClassFieldsValues;
  teachers: TeacherOption[];
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
};

/**
 * "Edit class" on the class page (R6, docs/04 §11.15) — the class's own
 * fields in the shared `DialogShell` with the same sectioned `ClassFields` as
 * the New class dialog (no schedule card: an existing class's weekly slots
 * keep their own editor on its page, each one resyncing the period). The
 * teacher is the shared searchable picker.
 *
 * Changing the teacher, the room set or the period resyncs the class's
 * upcoming sessions on save (R4): the clashes across the whole period show in
 * `SlotConflictNotice` as you edit, saving needs one confirmation under WARN,
 * and the notice after a save says what happened to the sessions — including
 * any kept because they already carry records or custom changes.
 *
 * Delete is allowed only for a class that never ran; otherwise the refusal
 * names what stops it and offers Deactivate instead.
 */
export function EditClassDialog(props: EditClassProps) {
  const t = useTranslations("Classes");
  return (
    <DialogLauncher
      button={(openDialog) => (
        <ActionBarButton onClick={openDialog}>
          <Pencil className="size-4" aria-hidden />
          {t("edit")}
        </ActionBarButton>
      )}
      render={(dialog) => <EditClassDialogContent {...dialog} {...props} />}
    />
  );
}

function EditClassDialogContent({
  open,
  onOpenChange,
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
}: EditClassProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Classes");
  const tCommon = useTranslations("Settings.common");
  const tErrors = useTranslations("Classes.errors");
  const tBlockers = useTranslations("Classes.deleteBlockers");
  const locale = useLocale();

  const [state, formAction, pending] = useGuardedActionState(updateClassAction, IDLE_CLASS_STATE);
  const [deleteState, deleteFormAction] = useGuardedActionState(deleteClassAction, IDLE_CLASS_STATE);
  const [deactivateState, deactivateFormAction] = useGuardedActionState(
    setClassActiveAction,
    IDLE_CLASS_STATE,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Only once the teacher, room set or period actually changes is there
  // anything new to check — the stored class was checked when it was saved.
  const [teacherId, setTeacherId] = useState(values.teacherId);
  const [placement, setPlacement] = useState<ClassPlacementInputs | null>(null);
  const changed = placement !== null || teacherId !== values.teacherId;
  const current: ClassPlacementInputs = placement ?? {
    roomId: values.roomId || null,
    extraRoomIds: values.extraRoomIds,
    startDate: values.startDate,
    endDate: values.endDate,
  };
  const slotConflicts = useSlotConflicts(
    changed && teacherId
      ? {
          kind: "class",
          locale,
          classGroupId,
          teacherId,
          roomId: current.roomId,
          extraRoomIds: current.extraRoomIds,
          // A half-picked period previews against the stored dates.
          startDate: current.startDate || undefined,
          endDate: current.endDate || undefined,
        }
      : null,
    state.error ? state : undefined,
  );

  const fieldError = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("editTitle")}
      description={t("editDescription")}
      formProps={{ action: formAction, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={tCommon("save")}
      submitPending={pending}
      submitDisabled={slotConflicts.blocked}
      footerExtra={
        canDelete ? (
          confirmingDelete ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="text-xs text-text-secondary">{t("deleteConfirm")}</span>
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
              className="h-11 w-full gap-2 px-4 sm:w-auto"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="size-4" aria-hidden />
              {tCommon("delete")}
            </Button>
          )
        ) : undefined
      }
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={classGroupId} />

      <div className="flex flex-col gap-4">
        {state.error && !CONFLICT_ERRORS.has(state.error) ? (
          <FormMessage>{tErrors(state.error)}</FormMessage>
        ) : null}
        {deleteState.error === "classInUse" && deleteState.blockers ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger-fg"
            role="alert"
          >
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
          subjects={subjects}
          grades={grades}
          educationSystems={educationSystems}
          educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
          rooms={rooms}
          roomLinks={roomLinks}
          terms={terms}
          noneLabel={noneLabel}
          fieldErrors={state.fieldErrors}
          onPlacementChange={setPlacement}
          // The clash the edit would cause sits with the fields it concerns.
          placementNotice={
            <SlotConflictNotice
              idPrefix={`class-${classGroupId}`}
              conflicts={slotConflicts.conflicts}
              policy={slotConflicts.policy}
              confirmed={slotConflicts.confirmed}
              onConfirmedChange={slotConflicts.setConfirmed}
            />
          }
          teacherSection={
            <Field
              id={`class-${classGroupId}-teacherId`}
              label={t("fields.teacher")}
              error={fieldError("teacherId")}
            >
              <TeacherPicker
                id={`class-${classGroupId}-teacherId`}
                teachers={teachers}
                value={teacherId}
                onValueChange={setTeacherId}
                required
                invalid={Boolean(state.fieldErrors?.teacherId)}
              />
            </Field>
          }
        />

      </div>
    </DialogShell>
  );
}
