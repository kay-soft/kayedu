"use client";

import { startTransition, useState, type FormEvent } from "react";
import { Ban, CalendarPlus, CalendarSync, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  cancelWorkspaceSessionAction,
  createWorkspaceSessionAction,
  deleteWorkspaceSessionAction,
  rescheduleWorkspaceSessionAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/actions";
import { SlotConflictNotice, useSlotConflicts } from "@/components/center/slot-conflict-notice";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { useWorkspaceMessage } from "@/components/teacher/workspaces/use-workspace-message";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_STATE } from "@/lib/validation/workspaces";

/**
 * A workspace's session controls (W8a, docs/04 §11.37) — the engine's own
 * rules for each verb: a new session (an extra one for a class, or a
 * one-time session with a title and a price and the forced 0 cut),
 * reschedule (a new session, the original kept and linked — M15), cancel
 * (refused once it has records it cannot drop) and delete (an extra or
 * one-time session that never ran). The workspace's conflict policy is WARN:
 * a clash is listed and needs the one tick.
 */

export type WorkspaceClassOption = { id: string; label: string };

function dialogBanner(error: string | undefined): boolean {
  return Boolean(error) && error !== "conflictsNeedConfirmation" && error !== "scheduleConflict";
}

export function NewWorkspaceSessionButton({
  workspaceId,
  classes,
  todayIso,
  defaultClassId,
}: {
  workspaceId: string;
  classes: WorkspaceClassOption[];
  todayIso: string;
  defaultClassId?: string;
}) {
  const t = useTranslations("Workspaces.sessions");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant={defaultClassId ? "outline" : "default"} onClick={open} className="h-11 w-full px-4 sm:w-fit">
          <CalendarPlus className="size-4" aria-hidden />
          {defaultClassId ? t("addExtra") : t("new")}
        </Button>
      )}
      render={(dialog) => (
        <NewSessionDialog {...dialog} workspaceId={workspaceId} classes={classes} todayIso={todayIso} defaultClassId={defaultClassId} />
      )}
    />
  );
}

