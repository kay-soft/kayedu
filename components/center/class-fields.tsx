"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { RoomSetPicker, type RoomOption } from "@/components/center/room-set-picker";
import { Field } from "@/components/shared/field";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/format";
import { MAX_LATE_THRESHOLD_MINUTES } from "@/lib/validation/classes";
import { piastresToInputValue, splitShare } from "@/lib/money";
import type { RoomLinkPair } from "@/lib/rooms";

export type SelectOption = { value: string; label: string };

export type ClassFieldsValues = {
  teacherId: string;
  subjectId: string;
  gradeId: string;
  educationSystemId: string;
  roomId: string;
  /** R3 — rooms combined with the primary `roomId`. */
  extraRoomIds: string[];
  price: string;
  centerShareType: ShareType;
  centerShareValue: string;
  lateThresholdMinutes: string;
  acceptsNewStudents: boolean;
  requiresConfirmation: boolean;
};

/** The fields a class's weekly slots are checked against (R3 live preview). */
export type ClassSlotInputs = {
  teacherId: string;
  roomId: string | null;
  extraRoomIds: string[];
};

/**
 * Every field a `ClassGroup` carries (docs/01-data-model.md §2): who teaches
 * it, what/whom it's for, its room set (R3 — a required primary room plus
 * any rooms combined with it; the set's summed capacity is the class's seat
 * limit, there is no separate class capacity), its price and center-cut and
 * the attendance/enrollment flags. Shared between the create form (the "Add
 * class" dialog) and the edit form on the class detail page, exactly like
 * `student-fields.tsx` is shared between `StudentForm` and
 * `StudentProfileForm`.
 */
