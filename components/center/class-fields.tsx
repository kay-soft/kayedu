"use client";

import { useRef, useState, type ReactNode } from "react";
import { Banknote, CalendarClock, DoorOpen, Layers, LogIn, UserRound, UsersRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { SessionBookingMode, ShareType } from "@prisma/client";

import {
  ClassPeriodFields,
  type TermOption,
} from "@/components/center/class-period-fields";
import { RoomSetPicker, type RoomOption } from "@/components/center/room-set-picker";
import { Field } from "@/components/shared/field";
import { FormSection } from "@/components/shared/dialog-shell";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney, formatNumber } from "@/lib/format";
import { MAX_BOOKING_SEATS, MAX_LATE_THRESHOLD_MINUTES } from "@/lib/validation/classes";
import { MAX_PRICE_PIASTRES, centerCutError, parseEgpToPiastres, piastresToInputValue, splitShare } from "@/lib/money";
import { effectiveCapacity, type RoomLinkPair } from "@/lib/rooms";

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
  /** F6 — single-session attendance online. */
  sessionBookingMode: SessionBookingMode;
  /** F6 — the per-session booking cap as typed ("" = none). */
  maxBookingSeats: string;
  /** R4 — the class's period, "YYYY-MM-DD" ("" on a new class). */
  startDate: string;
  endDate: string;
};

/**
 * What a class's sessions are checked against in the live preview besides its
 * teacher (which the caller owns — R6 moved the teacher into its own section):
 * its room set (R3) and its period (R4) — the whole range.
 */
export type ClassPlacementInputs = {
  roomId: string | null;
  extraRoomIds: string[];
  startDate: string;
  endDate: string;
};

/**
 * Every field a `ClassGroup` carries (docs/01-data-model.md §2), laid out as
 * titled cards (R6, docs/04 §11.15) so the common path fits a 1280px dialog
 * with little or no scrolling:
 *
 * - **Basics** — subject, grade, education system, side by side;
 * - **Teacher** — whatever the caller puts there (a searchable picker; on
 *   create, also "New teacher") — next to **Room(s)** (R3 — a required
 *   primary room plus any rooms combined with it; the set's summed capacity is
 *   the seat limit) and **Class period** (R4, a term preset or typed dates);
 * - **Weekly schedule** — the caller's rows and the conflict notice that
 *   concerns them (new classes only; an existing class edits its slots on its
 *   own page);
 * - **Pricing & centre cut**, **Attendance** (the late threshold) and
 *   **Joining** (F6 — accept new students, how enrolment is confirmed,
 *   single-session booking and its optional cap, and the seat limit the room
 *   set gives, read-only).
 *
 * Two columns from `lg`, one below. Shared between the New class dialog and
 * the Edit class dialog, exactly like `student-fields.tsx` is shared between
 * `StudentForm` and `StudentProfileForm`.
 */
