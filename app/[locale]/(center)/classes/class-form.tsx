"use client";

import { startTransition, useEffect, useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import {
  createClassAction,
  createClassWithNewTeacherAction,
} from "@/app/[locale]/(center)/classes/actions";
import {
  ClassFields,
  type ClassPlacementInputs,
} from "@/components/center/class-fields";
import type { TermOption } from "@/components/center/class-period-fields";
import { NewTeacherFields } from "@/components/center/new-teacher-fields";
import type { RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { TeacherPicker, type TeacherOption } from "@/components/center/teacher-picker";
import { WeeklyScheduleRows } from "@/components/center/weekly-schedule-rows";
import { DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import type { CatalogPickerData } from "@/lib/catalog-picker";
import { piastresToInputValue } from "@/lib/money";
import type { RoomLinkPair } from "@/lib/rooms";
import { weeklySlotsError, type WeeklySlotRow } from "@/lib/scheduling";
import { cn } from "@/lib/utils";
import { IDLE_CLASS_STATE, type ClassActionState } from "@/lib/validation/classes";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export type ClassFormDefaults = {
  centerShareType: ShareType;
  centerShareValue: number;
  lateThresholdMinutes: number;
};

/** Errors the conflict notice already lists — shown in the banner as a pointer, not twice. */
const CONFLICT_ERRORS = new Set(["scheduleConflict", "conflictsNeedConfirmation"]);

type TeacherMode = "select" | "new";

/**
 * The New class dialog (R6, docs/04 §11.15) — class, weekly schedule rows and
 * every session of its period, created in ONE step, in the shared
 * `DialogShell` with the sectioned `ClassFields`.
 *
 * - **Teacher** — "Select teacher" (the searchable `TeacherPicker`) or "New
 *   teacher", which shows the Add teacher form's own fields
 *   (`NewTeacherFields`) and runs `createClassWithNewTeacherAction`: the
 *   teacher and the class are created in one transaction, so a failure in
 *   either leaves nothing behind. A phone that already belongs to someone
 *   comes back as a match to confirm ("Use this person"), never a second
 *   person; one who already teaches here is offered to be selected instead.
 * - **Weekly schedule** — one or more rows (weekday, start, end); the live
 *   conflict preview checks the whole period as the teacher, rooms, period or
 *   rows change, and its notice — with the one confirm tick — sits right under
 *   the rows. The create button stays disabled until a WARN list is ticked
 *   (never under DENY).
 *
 * The form keeps everything typed after a refusal: it submits through
 * `startTransition` rather than a `<form action>`, which React resets.
 * Defaults come from the centre's own general settings (docs/04 §5 "Dialog").
 */
export function NewClassDialogContent({
  open,
  onOpenChange,
  teachers,
  catalog,
  educationSystemDefaultFixedShare,
  rooms,
  roomLinks,
  terms,
  noneLabel,
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teachers: TeacherOption[];
  /** The centre's offered systems → grades → subjects (U3). */
  catalog: CatalogPickerData;
  educationSystemDefaultFixedShare: Record<string, number>;
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  terms: TermOption[];
  noneLabel: string;
  defaults: ClassFormDefaults;
}) {
  const t = useTranslations("Classes");
  const tNew = useTranslations("Classes.newTeacher");
  const tErrors = useTranslations("Classes.errors");
  const tCommon = useTranslations("Settings.common");
  const tPeopleErrors = useTranslations("People.errors");
  const locale = useLocale();

  const [selectState, selectAction, selectPending] = useGuardedActionState(createClassAction, IDLE_CLASS_STATE);
  const [newState, newAction, newPending] = useGuardedActionState(
    createClassWithNewTeacherAction,
    IDLE_CLASS_STATE,
  );
  const [submittedMode, setSubmittedMode] = useState<TeacherMode>("select");
  const state: ClassActionState = submittedMode === "new" ? newState : selectState;
  const pending = selectPending || newPending;

  const [mode, setMode] = useState<TeacherMode>("select");
  const [teacherId, setTeacherId] = useState("");
  const [rows, setRows] = useState<WeeklySlotRow[]>([{ dayOfWeek: 6, startTime: "", endTime: "" }]);
  const [placement, setPlacement] = useState<ClassPlacementInputs>({
    roomId: null,
    extraRoomIds: [],
    startDate: "",
    endDate: "",
  });
  const [matchPending, setMatchPending] = useState(false);

  const checkable =
    weeklySlotsError(rows, { required: true }) === null &&
    Boolean(placement.roomId) &&
    placement.startDate !== "" &&
    placement.endDate !== "" &&
    placement.startDate <= placement.endDate &&
    (mode === "new" || teacherId !== "");
  const slotConflicts = useSlotConflicts(
    checkable
      ? {
          kind: "newClass",
          locale,
          teacherId: mode === "select" ? teacherId : null,
          roomId: placement.roomId!,
          extraRoomIds: placement.extraRoomIds,
          startDate: placement.startDate,
          endDate: placement.endDate,
          slots: rows,
        }
      : null,
    state.error ? state : undefined,
  );

  useEffect(() => {
    if (state.status === "created") onOpenChange(false);
  }, [state.status, onOpenChange]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setSubmittedMode(mode);
    startTransition(() => (mode === "new" ? newAction(formData) : selectAction(formData)));
  }

  // The banner names the half that refused (R6): which part failed, and why.
  // A match waiting to be confirmed is not a failure — the panel handles it.
  const teacherFailed =
    state.status !== "matchFound" &&
    (state.part === "teacher" || Object.keys(state.teacherFieldErrors ?? {}).length > 0);
  const teacherReason = teacherFailed
    ? state.part === "teacher" && state.error
      ? tPeopleErrors(state.error)
      : tNew("checkFields")
    : null;
  const classFailed = state.part === "class" || Object.keys(state.fieldErrors ?? {}).length > 0;
  const classReason = classFailed ? (state.error ? tErrors(state.error) : tNew("checkFields")) : null;
  const plainError =
    state.error && !state.part && !CONFLICT_ERRORS.has(state.error) ? tErrors(state.error) : null;

  const alreadyTeacher =
    state.part === "teacher" && state.error === "alreadyTeacher" && state.match ? state.match : null;
  const fieldError = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  const teacherSection = (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={tNew("modeLabel")}
        className="flex h-11 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5"
      >
        {(["select", "new"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              "flex h-full min-w-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium",
              "transition-ui focus-ring",
              mode === value
                ? "bg-surface text-text-primary shadow-card"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
            )}
          >
            {value === "new" ? <UserPlus className="size-4" aria-hidden /> : null}
            {value === "select" ? tNew("modeSelect") : tNew("modeNew")}
          </button>
        ))}
      </div>

      <div hidden={mode !== "select"}>
        <Field id="class-create-teacherId" label={t("fields.teacher")} error={fieldError("teacherId")}>
          <TeacherPicker
            id="class-create-teacherId"
            teachers={teachers}
            value={teacherId}
            onValueChange={setTeacherId}
            required
            invalid={Boolean(state.fieldErrors?.teacherId)}
          />
        </Field>
      </div>

      {/* Always mounted (just hidden) so toggling away never loses what was typed. */}
      <div hidden={mode !== "new"} className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">{tNew("modeNewHint")}</p>
        {alreadyTeacher ? (
          <div className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info-bg/60 p-3 text-sm" role="status">
            <p className="text-text-primary">{tNew("alreadyTeacher", { name: alreadyTeacher.name ?? "" })}</p>
            <Button
              type="button"
              className="h-11 w-full sm:w-auto"
              onClick={() => {
                setTeacherId(alreadyTeacher.userId);
                setMode("select");
              }}
            >
              {tNew("selectThem", { name: alreadyTeacher.name ?? "" })}
            </Button>
          </div>
        ) : null}
        <NewTeacherFields
          idPrefix="class-teacher"
          fieldErrors={state.teacherFieldErrors}
          serverMatch={state.status === "matchFound" ? (state.match ?? null) : null}
          showHeader={false}
          onPendingChange={setMatchPending}
        />
      </div>
    </div>
  );

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("addTitle")}
      description={t("addDescription")}
      formProps={{ onSubmit, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("add")}
      submitPending={pending}
      submitDisabled={slotConflicts.blocked || (mode === "new" && matchPending)}
    >
      <input type="hidden" name="locale" value={locale} />

      <div className="flex flex-col gap-4">
        {teacherReason ? (
          <FormMessage>{tNew("teacherFailed", { reason: teacherReason })}</FormMessage>
        ) : null}
        {classReason ? <FormMessage>{tNew("classFailed", { reason: classReason })}</FormMessage> : null}
        {plainError ? <FormMessage>{plainError}</FormMessage> : null}

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
            sessionBookingMode: "OFF",
            maxBookingSeats: "",
            startDate: "",
            endDate: "",
          }}
          catalog={catalog}
          educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
          rooms={rooms}
          roomLinks={roomLinks}
          terms={terms}
          noneLabel={noneLabel}
          fieldErrors={state.fieldErrors}
          teacherSection={teacherSection}
          onPlacementChange={setPlacement}
          scheduleSection={
            <div className="flex flex-col gap-3">
              <WeeklyScheduleRows
                idPrefix="class-create-slot"
                onChange={setRows}
                error={fieldError("slots")}
              />
              <SlotConflictNotice
                idPrefix="class-create"
                conflicts={slotConflicts.conflicts}
                policy={slotConflicts.policy}
                confirmed={slotConflicts.confirmed}
                onConfirmedChange={slotConflicts.setConfirmed}
              />
            </div>
          }
        />
      </div>
    </DialogShell>
  );
}
