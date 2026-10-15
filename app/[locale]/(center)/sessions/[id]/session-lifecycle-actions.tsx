"use client";

import { useActionState, useState } from "react";
import { CalendarClock, DoorOpen, XCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  cancelSessionAction,
  rescheduleSessionAction,
  updateSessionRoomsAction,
} from "@/app/[locale]/(center)/sessions/actions";
import { RoomSetPicker, type RoomOption } from "@/components/center/room-set-picker";
import {
  SlotConflictNotice,
  useSlotConflicts,
} from "@/components/center/slot-conflict-notice";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { DatePicker } from "@/components/ui/date-picker";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import type { RoomLinkPair } from "@/lib/rooms";
import { isValidTimeRange } from "@/lib/scheduling";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";

/** Errors `SlotConflictNotice` already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["conflict", "conflictsNeedConfirmation"]);

type RoomSetProps = {
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  roomId: string;
  extraRoomIds: string[];
  noneLabel: string;
};

/**
 * The session's verbs on its detail page (spec §7 acceptance criterion 11,
 * closing the gap flagged since M5 — docs/02 §11): **Reschedule**, **Edit
 * rooms** (R3 — this one session's room set) and **Cancel** — as the buttons
 * of the page's `ActionBar` (R6, docs/04 §11.15), so they share the bar's
 * height, spacing and wrapping with Delete beside them. Reschedule and Edit
 * rooms open the shared `DialogShell`; Cancel — red like every destructive
 * action but the same size — opens a confirmation first (SYS: cancelling
 * cannot be undone, so it asks, the way End session and Delete session do).
 *
 * Cancelling never touches money or attendance rows (CLAUDE.md rule 2); a
 * manager who needs that too uses the roster's own void/correct controls,
 * unchanged. `canCancel`/`canReschedule` only hide controls — the server
 * actions re-check every permission.
 *
 * Reschedule copies the session's room set by default and may pick another
 * (primary + rooms linked to it); "Edit rooms" changes the set in place for
 * this session only — never the class's, so the class's enrolment cap is
 * unchanged. Both preview teacher/room clashes live in `SlotConflictNotice`
 * and need the confirmation under WARN.
 *
 * `locked` (M15) covers both terminal states a session can reach here:
 * CANCELLED (it never happened) and RESCHEDULED (it moved to a replacement,
 * `rescheduledToId` — the replacement's own detail page is where cancel/
 * reschedule become available again, not this one).
 */