export function ClassFields({
  idPrefix,
  values,
  subjects,
  grades,
  educationSystems,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  terms,
  noneLabel,
  fieldErrors,
  teacherSection,
  scheduleSection,
  placementNotice,
  onPlacementChange,
}: {
  idPrefix: string;
  values: ClassFieldsValues;
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
  /** R4 — the centre's ACTIVE term presets, for "Choose a term". */
  terms: TermOption[];
  noneLabel: string;
  fieldErrors?: Record<string, string>;
  /** The contents of the Teacher card. */
  teacherSection: ReactNode;
  /** The contents of the Weekly schedule card; omitted = no such card. */
  scheduleSection?: ReactNode;
  /**
   * A conflict notice that concerns the teacher / rooms / period above it
   * (Edit class), shown full-width right under them instead of at the foot of
   * the dialog. (New class puts its notice in the schedule card.)
   */
  placementNotice?: ReactNode;
  /** Room set or period changed — the form re-previews conflicts. */
  onPlacementChange?: (next: ClassPlacementInputs) => void;
}) {
  const t = useTranslations("Classes.fields");
  const tSections = useTranslations("Classes.sections");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [shareType, setShareType] = useState<ShareType>(values.centerShareType);
  const [shareValue, setShareValue] = useState(values.centerShareValue);
  const [priceInput, setPriceInput] = useState(values.price);
  const [educationSystemId, setEducationSystemId] = useState(values.educationSystemId);
  const placement = useRef<ClassPlacementInputs>({
    roomId: values.roomId || null,
    extraRoomIds: values.extraRoomIds,
    startDate: values.startDate,
    endDate: values.endDate,
  });
  // F6 — the seat limit shown read-only in Joining follows the room picker.
  const [roomSet, setRoomSet] = useState({ roomId: values.roomId || null, extraRoomIds: values.extraRoomIds });
  const [bookingMode, setBookingMode] = useState<SessionBookingMode>(values.sessionBookingMode);
  function changePlacement(patch: Partial<ClassPlacementInputs>) {
    placement.current = { ...placement.current, ...patch };
    if (patch.roomId !== undefined || patch.extraRoomIds !== undefined) {
      setRoomSet({ roomId: placement.current.roomId, extraRoomIds: placement.current.extraRoomIds });
    }
    onPlacementChange?.(placement.current);
  }
  const chosenRooms = roomSet.roomId
    ? rooms.filter((room) => room.id === roomSet.roomId || roomSet.extraRoomIds.includes(room.id))
    : [];
  const seatLimit = effectiveCapacity(chosenRooms);
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

  // Preview only, through the server's own parser and split (lib/money.ts,
  // SEC-74). A FIXED cut above the price is shown as refused (D-15).
  const pricePiastres = parseEgpToPiastres(priceInput === "" ? "0" : priceInput, MAX_PRICE_PIASTRES);
  const cutValue =
    shareType === "FIXED"
      ? parseEgpToPiastres(shareValue, MAX_PRICE_PIASTRES)
      : shareValue.trim() !== "" && Number.isInteger(Number(shareValue)) ? Number(shareValue) : null;
  const cutProblem =
    pricePiastres !== null && cutValue !== null ? centerCutError(pricePiastres, shareType, cutValue) : null;
  const preview =
    pricePiastres !== null && cutValue !== null && !cutProblem
      ? splitShare(pricePiastres, shareType, cutValue)
      : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <FormSection title={tSections("basics")} icon={<Layers />} wide>
        <div className="grid gap-4 sm:grid-cols-3">
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
        </div>
      </FormSection>

      <div className="flex min-w-0 flex-col gap-4">
        <FormSection title={tSections("teacher")} icon={<UserRound />}>
          {teacherSection}
        </FormSection>

        <FormSection title={tSections("rooms")} icon={<DoorOpen />}>
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
            onChange={(next) => changePlacement(next)}
          />
        </FormSection>
      </div>

      <ClassPeriodFields
        idPrefix={idPrefix}
        terms={terms}
        defaultValue={{ startDate: values.startDate, endDate: values.endDate }}
        startError={error("startDate")}
        endError={error("endDate")}
        onChange={(next) => changePlacement(next)}
      />

      {placementNotice ? <div className="empty:hidden lg:col-span-2">{placementNotice}</div> : null}

      {scheduleSection ? (
        <FormSection
          title={tSections("schedule")}
          description={tSections("scheduleHint")}
          icon={<CalendarClock />}
          wide
        >
          {scheduleSection}
        </FormSection>
      ) : null}

      <FormSection title={tSections("pricing")} icon={<Banknote />}>
        {/* The cut-type select keeps room for its label (it had truncated to
            "Percenta…" in a half-width section) — DES, docs/04 §14.7. */}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,auto)_minmax(0,1fr)]">
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
            error={error("shareValue") ?? (cutProblem === "fixedAbovePrice" ? tErrors("fixedAbovePrice") : undefined)}
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

        {shareType === "FIXED" ? (
          <p className="-mt-1 text-xs text-text-muted">{t("shareValueInheritedHint")}</p>
        ) : null}

        {preview ? (
          <dl className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
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
        <p className="text-xs text-text-muted">{t("snapshotNote")}</p>
      </FormSection>

      <FormSection title={tSections("attendance")} icon={<UsersRound />}>
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

      </FormSection>

      <FormSection title={tSections("joining")} description={tSections("joiningHint")} icon={<LogIn />} wide>
        <ToggleRow
          name="acceptsNewStudents"
          label={t("acceptsNewStudents")}
          description={t("acceptsNewStudentsHint")}
          defaultChecked={values.acceptsNewStudents}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${idPrefix}-requiresConfirmation`}
            label={t("enrolmentMode")}
            hint={t("enrolmentModeHint")}
          >
            <Select
              id={`${idPrefix}-requiresConfirmation`}
              name="requiresConfirmation"
              defaultValue={values.requiresConfirmation ? "true" : "false"}
            >
              <option value="false">{t("modeInstant")}</option>
              <option value="true">{t("modeApproval")}</option>
            </Select>
          </Field>

          <Field
            id={`${idPrefix}-sessionBookingMode`}
            label={t("sessionBookingMode")}
            hint={t("sessionBookingModeHint")}
            error={error("sessionBookingMode")}
          >
            <Select
              id={`${idPrefix}-sessionBookingMode`}
              name="sessionBookingMode"
              value={bookingMode}
              onValueChange={(next) => setBookingMode(next as SessionBookingMode)}
            >
              <option value="OFF">{t("bookingOff")}</option>
              <option value="INSTANT">{t("modeInstant")}</option>
              <option value="APPROVAL">{t("modeApproval")}</option>
            </Select>
          </Field>

          <Field
            id={`${idPrefix}-maxBookingSeats`}
            label={t("maxBookingSeats")}
            hint={t("maxBookingSeatsHint")}
            optional
            error={error("maxBookingSeats")}
          >
            <Input
              id={`${idPrefix}-maxBookingSeats`}
              name="maxBookingSeats"
              type="number"
              dir="ltr"
              inputMode="numeric"
              min={1}
              max={MAX_BOOKING_SEATS}
              step={1}
              defaultValue={values.maxBookingSeats}
              disabled={bookingMode === "OFF"}
              aria-invalid={fieldErrors?.maxBookingSeats ? true : undefined}
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-primary">{t("seatLimit")}</span>
            <p className="flex min-h-11 items-center rounded-lg bg-surface-subtle px-3 text-sm tabular-nums text-text-primary">
              {roomSet.roomId
                ? seatLimit > 0
                  ? t("seatLimitValue", { count: formatNumber(seatLimit, locale) })
                  : t("seatLimitUnlimited")
                : t("seatLimitNoRoom")}
            </p>
            <p className="text-xs text-text-muted">{t("seatLimitHint")}</p>
          </div>
        </div>
        {/* A disabled input posts nothing; keep the stored cap while booking is off. */}
        {bookingMode === "OFF" ? (
          <input type="hidden" name="maxBookingSeats" value={values.maxBookingSeats} />
        ) : null}
      </FormSection>
    </div>
  );
}
