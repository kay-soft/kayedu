"use client";

import { useActionState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { createClassAction } from "@/app/[locale]/(center)/classes/actions";
import {
  ClassFields,
  type SelectOption,
} from "@/components/center/class-fields";
import type { TermOption } from "@/components/center/class-period-fields";
import type { RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { piastresToInputValue } from "@/lib/money";
import type { RoomLinkPair } from "@/lib/rooms";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

export type ClassFormDefaults = {
  centerShareType: ShareType;
  centerShareValue: number;
  lateThresholdMinutes: number;
};

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

/**
 * Create a class (spec §4.1 item 3). Rendered inside the "Add class" dialog —
 * defaults come from the center's own general settings (docs/04 §5
 * "Dialog"), so a class starts from this center's usual cut and late
 * threshold rather than blank inputs.
 *
 * R4: the class needs a period (a term preset or custom dates); creating it
 * creates every session of that period in the same transaction. Should the
 * server refuse over a double-booking anywhere in the range, the full list
 * shows in `SlotConflictNotice` with one "I understand" covering it all.
 */
export function ClassForm({
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  terms,
  noneLabel,
  defaults,
  onCreated,
}: {
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  terms: TermOption[];
  noneLabel: string;
  defaults: ClassFormDefaults;
  onCreated: () => void;
}) {
  const t = useTranslations("Classes");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(createClassAction, IDLE_CLASS_STATE);
  // A new class has nothing to preview yet; a refusal's list is what shows.
  const slotConflicts = useSlotConflicts(null, state.error ? state : undefined);

  useEffect(() => {
    if (state.status === "created") onCreated();
  }, [state.status, onCreated]);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
        <FormMessage>{tErrors(state.error)}</FormMessage>
      ) : null}

      <ClassFields
        idPrefix="class-create"
        values={{
          teacherId: "",
          subjectId: "",
          gradeId: "",
          educationSystemId: "",
          roomId: "",
          extraRoomIds: [],
          price: "0.00",
          centerShareType: defaults.centerShareType,
          centerShareValue:
            defaults.centerShareType === "FIXED"
              ? piastresToInputValue(defaults.centerShareValue)
              : String(defaults.centerShareValue),
          lateThresholdMinutes: String(defaults.lateThresholdMinutes),
          acceptsNewStudents: true,
          requiresConfirmation: false,
          startDate: "",
          endDate: "",
        }}
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
      />

      <SlotConflictNotice
        idPrefix="class-create"
        conflicts={slotConflicts.conflicts}
        policy={slotConflicts.policy}
        confirmed={slotConflicts.confirmed}
        onConfirmedChange={slotConflicts.setConfirmed}
      />

      <SubmitButton className="w-full sm:w-auto" disabled={slotConflicts.blocked}>
        {t("add")}
      </SubmitButton>
    </form>
  );
}
