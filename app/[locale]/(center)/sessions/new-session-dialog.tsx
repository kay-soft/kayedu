"use client";

import { startTransition, useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, CalendarPlus, DoorOpen, Banknote, Layers, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { createSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import { CatalogPickerFields } from "@/components/center/catalog-picker-fields";
import { RoomSetPicker, type RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { TeacherPicker, type TeacherOption } from "@/components/center/teacher-picker";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import {
  DialogLauncher,
  DialogSections,
  DialogShell,
  FormSection,
} from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { CatalogPickerData } from "@/lib/catalog-picker";
import { formatMoney } from "@/lib/format";
import { useRouter } from "@/lib/i18n/navigation";
import { Checkbox } from "@/components/ui/checkbox";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres, piastresToInputValue, splitShare } from "@/lib/money";
import { ROUTES } from "@/lib/routes";
import type { RoomLinkPair } from "@/lib/rooms";
import { isValidTimeRange } from "@/lib/scheduling";
import { cn } from "@/lib/utils";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/** An active class, with what the "For a class" mode defaults from. */
export type NewSessionClassOption = {
  id: string;
  label: string;
  teacherId: string;
  roomId: string;
  extraRoomIds: string[];
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
};

type Mode = "class" | "oneOff";

/** Errors the conflict notice already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["conflict", "conflictsNeedConfirmation"]);

/** The class's slot on that weekday, else its first slot — the time default. */
function slotFor(option: NewSessionClassOption | undefined, isoDate: string) {
  if (!option || option.slots.length === 0) return null;
  const weekday = /^\d{4}-\d{2}-\d{2}$/.test(isoDate)
    ? new Date(`${isoDate}T12:00:00.000Z`).getUTCDay()
    : -1;
  return option.slots.find((slot) => slot.dayOfWeek === weekday) ?? option.slots[0];
}

type NewSessionProps = {
  classes: NewSessionClassOption[];
  teachers: TeacherOption[];
  /** U3 — the centre's offered systems → grades → subjects; the system only narrows (a session stores none). */
  catalog: CatalogPickerData;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  defaultCut: { centerShareType: ShareType; centerShareValue: number };
  todayIso: string;
  noneLabel: string;
};

/**
 * "New session" on the Sessions tab (R5 → re-laid out in R6,
 * docs/04-design-system.md §11.14 / §11.15) — one entry point, two modes as a
 * segmented control, in the shared `DialogShell`:
 *
 * - **For a class** — an extra session on an active class, picked from a
 *   searchable list. Picking it fills the teacher (a substitute may be
 *   chosen), the room set and the time from the class's slot on that weekday;
 *   price and centre cut are the class's and are not asked for.
 * - **One-time session** — no class: a title, an optional subject and grade,
 *   teacher, room set, price and centre cut (defaulting to the centre's own
 *   default cut). Everyone attending is a drop-in.
 *
 * Date defaults to today; a past date is refused by the server in the
 * centre's timezone. Conflicts preview live in `SlotConflictNotice` — right
 * under the teacher, time and room cards they concern, with the create button
 * held until a WARN list is ticked — and a holiday shows a non-blocking
 * notice. The form keeps everything typed after a refusal.
 */
export function NewSessionDialog(props: NewSessionProps) {
  const t = useTranslations("Sessions.newSession");
  return (
    <DialogLauncher
      button={(openDialog) => (
        <Button className="h-11 px-4" onClick={openDialog}>
          <CalendarPlus className="size-4" />
          {t("button")}
        </Button>
      )}
      render={(dialog) => <NewSessionDialogContent {...dialog} {...props} />}
    />
  );
}

function NewSessionDialogContent({
  open,
  onOpenChange,
  classes,
  teachers,
  catalog,
  rooms,
  roomLinks,
  defaultCut,
  todayIso,
  noneLabel,
}: NewSessionProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Sessions.newSession");
  const tPickers = useTranslations("Pickers.class");
  const tClasses = useTranslations("Classes");
  const tCommon = useTranslations("Settings.common");
  const tSections = useTranslations("Sessions.newSession.sections");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const router = useRouter();
  const [state, formAction, pending] = useGuardedActionState(createSessionAction, IDLE_SESSION_STATE);

  const hasClasses = classes.length > 0;
  const [mode, setMode] = useState<Mode>(hasClasses ? "class" : "oneOff");
  const [classGroupId, setClassGroupId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [date, setDate] = useState(todayIso);
  const [time, setTime] = useState({ start: "", end: "" });
  const [roomSet, setRoomSet] = useState<{ roomId: string | null; extraRoomIds: string[] }>({
    roomId: null,
    extraRoomIds: [],
  });
  // Bumped whenever a class fills the room set, so the picker remounts on it.
  const [roomKey, setRoomKey] = useState(0);
  const [shareType, setShareType] = useState<ShareType>(defaultCut.centerShareType);
  const [shareValue, setShareValue] = useState(
    defaultCut.centerShareType === "FIXED"
      ? piastresToInputValue(defaultCut.centerShareValue)
      : String(defaultCut.centerShareValue),
  );
  const [price, setPrice] = useState("");
  // D-26 (b): a free one-time session is allowed, after an explicit tick.
  const [confirmZeroPrice, setConfirmZeroPrice] = useState(false);

  // Open the new session once — a re-render while the dialog closes must not
  // navigate twice.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "created" || !state.newSessionId) return;
    if (opened.current === state.newSessionId) return;
    opened.current = state.newSessionId;
    onOpenChange(false);
    router.push(ROUTES.centerSession(state.newSessionId));
  }, [state.status, state.newSessionId, onOpenChange, router]);

  function pickClass(id: string) {
    setClassGroupId(id);
    const option = classes.find((row) => row.id === id);
    if (!option) return;
    setTeacherId(option.teacherId);
    setRoomSet({ roomId: option.roomId || null, extraRoomIds: option.extraRoomIds });
    setRoomKey((key) => key + 1);
    const slot = slotFor(option, date);
    if (slot) setTime({ start: slot.startTime, end: slot.endTime });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const selectedClass = classes.find((row) => row.id === classGroupId);
  const checkable =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    isValidTimeRange(time.start, time.end) &&
    teacherId !== "" &&
    Boolean(roomSet.roomId) &&
    (mode === "oneOff" || classGroupId !== "");
  const conflicts = useSlotConflicts(
    checkable
      ? {
          kind: "newSession",
          locale,
          classGroupId: mode === "class" ? classGroupId : null,
          teacherId,
          roomId: roomSet.roomId!,
          extraRoomIds: roomSet.extraRoomIds,
          date,
          startTime: time.start,
          endTime: time.end,
        }
      : null,
    state.error ? state : undefined,
  );

  const error = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  const classOptions: ComboboxOption[] = classes.map((option) => ({
    value: option.id,
    label: option.label,
  }));

  // Preview only — the same parser and split the server uses (lib/money.ts,
  // SEC-74); the server re-derives everything on submit.
  const pricePiastres = mode === "oneOff" ? parseEgpToPiastres(price, MAX_PRICE_PIASTRES) : null;
  const cutValue =
    shareType === "FIXED" ? parseEgpToPiastres(shareValue, MAX_PRICE_PIASTRES) : Number.isInteger(Number(shareValue)) && shareValue.trim() !== "" ? Number(shareValue) : null;
  const preview =
    pricePiastres !== null && cutValue !== null ? splitShare(pricePiastres, shareType, cutValue) : null;
  const zeroPrice = pricePiastres === 0;

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
      formProps={{ onSubmit, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="mode" value={mode} />

      <div className="flex flex-col gap-4">
        {state.error && !CONFLICT_ERRORS.has(state.error) ? (
          <FormMessage>{tErrors(state.error)}</FormMessage>
        ) : null}

        <DialogSections>
          <FormSection title={tSections("session")} icon={<Layers />} wide>
            <div
              role="group"
              aria-label={t("modeLabel")}
              className="flex h-11 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5 sm:max-w-md"
            >
              {(["class", "oneOff"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  disabled={value === "class" && !hasClasses}
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex h-full min-w-11 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium",
                    "transition-ui focus-ring disabled:cursor-not-allowed disabled:opacity-50",
                    mode === value
                      ? "bg-surface text-text-primary shadow-card"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
                  )}
                >
                  {value === "class" ? t("modeClass") : t("modeOneOff")}
                </button>
              ))}
            </div>
            <p className="-mt-1 text-xs text-text-muted">
              {mode === "class" ? t("modeClassHint") : t("modeOneOffHint")}
            </p>

            {mode === "class" ? (
              <Field id="new-session-class" label={t("class")} error={error("classGroupId")}>
                <Combobox
                  id="new-session-class"
                  name="classGroupId"
                  options={classOptions}
                  value={classGroupId}
                  onValueChange={pickClass}
                  placeholder={tPickers("placeholder")}
                  emptyLabel={tPickers("empty")}
                  clearLabel={tPickers("clear")}
                  openLabel={tPickers("open")}
                  required
                  aria-invalid={state.fieldErrors?.classGroupId ? true : undefined}
                />
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  id="new-session-title"
                  label={t("titleField")}
                  hint={t("titleHint")}
                  error={error("title")}
                  className="sm:col-span-3"
                >
                  <Input
                    id="new-session-title"
                    name="title"
                    maxLength={80}
                    required
                    aria-invalid={state.fieldErrors?.title ? true : undefined}
                  />
                </Field>
                <CatalogPickerFields
                  idPrefix="new-session"
                  data={catalog}
                  systemName={null}
                  noneLabel={noneLabel}
                  errors={{ gradeId: error("gradeId"), subjectId: error("subjectId") }}
                />
              </div>
            )}
          </FormSection>

          <FormSection title={tSections("teacher")} icon={<UserRound />}>
            <Field
              id="new-session-teacher"
              label={tClasses("fields.teacher")}
              hint={
                mode === "class" && selectedClass && teacherId && teacherId !== selectedClass.teacherId
                  ? t("substituteHint")
                  : undefined
              }
              error={error("teacherId")}
            >
              <TeacherPicker
                id="new-session-teacher"
                teachers={teachers}
                value={teacherId}
                onValueChange={setTeacherId}
                required
                invalid={Boolean(state.fieldErrors?.teacherId)}
              />
            </Field>
          </FormSection>

          <FormSection title={tSections("when")} icon={<CalendarClock />}>
            <Field id="new-session-date" label={t("date")} hint={t("dateHint")} error={error("date")}>
              <DatePicker
                id="new-session-date"
                name="date"
                defaultValue={todayIso}
                todayIso={todayIso}
                onValueChange={setDate}
                required
                aria-invalid={state.fieldErrors?.date ? true : undefined}
              />
            </Field>
            <TimeRangeFields
              idPrefix="new-session-time"
              startLabel={t("startTime")}
              endLabel={t("endTime")}
              start={time.start}
              end={time.end}
              onChange={setTime}
              error={error("startTime") ?? error("endTime")}
              required
            />
          </FormSection>

          <FormSection title={tSections("rooms")} icon={<DoorOpen />}>
            <RoomSetPicker
              key={roomKey}
              idPrefix="new-session"
              rooms={rooms}
              links={roomLinks}
              defaultRoomId={roomSet.roomId ?? ""}
              defaultExtraIds={roomSet.extraRoomIds}
              required
              noneLabel={noneLabel}
              roomError={error("roomId")}
              extraError={error("extraRoomIds")}
              onChange={setRoomSet}
            />
          </FormSection>

          {mode === "oneOff" ? (
            <FormSection title={tSections("money")} icon={<Banknote />}>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="new-session-price" label={tClasses("fields.price")} error={error("price")}>
                  <Input
                    id="new-session-price"
                    name="price"
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    aria-invalid={state.fieldErrors?.price ? true : undefined}
                  />
                </Field>
                <Field id="new-session-shareType" label={tClasses("fields.shareType")}>
                  <Select
                    id="new-session-shareType"
                    name="centerShareType"
                    value={shareType}
                    onValueChange={(next) => setShareType(next as ShareType)}
                  >
                    <option value="PERCENTAGE">{tClasses("fields.percentage")}</option>
                    <option value="FIXED">{tClasses("fields.fixed")}</option>
                  </Select>
                </Field>
                <Field
                  id="new-session-shareValue"
                  label={shareType === "FIXED" ? tClasses("fields.shareValueEgp") : tClasses("fields.shareValuePct")}
                  error={error("shareValue")}
                >
                  <Input
                    id="new-session-shareValue"
                    name="shareValue"
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    min={0}
                    {...(shareType === "FIXED" ? { step: "0.01" } : { step: 1, max: 100 })}
                    value={shareValue}
                    onChange={(event) => setShareValue(event.target.value)}
                    aria-invalid={state.fieldErrors?.shareValue ? true : undefined}
                  />
                </Field>
              </div>
              {zeroPrice ? (
                <label
                  htmlFor="new-session-confirm-zero-price"
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-warning bg-warning-bg px-3 py-2 text-sm text-text-primary"
                >
                  <Checkbox
                    id="new-session-confirm-zero-price"
                    name="confirmZeroPrice"
                    checked={confirmZeroPrice}
                    onCheckedChange={(checked) => setConfirmZeroPrice(checked === true)}
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{t("zeroPriceConfirm")}</span>
                    <span className="text-xs text-text-secondary">{t("zeroPriceHint")}</span>
                  </span>
                </label>
              ) : null}
              {preview ? (
                <dl className="flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-text-secondary">{tClasses("fields.centerShare")}</dt>
                    <dd className="font-semibold tabular-nums">{formatMoney(preview.centerShare, locale)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-text-secondary">{tClasses("fields.teacherShare")}</dt>
                    <dd className="font-semibold tabular-nums">{formatMoney(preview.teacherShare, locale)}</dd>
                  </div>
                </dl>
              ) : null}
              <p className="text-xs text-text-muted">{t("oneOffMoneyNote")}</p>
            </FormSection>
          ) : (
            <p className="text-xs text-text-muted">{t("classMoneyNote")}</p>
          )}
        </DialogSections>

        {/* Next to the teacher, time and room cards it concerns. */}
        {conflicts.holiday ? <FormMessage tone="info">{t("holidayNotice")}</FormMessage> : null}
        <SlotConflictNotice
          idPrefix="new-session"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}
