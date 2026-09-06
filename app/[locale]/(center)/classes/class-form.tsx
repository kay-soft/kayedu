"use client";

import { useActionState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { createClassAction } from "@/app/[locale]/(center)/classes/actions";
import {
  ClassFields,
  type SelectOption,
} from "@/components/center/class-fields";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { piastresToInputValue } from "@/lib/money";
import { IDLE_CLASS_STATE } from "@/lib/validation/classes";

export type ClassFormDefaults = {
  centerShareType: ShareType;
  centerShareValue: number;
  lateThresholdMinutes: number;
};

/**
 * Create a class (spec §4.1 item 3). Rendered inside the "Add class" dialog —
 * defaults come from the center's own general settings (docs/04 §5
 * "Dialog"), so a class starts from this center's usual cut and late
 * threshold rather than blank inputs.
 */
export function ClassForm({
  teachers,
  subjects,
  grades,
  educationSystems,
  rooms,
  noneLabel,
  defaults,
  onCreated,
}: {
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  rooms: SelectOption[];
  noneLabel: string;
  defaults: ClassFormDefaults;
  onCreated: () => void;
}) {
  const t = useTranslations("Classes");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(createClassAction, IDLE_CLASS_STATE);

  useEffect(() => {
    if (state.status === "created") onCreated();
  }, [state.status, onCreated]);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <ClassFields
        idPrefix="class-create"
        values={{
          teacherId: "",
          subjectId: "",
          gradeId: "",
          educationSystemId: "",
          roomId: "",
          price: "0.00",
          centerShareType: defaults.centerShareType,
          centerShareValue:
            defaults.centerShareType === "FIXED"
              ? piastresToInputValue(defaults.centerShareValue)
              : String(defaults.centerShareValue),
          capacity: "0",
          attendanceRequired: true,
          lateThresholdMinutes: String(defaults.lateThresholdMinutes),
          acceptsNewStudents: true,
          requiresConfirmation: false,
          allowExcused: true,
        }}
        teachers={teachers}
        subjects={subjects}
        grades={grades}
        educationSystems={educationSystems}
        rooms={rooms}
        noneLabel={noneLabel}
        fieldErrors={state.fieldErrors}
      />

      <SubmitButton className="w-full sm:w-auto">{t("add")}</SubmitButton>
    </form>
  );
}