export function SessionLifecycleActions({
  sessionId,
  date,
  startTime,
  endTime,
  locked,
  canCancel,
  canReschedule,
  roomSet,
}: {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  locked: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  roomSet: RoomSetProps;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();

  const [cancelState, cancelFormAction, cancelPending] = useActionState(cancelSessionAction, IDLE_SESSION_STATE);
  const [open, setOpen] = useState<"reschedule" | "rooms" | "cancel" | null>(null);
  // Each open mounts a fresh dialog, so a form never shows the last attempt.
  const [generation, setGeneration] = useState(0);
  function openDialog(kind: "reschedule" | "rooms") {
    setGeneration((current) => current + 1);
    setOpen(kind);
  }

  if (locked || (!canCancel && !canReschedule)) return null;

  return (
    <>
      {canReschedule ? (
        <>
          <ActionBarButton onClick={() => openDialog("reschedule")}>
            <CalendarClock className="size-4" aria-hidden />
            {t("reschedule")}
          </ActionBarButton>
          <ActionBarButton onClick={() => openDialog("rooms")}>
            <DoorOpen className="size-4" aria-hidden />
            {t("rooms")}
          </ActionBarButton>
        </>
      ) : null}
      {canCancel ? (
        <>
          <ActionBarButton variant="destructive" onClick={() => setOpen("cancel")}>
            <XCircle className="size-4" aria-hidden />
            {t("cancel")}
          </ActionBarButton>
          <DialogShell
            open={open === "cancel"}
            onOpenChange={(next) => setOpen(next ? "cancel" : null)}
            size="narrow"
            title={t("cancelTitle")}
            description={t("cancelBody")}
            formProps={{ action: cancelFormAction }}
            cancelLabel={t("cancelKeep")}
            submitLabel={t("cancelConfirm")}
            submitVariant="destructive"
            submitPending={cancelPending}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={sessionId} />
            {cancelState.error ? <FormMessage>{tErrors(cancelState.error)}</FormMessage> : null}
          </DialogShell>
        </>
      ) : null}
      {cancelState.error && open !== "cancel" ? (
        <div className="col-span-2 sm:basis-full">
          <FormMessage>{tErrors(cancelState.error)}</FormMessage>
        </div>
      ) : null}

      {generation > 0 ? (
        <>
          <RescheduleDialog
            key={`reschedule-${generation}`}
            open={open === "reschedule"}
            onOpenChange={(next) => setOpen(next ? "reschedule" : null)}
            sessionId={sessionId}
            date={date}
            startTime={startTime}
            endTime={endTime}
            roomSet={roomSet}
          />
          <SessionRoomsDialog
            key={`rooms-${generation}`}
            open={open === "rooms"}
            onOpenChange={(next) => setOpen(next ? "rooms" : null)}
            sessionId={sessionId}
            roomSet={roomSet}
          />
        </>
      ) : null}
    </>
  );
}

function FormErrors({ state }: { state: SessionActionState }) {
  const tErrors = useTranslations("Sessions.errors");
  if (state.error && !CONFLICT_ERRORS.has(state.error)) {
    return <FormMessage>{tErrors(state.error)}</FormMessage>;
  }
  return null;
}

function RescheduleDialog({
  open,
  onOpenChange,
  sessionId,
  date,
  startTime,
  endTime,
  roomSet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  roomSet: RoomSetProps;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();
  const [state, formAction, pending] = useActionState(rescheduleSessionAction, IDLE_SESSION_STATE);

  const [draft, setDraft] = useState({
    date,
    startTime,
    endTime,
    roomId: roomSet.roomId || null,
    extraRoomIds: roomSet.extraRoomIds,
  });
  const checkable = /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && isValidTimeRange(draft.startTime, draft.endTime);
  const conflicts = useSlotConflicts(
    checkable
      ? {
          kind: "session",
          locale,
          sessionId,
          date: draft.date,
          startTime: draft.startTime,
          endTime: draft.endTime,
          roomId: draft.roomId,
          extraRoomIds: draft.extraRoomIds,
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
      title={t("rescheduleTitle")}
      description={t("rescheduleDescription")}
      formProps={{ action: formAction, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("save")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="flex flex-col gap-4">
        <FormErrors state={state} />
        {state.status === "rescheduled" ? (
          <div className="flex flex-col gap-2">
            {state.conflicts && state.conflicts.length > 0 ? (
              <FormMessage tone="warning">
                {t("rescheduledWithConflict", { count: state.conflicts.length })}
              </FormMessage>
            ) : (
              <FormMessage tone="info">{t("rescheduled")}</FormMessage>
            )}
            {state.newSessionId ? (
              <Link
                href={ROUTES.centerSession(state.newSessionId)}
                className="text-sm font-medium text-brand hover:underline"
              >
                {t("viewNewSession")}
              </Link>
            ) : null}
          </div>
        ) : null}

        <DialogSections>
          <FormSection title={t("sections.when")} icon={<CalendarClock />}>
            <Field id="reschedule-date" label={t("fields.date")} error={fieldError("date")}>
              <DatePicker
                id="reschedule-date"
                name="date"
                defaultValue={date}
                onValueChange={(value: string) => setDraft((current) => ({ ...current, date: value }))}
                required
              />
            </Field>
            <TimeRangeFields
              idPrefix="reschedule-time"
              startLabel={t("fields.startTime")}
              endLabel={t("fields.endTime")}
              start={draft.startTime}
              end={draft.endTime}
              onChange={({ start, end }) => setDraft((current) => ({ ...current, startTime: start, endTime: end }))}
              error={fieldError("startTime") ?? fieldError("endTime")}
              required
            />
          </FormSection>

          <FormSection title={t("sections.rooms")} icon={<DoorOpen />}>
            <RoomSetPicker
              idPrefix="reschedule"
              rooms={roomSet.rooms}
              links={roomSet.roomLinks}
              defaultRoomId={roomSet.roomId}
              defaultExtraIds={roomSet.extraRoomIds}
              noneLabel={roomSet.noneLabel}
              roomError={fieldError("roomId")}
              extraError={fieldError("extraRoomIds")}
              onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
            />
          </FormSection>
        </DialogSections>

        <SlotConflictNotice
          idPrefix="reschedule"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}

function SessionRoomsDialog({
  open,
  onOpenChange,
  sessionId,
  roomSet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  roomSet: RoomSetProps;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const tCommon = useTranslations("Settings.common");
  const locale = useLocale();
  const [state, formAction, pending] = useActionState(updateSessionRoomsAction, IDLE_SESSION_STATE);
  const [draft, setDraft] = useState<{ roomId: string | null; extraRoomIds: string[] } | null>(null);
  const conflicts = useSlotConflicts(
    draft ? { kind: "session", locale, sessionId, ...draft } : null,
    state.error ? state : undefined,
  );
  const fieldError = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t("roomsTitle")}
      description={t("roomsHint")}
      formProps={{ action: formAction, noValidate: true }}
      cancelLabel={tCommon("cancel")}
      submitLabel={t("saveRooms")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="flex flex-col gap-4">
        <FormErrors state={state} />
        {state.status === "roomsUpdated" ? (
          <FormMessage tone={state.conflicts && state.conflicts.length > 0 ? "warning" : "success"}>
            {state.conflicts && state.conflicts.length > 0
              ? t("roomsSavedWithConflict", { count: state.conflicts.length })
              : t("roomsSaved")}
          </FormMessage>
        ) : null}

        <DialogSections>
          <FormSection title={t("sections.rooms")} icon={<DoorOpen />} wide>
            <RoomSetPicker
              idPrefix="session-rooms"
              rooms={roomSet.rooms}
              links={roomSet.roomLinks}
              defaultRoomId={roomSet.roomId}
              defaultExtraIds={roomSet.extraRoomIds}
              noneLabel={roomSet.noneLabel}
              roomError={fieldError("roomId")}
              extraError={fieldError("extraRoomIds")}
              onChange={setDraft}
            />
          </FormSection>
        </DialogSections>

        <SlotConflictNotice
          idPrefix="session-rooms"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}