export function ClassFields({
  idPrefix,
  values,
  teachers,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  noneLabel,
  fieldErrors,
  onSlotInputsChange,
}: {
  idPrefix: string;
  values: ClassFieldsValues;
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  /**
   * Piastres, keyed by catalog education-system id — each system's
   * `defaultFixedCenterShare` (M13, spec §5.1 "Center cut"). A class set to
   * FIXED inherits this as the field's starting value; typing into the
   * field at all counts as an override from then on, so this never fights
   * the person filling in the form.
   */
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  noneLabel: string;
  fieldErrors?: Record<string, string>;
  /** Teacher or room set changed — the edit form re-previews slot conflicts. */
  onSlotInputsChange?: (next: ClassSlotInputs) => void;
}) {
  const t = useTranslations("Classes.fields");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [shareType, setShareType] = useState<ShareType>(values.centerShareType);
  const [shareValue, setShareValue] = useState(values.centerShareValue);
  const [priceInput, setPriceInput] = useState(values.price);
  const [educationSystemId, setEducationSystemId] = useState(values.educationSystemId);
  const slotInputs = useRef<ClassSlotInputs>({
    teacherId: values.teacherId,
    roomId: values.roomId || null,
    extraRoomIds: values.extraRoomIds,
  });
  function changeSlotInputs(patch: Partial<ClassSlotInputs>) {
    slotInputs.current = { ...slotInputs.current, ...patch };
    onSlotInputsChange?.(slotInputs.current);
  }
  // Once the person types into shareValue themselves, the FIXED-default
  // auto-fill below stops touching it — an explicit edit always wins.
  const shareValueTouched = useRef(false);

  function applyInheritedFixedShare(nextEducationSystemId: string, nextShareType: ShareType) {
    if (shareValueTouched.current || nextShareType !== "FIXED") return;
    const defaultPiastres = educationSystemDefaultFixedShare[nextEducationSystemId];
    if (defaultPiastres === undefined) return;
    setShareValue(piastresToInputValue(defaultPiastres));
  }

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  const priceEgp = Number(priceInput);
  const sharePreviewable =
    Number.isFinite(priceEgp) &&
    priceEgp >= 0 &&
    shareValue.trim() !== "" &&
    Number.isFinite(Number(shareValue));
  const preview = sharePreviewable
    ? splitShare(
        Math.round(priceEgp * 100),
        shareType,
        shareType === "FIXED"
          ? Math.round(Number(shareValue) * 100)
          : Math.round(Number(shareValue)),
      )
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${idPrefix}-teacherId`}
          label={t("teacher")}
          error={error("teacherId")}
        >
          <Select
            id={`${idPrefix}-teacherId`}
            name="teacherId"
            defaultValue={values.teacherId}
            onValueChange={(teacherId) => changeSlotInputs({ teacherId })}
            required
            aria-invalid={fieldErrors?.teacherId ? true : undefined}
          >
            <option value="" disabled>
              {t("teacherPlaceholder")}
            </option>
            {teachers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id={`${idPrefix}-subjectId`}
          label={t("subject")}
          optional
          error={error("subjectId")}
        >
          <Select
            id={`${idPrefix}-subjectId`}
            name="subjectId"
            defaultValue={values.subjectId}
          >
            <option value="">{noneLabel}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id={`${idPrefix}-gradeId`}
          label={t("grade")}
          optional
          error={error("gradeId")}
        >
          <Select
            id={`${idPrefix}-gradeId`}
            name="gradeId"
            defaultValue={values.gradeId}
          >
            <option value="">{noneLabel}</option>
            {grades.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id={`${idPrefix}-educationSystemId`}
          label={t("educationSystem")}
          optional
          error={error("educationSystemId")}
        >
          <Select
            id={`${idPrefix}-educationSystemId`}
            name="educationSystemId"
            value={educationSystemId}
            onValueChange={(next) => {
              setEducationSystemId(next);
              applyInheritedFixedShare(next, shareType);
            }}
          >
            <option value="">{noneLabel}</option>
            {educationSystems.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="sm:col-span-2">
          <RoomSetPicker
            idPrefix={idPrefix}
            rooms={rooms}
            links={roomLinks}
            defaultRoomId={values.roomId}
            defaultExtraIds={values.extraRoomIds}
            required
            noneLabel={noneLabel}
            roomError={error("roomId")}
            extraError={error("extraRoomIds")}
            onChange={(next) => changeSlotInputs(next)}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border p-3 sm:p-4">
        <p className="mb-3 text-sm font-medium text-text-primary">
          {t("moneyTitle")}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id={`${idPrefix}-price`} label={t("price")} error={error("price")}>
            <Input
              id={`${idPrefix}-price`}
              name="price"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              aria-invalid={fieldErrors?.price ? true : undefined}
            />
          </Field>

          <Field id={`${idPrefix}-centerShareType`} label={t("shareType")}>
            <Select
              id={`${idPrefix}-centerShareType`}
              name="centerShareType"
              value={shareType}
              onValueChange={(next) => {
                const nextShareType = next as ShareType;
                setShareType(nextShareType);
                applyInheritedFixedShare(educationSystemId, nextShareType);
              }}
            >
              <option value="PERCENTAGE">{t("percentage")}</option>
              <option value="FIXED">{t("fixed")}</option>
            </Select>
          </Field>

          <Field
            id={`${idPrefix}-shareValue`}
            label={shareType === "FIXED" ? t("shareValueEgp") : t("shareValuePct")}
            hint={shareType === "FIXED" ? t("shareValueInheritedHint") : undefined}
            error={error("shareValue")}
          >
            <Input
              id={`${idPrefix}-shareValue`}
              name="shareValue"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min={0}
              {...(shareType === "FIXED"
                ? { step: "0.01" }
                : { step: 1, max: 100 })}
              value={shareValue}
              onChange={(event) => {
                shareValueTouched.current = true;
                setShareValue(event.target.value);
              }}
              aria-invalid={fieldErrors?.shareValue ? true : undefined}
            />
          </Field>
        </div>

        {preview ? (
          <dl className="mt-3 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
            <div className="flex justify-between gap-3 sm:block">
              <dt className="text-text-secondary">{t("centerShare")}</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(preview.centerShare, locale)}
              </dd>
            </div>
            <div className="flex justify-between gap-3 sm:block">
              <dt className="text-text-secondary">{t("teacherShare")}</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(preview.teacherShare, locale)}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="mt-2 text-xs text-text-muted">{t("snapshotNote")}</p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
          <Field
            id={`${idPrefix}-lateThresholdMinutes`}
            label={t("lateThreshold")}
            hint={t("lateThresholdHint")}
            error={error("lateThresholdMinutes")}
          >
            <Input
              id={`${idPrefix}-lateThresholdMinutes`}
              name="lateThresholdMinutes"
              type="number"
              dir="ltr"
              inputMode="numeric"
              min={0}
              max={MAX_LATE_THRESHOLD_MINUTES}
              step={1}
              defaultValue={values.lateThresholdMinutes}
              aria-invalid={
                fieldErrors?.lateThresholdMinutes ? true : undefined
              }
            />
          </Field>
        </div>

        <ToggleRow
          name="acceptsNewStudents"
          label={t("acceptsNewStudents")}
          description={t("acceptsNewStudentsHint")}
          defaultChecked={values.acceptsNewStudents}
        />

        <ToggleRow
          name="requiresConfirmation"
          label={t("requiresConfirmation")}
          description={t("requiresConfirmationHint")}
          defaultChecked={values.requiresConfirmation}
        />
      </div>
    </div>
  );
}
