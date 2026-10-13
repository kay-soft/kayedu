"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { createSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import type { SelectOption } from "@/components/center/class-fields";
import { RoomSetPicker, type RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/format";
import { useRouter } from "@/lib/i18n/navigation";
import { piastresToInputValue, splitShare } from "@/lib/money";
import { ROUTES } from "@/lib/routes";
import type { RoomLinkPair } from "@/lib/rooms";
import { isValidTimeRange } from "@/lib/scheduling";
import { cn } from "@/lib/utils";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

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

/**
 * "New session" on the Sessions tab (R5, docs/04-design-system.md §11.14) —
 * one entry point, two modes as a segmented control:
 *
 * - **For a class** — an extra session on an active class. Picking the class
 *   fills the teacher (a substitute may be chosen), the room set and the
 *   time from the class's slot on that weekday; price and centre cut are the
 *   class's and are not asked for.
 * - **One-time session** — no class: a title, an optional subject and grade,
 *   teacher, room set, price and centre cut (defaulting to the centre's own
 *   default cut). Everyone attending is a drop-in.
 *
 * Date defaults to today; a past date is refused by the server in the
 * centre's timezone. Conflicts preview live in `SlotConflictNotice` (the
 * same check the save runs), and a holiday shows a non-blocking notice.
 * The current dialog layout — R6 re-lays out the class/session dialogs.
 */
export function NewSessionDialog({
  classes,
  teachers,
  subjects,
  grades,
  rooms,
  roomLinks,
  defaultCut,
  todayIso,
  noneLabel,
}: {
  classes: NewSessionClassOption[];
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  defaultCut: { centerShareType: ShareType; centerShareValue: number };
  todayIso: string;
  noneLabel: string;
}) {
  const t = useTranslations("Sessions.newSession");
  const [open, setOpen] = useState(false);
  // Remounts the form on every open, so a new dialog never shows the last
  // submit's errors or half-filled fields.
  const [formKey, setFormKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setFormKey((key) => key + 1);
      }}
    >
      <DialogTrigger
        render={
          <Button className="h-11 px-4">
            <CalendarPlus className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <NewSessionForm
            key={formKey}
            classes={classes}
            teachers={teachers}
            subjects={subjects}
            grades={grades}
            rooms={rooms}
            roomLinks={roomLinks}
            defaultCut={defaultCut}
            todayIso={todayIso}
            noneLabel={noneLabel}
            onCreated={() => setOpen(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function NewSessionForm({
  classes,
  teachers,
  subjects,
  grades,
  rooms,
  roomLinks,
  defaultCut,
  todayIso,
  noneLabel,
  onCreated,
}: {
  classes: NewSessionClassOption[];
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  defaultCut: { centerShareType: ShareType; centerShareValue: number };
  todayIso: string;
  noneLabel: string;
  onCreated: () => void;
}) {
  const t = useTranslations("Sessions.newSession");
  const tClasses = useTranslations("Classes");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const router = useRouter();
  const [state, formAction] = useActionState(createSessionAction, IDLE_SESSION_STATE);

  const hasClasses = classes.length > 0;
  const [mode, setMode] = useState<Mode>(hasClasses ? "class" : "oneOff");
  const [classGroupId, setClassGroupId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [date, setDate] = useState(todayIso);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
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

  // Open the new session once — a re-render while the dialog closes must not
  // navigate twice.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "created" || !state.newSessionId) return;
    if (opened.current === state.newSessionId) return;
    opened.current = state.newSessionId;
    onCreated();
    router.push(ROUTES.centerSession(state.newSessionId));
  }, [state.status, state.newSessionId, onCreated, router]);

  function pickClass(id: string) {
    setClassGroupId(id);
    const option = classes.find((row) => row.id === id);
    if (!option) return;
    setTeacherId(option.teacherId);
    setRoomSet({ roomId: option.roomId || null, extraRoomIds: option.extraRoomIds });
    setRoomKey((key) => key + 1);
    const slot = slotFor(option, date);
    if (slot) {
      setStartTime(slot.startTime);
      setEndTime(slot.endTime);
    }
  }

  const selectedClass = classes.find((row) => row.id === classGroupId);
  const checkable =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    isValidTimeRange(startTime, endTime) &&
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
          startTime,
          endTime,
        }
      : null,
    state.error ? state : undefined,
  );

  const error = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  const priceEgp = Number(price);
  const preview =
    mode === "oneOff" && price.trim() !== "" && Number.isFinite(priceEgp) && priceEgp >= 0 &&
    shareValue.trim() !== "" && Number.isFinite(Number(shareValue))
      ? splitShare(
          Math.round(priceEgp * 100),
          shareType,
          shareType === "FIXED" ? Math.round(Number(shareValue) * 100) : Math.round(Number(shareValue)),
        )
      : null;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="mode" value={mode} />

      <div
        role="group"
        aria-label={t("modeLabel")}
        className="flex h-11 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5"
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
      <p className="-mt-2 text-xs text-text-muted">
        {mode === "class" ? t("modeClassHint") : t("modeOneOffHint")}
      </p>

      {state.error && !CONFLICT_ERRORS.has(state.error) ? (
        <FormMessage>{tErrors(state.error)}</FormMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {mode === "class" ? (
          <Field
            id="new-session-class"
            label={t("class")}
            error={error("classGroupId")}
            className="sm:col-span-2"
          >
            <Select
              id="new-session-class"
              name="classGroupId"
              value={classGroupId}
              onValueChange={pickClass}
              aria-invalid={state.fieldErrors?.classGroupId ? true : undefined}
            >
              <option value="" disabled>
                {t("classPlaceholder")}
              </option>
              {classes.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <Field
              id="new-session-title"
              label={t("titleField")}
              hint={t("titleHint")}
              error={error("title")}
              className="sm:col-span-2"
            >
              <Input
                id="new-session-title"
                name="title"
                maxLength={80}
                required
                aria-invalid={state.fieldErrors?.title ? true : undefined}
              />
            </Field>
            <Field id="new-session-subject" label={tClasses("subject")} optional error={error("subjectId")}>
              <Select id="new-session-subject" name="subjectId" defaultValue="">
                <option value="">{noneLabel}</option>
                {subjects.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="new-session-grade" label={tClasses("grade")} optional error={error("gradeId")}>
              <Select id="new-session-grade" name="gradeId" defaultValue="">
                <option value="">{noneLabel}</option>
                {grades.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        <Field
          id="new-session-teacher"
          label={tClasses("teacher")}
          hint={
            mode === "class" && selectedClass && teacherId && teacherId !== selectedClass.teacherId
              ? t("substituteHint")
              : undefined
          }
          error={error("teacherId")}
          className="sm:col-span-2"
        >
          <Select
            id="new-session-teacher"
            name="teacherId"
            value={teacherId}
            onValueChange={setTeacherId}
            aria-invalid={state.fieldErrors?.teacherId ? true : undefined}
          >
            <option value="" disabled>
              {tClasses("teacherPlaceholder")}
            </option>
            {teachers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

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

        <div className="grid grid-cols-2 gap-3">
          <Field id="new-session-start" label={t("startTime")} error={error("startTime")}>
            <Input
              id="new-session-start"
              type="time"
              name="startTime"
              dir="ltr"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              required
            />
          </Field>
          <Field id="new-session-end" label={t("endTime")} error={error("endTime")}>
            <Input
              id="new-session-end"
              type="time"
              name="endTime"
              dir="ltr"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              required
            />
          </Field>
        </div>

        <div className="sm:col-span-2">
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
        </div>
      </div>

      {mode === "oneOff" ? (
        <div className="rounded-xl border border-border p-3 sm:p-4">
          <p className="mb-3 text-sm font-medium text-text-primary">{tClasses("moneyTitle")}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="new-session-price" label={tClasses("price")} error={error("price")}>
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
            <Field id="new-session-shareType" label={tClasses("shareType")}>
              <Select
                id="new-session-shareType"
                name="centerShareType"
                value={shareType}
                onValueChange={(next) => setShareType(next as ShareType)}
              >
                <option value="PERCENTAGE">{tClasses("percentage")}</option>
                <option value="FIXED">{tClasses("fixed")}</option>
              </Select>
            </Field>
            <Field
              id="new-session-shareValue"
              label={shareType === "FIXED" ? tClasses("shareValueEgp") : tClasses("shareValuePct")}
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
          {preview ? (
            <dl className="mt-3 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
              <div className="flex justify-between gap-3 sm:block">
                <dt className="text-text-secondary">{tClasses("centerShare")}</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.centerShare, locale)}</dd>
              </div>
              <div className="flex justify-between gap-3 sm:block">
                <dt className="text-text-secondary">{tClasses("teacherShare")}</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.teacherShare, locale)}</dd>
              </div>
            </dl>
          ) : null}
          <p className="mt-2 text-xs text-text-muted">{t("oneOffMoneyNote")}</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">{t("classMoneyNote")}</p>
      )}

      {conflicts.holiday ? <FormMessage tone="info">{t("holidayNotice")}</FormMessage> : null}

      <SlotConflictNotice
        idPrefix="new-session"
        conflicts={conflicts.conflicts}
        policy={conflicts.policy}
        confirmed={conflicts.confirmed}
        onConfirmedChange={conflicts.setConfirmed}
      />

      <SubmitButton className="w-full sm:w-auto sm:self-end" disabled={conflicts.blocked}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}