function NewSessionDialog({
  open,
  onOpenChange,
  workspaceId,
  classes,
  todayIso,
  defaultClassId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  classes: WorkspaceClassOption[];
  todayIso: string;
  defaultClassId?: string;
}) {
  const t = useTranslations("Workspaces.sessions");
  const tFields = useTranslations("Classes.fields");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [kind, setKind] = useState<"extra" | "oneOff">(defaultClassId || classes.length > 0 ? "extra" : "oneOff");
  const [state, dispatch, pending] = useGuardedActionState(createWorkspaceSessionAction, IDLE_WORKSPACE_STATE);
  const conflicts = useSlotConflicts(null, state);
  const errors = state.fieldErrors ?? {};
  useActionFeedback(state, {
    success: (status) => {
      if (status !== "created") return null;
      onOpenChange(false);
      return t("created");
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("newTitle")}
      description={t("newDescription")}
      cancelLabel={t("cancel")}
      submitLabel={t("create")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
      formProps={{ onSubmit: submit, noValidate: true }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="kind" value={kind} />
      <div className="flex flex-col gap-4">
        {dialogBanner(state.error) ? <FormMessage>{message(state.error)}</FormMessage> : null}
        {defaultClassId ? (
          <input type="hidden" name="classId" value={defaultClassId} />
        ) : (
          <Field id="ws-session-kind" label={t("kind")}>
            <Select id="ws-session-kind" value={kind} onValueChange={(value) => setKind(value === "oneOff" ? "oneOff" : "extra")}>
              {classes.length > 0 ? <option value="extra">{t("kindExtra")}</option> : null}
              <option value="oneOff">{t("kindOneOff")}</option>
            </Select>
          </Field>
        )}
        {!defaultClassId && kind === "extra" ? (
          <Field id="ws-session-class" label={t("class")} error={message(errors.classId)}>
            <Select id="ws-session-class" name="classId" defaultValue={classes[0]?.id ?? ""}>
              {classes.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {kind === "oneOff" ? (
          <>
            <Field id="ws-session-title" label={t("titleField")} error={message(errors.title)}>
              <Input id="ws-session-title" name="title" maxLength={120} required autoComplete="off" />
            </Field>
            <Field id="ws-session-price" label={tFields("price")} hint={t("cutNote")} error={message(errors.price)}>
              <Input id="ws-session-price" name="price" type="number" dir="ltr" inputMode="decimal" min={0} step="0.01" defaultValue="0.00" />
            </Field>
          </>
        ) : null}
        <Field id="ws-session-date" label={t("date")} error={message(errors.date)}>
          <DatePicker id="ws-session-date" name="date" todayIso={todayIso} required />
        </Field>
        <TimeRangeFields
          idPrefix="ws-session"
          startLabel={t("start")}
          endLabel={t("end")}
          error={message(errors.endTime ?? errors.startTime)}
          required
        />
        <SlotConflictNotice
          idPrefix="ws-session"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}

export function RescheduleWorkspaceSessionButton({
  workspaceId,
  sessionId,
  todayIso,
  defaults,
}: {
  workspaceId: string;
  sessionId: string;
  todayIso: string;
  defaults: { date: string; startTime: string; endTime: string };
}) {
  const t = useTranslations("Workspaces.sessions");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant="outline" onClick={open} className="h-11 w-full px-4 sm:w-fit">
          <CalendarSync className="size-4" aria-hidden />
          {t("reschedule")}
        </Button>
      )}
      render={(dialog) => (
        <RescheduleDialog {...dialog} workspaceId={workspaceId} sessionId={sessionId} todayIso={todayIso} defaults={defaults} />
      )}
    />
  );
}

function RescheduleDialog({
  open,
  onOpenChange,
  workspaceId,
  sessionId,
  todayIso,
  defaults,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  sessionId: string;
  todayIso: string;
  defaults: { date: string; startTime: string; endTime: string };
}) {
  const t = useTranslations("Workspaces.sessions");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, dispatch, pending] = useGuardedActionState(rescheduleWorkspaceSessionAction, IDLE_WORKSPACE_STATE);
  const conflicts = useSlotConflicts(null, state);
  const errors = state.fieldErrors ?? {};
  useActionFeedback(state, {
    success: (status) => {
      if (status !== "rescheduled") return null;
      onOpenChange(false);
      return t("rescheduled");
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("rescheduleTitle")}
      description={t("rescheduleDescription")}
      cancelLabel={t("cancel")}
      submitLabel={t("reschedule")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
      formProps={{ onSubmit: submit, noValidate: true }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <div className="flex flex-col gap-4">
        {dialogBanner(state.error) ? <FormMessage>{message(state.error)}</FormMessage> : null}
        <Field id={`ws-reschedule-date-${sessionId}`} label={t("date")} error={message(errors.date)}>
          <DatePicker id={`ws-reschedule-date-${sessionId}`} name="date" defaultValue={defaults.date} todayIso={todayIso} required />
        </Field>
        <TimeRangeFields
          idPrefix={`ws-reschedule-${sessionId}`}
          startLabel={t("start")}
          endLabel={t("end")}
          defaultStart={defaults.startTime}
          defaultEnd={defaults.endTime}
          error={message(errors.endTime ?? errors.startTime)}
          required
        />
        <SlotConflictNotice
          idPrefix={`ws-reschedule-${sessionId}`}
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}

export function CancelWorkspaceSessionButton({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const t = useTranslations("Workspaces.sessions");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(cancelWorkspaceSessionAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, { success: t("cancelled"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("cancelSession")}
      icon={<Ban className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("cancelTitle")}
      description={t("cancelDescription")}
      confirmLabel={t("cancelSession")}
      action={formAction}
      fields={{ locale, workspaceId, sessionId }}
    />
  );
}

export function DeleteWorkspaceSessionButton({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const t = useTranslations("Workspaces.sessions");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(deleteWorkspaceSessionAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, { success: t("deleted"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("delete")}
      icon={<Trash2 className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("deleteTitle")}
      description={t("deleteDescription")}
      action={formAction}
      fields={{ locale, workspaceId, sessionId }}
    />
  );
}
