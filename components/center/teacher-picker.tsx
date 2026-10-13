"use client";

import { useTranslations } from "next-intl";

import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

/** A centre's teacher, as the pickers list them: the `User` id, the local name, the local phone. */
export type TeacherOption = { value: string; label: string; phone: string | null };

/**
 * The teacher picker for every class and session dialog (R6): the shared
 * searchable `Combobox`, listing the centre's active teachers — the list the
 * server page already scoped by `centerId` — and matching a typed name or
 * phone in any format. Posts the teacher's user id as `teacherId`.
 */
export function TeacherPicker({
  id,
  name = "teacherId",
  teachers,
  value,
  defaultValue,
  onValueChange,
  required,
  invalid,
}: {
  id: string;
  name?: string;
  teachers: TeacherOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (teacherId: string) => void;
  required?: boolean;
  invalid?: boolean;
}) {
  const t = useTranslations("Pickers.teacher");
  const options: ComboboxOption[] = teachers.map((teacher) => ({
    value: teacher.value,
    label: teacher.label,
    phone: teacher.phone,
  }));

  return (
    <Combobox
      id={id}
      name={name}
      options={options}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      placeholder={t("placeholder")}
      emptyLabel={t("empty")}
      clearLabel={t("clear")}
      openLabel={t("open")}
      required={required}
      aria-invalid={invalid ? true : undefined}
    />
  );
}
