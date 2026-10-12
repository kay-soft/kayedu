"use client";

import { useActionState, useState } from "react";
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
import { FormMessage } from "@/components/shared/form-message";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/shared/submit-button";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import type { RoomLinkPair } from "@/lib/rooms";
import { isValidTimeRange } from "@/lib/scheduling";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";

/** Errors `SlotConflictNotice` already explains — never shown twice. */
const CONFLICT_ERRORS = new Set(["conflict", "conflictsNeedConfirmation"]);

const BUTTON_CLASS =
  "inline-flex h-11 items-center rounded-lg border border-border px-3 text-xs font-medium text-text-secondary transition-ui focus-ring hover:border-border-strong hover:bg-surface-hover active:bg-surface-active";

type RoomSetProps = {
  rooms: RoomOption[];
  roomLinks: RoomLinkPair[];
  roomId: string;
  extraRoomIds: string[];
  noneLabel: string;
};

/**
 * Cancel / reschedule a session (spec §7 acceptance criterion 11, closing the
 * gap flagged since M5 — docs/02 §11), and — R3 — change the rooms this one
 * session uses. Cancelling never touches money or attendance rows (CLAUDE.md
 * rule 2); a manager who needs that too uses the roster's own void/correct
 * controls, unchanged. `canCancel`/`canReschedule` only hide controls — the
 * server actions re-check every permission.
 *
 * Reschedule copies the session's room set by default and may pick another
 * (primary + rooms linked to it); "Rooms" changes the set in place for this
 * session only — never the class's, so the class's enrolment cap is
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

  const [cancelState, cancelFormAction] = useActionState(
    cancelSessionAction,
    IDLE_SESSION_STATE,
  );
  const [open, setOpen] = useState<"reschedule" | "rooms" | null>(null);

  if (locked || (!canCancel && !canReschedule)) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {canReschedule ? (
          <>
            <button
              type="button"
              aria-expanded={open === "reschedule"}
              onClick={() => setOpen((current) => (current === "reschedule" ? null : "reschedule"))}
              className={BUTTON_CLASS}
            >
              {t("reschedule")}
            </button>
            <button
              type="button"
              aria-expanded={open === "rooms"}
              onClick={() => setOpen((current) => (current === "rooms" ? null : "rooms"))}
              className={BUTTON_CLASS}
            >
              {t("rooms")}
            </button>
          </>
        ) : null}
        {canCancel ? (
          <form action={cancelFormAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <SubmitButton variant="destructive">{t("cancel")}</SubmitButton>
          </form>
        ) : null}
      </div>
      {cancelState.error ? <FormMessage>{tErrors(cancelState.error)}</FormMessage> : null}

      {open === "reschedule" ? (
        <RescheduleForm
          sessionId={sessionId}
          date={date}
          startTime={startTime}
          endTime={endTime}
          roomSet={roomSet}
        />
      ) : null}
      {open === "rooms" ? <SessionRoomsForm sessionId={sessionId} roomSet={roomSet} /> : null}
    </div>
  );
}

function FieldErrorList({ state }: { state: SessionActionState }) {
  const tErrors = useTranslations("Sessions.errors");
  if (state.error && !CONFLICT_ERRORS.has(state.error)) {
    return <FormMessage>{tErrors(state.error)}</FormMessage>;
  }
  return null;
}

function RescheduleForm({
  sessionId,
  date,
  startTime,
  endTime,
  roomSet,
}: {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  roomSet: RoomSetProps;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(rescheduleSessionAction, IDLE_SESSION_STATE);

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
    <div className="flex flex-col gap-2">
      <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-col gap-1 text-xs text-text-secondary">
            <Label htmlFor="reschedule-date">{t("fields.date")}</Label>
            <DatePicker
              id="reschedule-date"
              name="date"
              defaultValue={date}
              onValueChange={(value: string) => setDraft((current) => ({ ...current, date: value }))}
              required
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="reschedule-start">{t("fields.startTime")}</Label>
            <Input
              id="reschedule-start"
              type="time"
              name="startTime"
              dir="ltr"
              value={draft.startTime}
              onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
              required
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="reschedule-end">{t("fields.endTime")}</Label>
            <Input
              id="reschedule-end"
              type="time"
              name="endTime"
              dir="ltr"
              value={draft.endTime}
              onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
              required
            />
          </div>
        </div>

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

        <SlotConflictNotice
          idPrefix="reschedule"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />

        <SubmitButton className="w-full sm:w-auto" disabled={conflicts.blocked}>
          {t("save")}
        </SubmitButton>
      </form>

      <FieldErrorList state={state} />
      {state.status === "rescheduled" ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

function SessionRoomsForm({
  sessionId,
  roomSet,
}: {
  sessionId: string;
  roomSet: RoomSetProps;
}) {
  const t = useTranslations("Sessions.lifecycle");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(updateSessionRoomsAction, IDLE_SESSION_STATE);
  const [draft, setDraft] = useState<{ roomId: string | null; extraRoomIds: string[] } | null>(
    null,
  );
  const conflicts = useSlotConflicts(
    draft ? { kind: "session", locale, sessionId, ...draft } : null,
    state.error ? state : undefined,
  );
  const fieldError = (name: string) =>
    state.fieldErrors?.[name] ? tErrors(state.fieldErrors[name]) : undefined;

  return (
    <div className="flex flex-col gap-2">
      <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <p className="text-xs text-text-muted">{t("roomsHint")}</p>
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
        <SlotConflictNotice
          idPrefix="session-rooms"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
        <SubmitButton className="w-full sm:w-auto" disabled={conflicts.blocked}>
          {t("saveRooms")}
        </SubmitButton>
      </form>
      <FieldErrorList state={state} />
      {state.status === "roomsUpdated" ? (
        <FormMessage tone={state.conflicts && state.conflicts.length > 0 ? "warning" : "success"}>
          {state.conflicts && state.conflicts.length > 0
            ? t("roomsSavedWithConflict", { count: state.conflicts.length })
            : t("roomsSaved")}
        </FormMessage>
      ) : null}
    </div>
  );
}
