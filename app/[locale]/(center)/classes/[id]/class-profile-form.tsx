"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  deleteClassAction,
  updateClassAction,
} from "@/app/[locale]/(center)/classes/actions";
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

/**
 * Edit a class's own fields — money config, room set and the enrollment
 * flags. Changing the teacher or the room set re-checks every weekly slot
 * the class already has (R3): the clashes show in `SlotConflictNotice` as
 * you edit, and saving needs the confirmation under WARN.
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
  noneLabel,
  canDelete,
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
  noneLabel: string;
  canDelete: boolean;
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Only once the teacher or room set actually changes is there anything new
  // to check — the stored combination was checked when it was saved.
  const [slotInputs, setSlotInputs] = useState<ClassSlotInputs | null>(null);
  const slotConflicts = useSlotConflicts(
    slotInputs ? { kind: "class", locale, classGroupId, ...slotInputs } : null,
    state.error ? state : undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={classGroupId} />

      {state.error && !state.conflicts ? (
        <FormMessage>{tErrors(state.error)}</FormMessage>
      ) : null}
      {deleteState.error ? (
        <FormMessage>{tErrors(deleteState.error)}</FormMessage>
      ) : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{tCommon("saved")}</FormMessage>
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
