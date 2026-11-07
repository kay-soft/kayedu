"use client";

import { startTransition, useState, type FormEvent } from "react";
import { Plus, Power, PowerOff, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  addWorkspaceSlotAction,
  deleteWorkspaceClassAction,
  removeWorkspaceSlotAction,
  setWorkspaceClassActiveAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/actions";
import { SlotConflictNotice, useSlotConflicts } from "@/components/center/slot-conflict-notice";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { useWorkspaceMessage } from "@/components/teacher/workspaces/use-workspace-message";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_STATE, type WorkspaceActionState } from "@/lib/validation/workspaces";

/**
 * A workspace class page's controls (W8a, docs/04 §11.37): add or remove a
 * weekly slot (each resyncs the class's future sessions — the engine's
 * `writeClassSlot`), deactivate / reactivate (the R4 rules) and delete (only
 * a class that never ran). A WARN conflict comes back with its list and the
 * one "I understand" tick, as at a branch.
 */

function useSessionsMessage() {
  const tSync = useTranslations("Classes.sessionsSync");
  return (state: WorkspaceActionState, fallback: string): string => {
    const parts: string[] = [];
    if (state.sessions?.created) parts.push(tSync("created", { count: state.sessions.created }));
    if (state.sessions?.deleted) parts.push(tSync("deleted", { count: state.sessions.deleted }));
    if (state.sessions?.cancelled) parts.push(tSync("cancelled", { count: state.sessions.cancelled }));
    return parts.length > 0 ? parts.join(" · ") : fallback;
  };
}

export function AddSlotForm({ workspaceId, classId }: { workspaceId: string; classId: string }) {
  const t = useTranslations("Classes.schedule");
  const tDays = useTranslations("Classes");
  const message = useWorkspaceMessage();
  const sessionsMessage = useSessionsMessage();
  const locale = useLocale();
  const dayNames = tDays.raw("dayNames") as string[];
  const [state, dispatch, pending] = useGuardedActionState(addWorkspaceSlotAction, IDLE_WORKSPACE_STATE);
  const conflicts = useSlotConflicts(null, state);
  const [formKey, setFormKey] = useState(0);
  useActionFeedback(state, {
    success: (status, current) => {
      if (status !== "created") return null;
      setFormKey((key) => key + 1);
      return sessionsMessage(current, t("save"));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  const errors = state.fieldErrors ?? {};
  const showBanner = state.error && state.error !== "conflictsNeedConfirmation" && state.error !== "scheduleConflict";
  return (
    <form key={formKey} onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-xl border border-border p-3 sm:p-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="classId" value={classId} />
      {showBanner ? <FormMessage>{message(state.error)}</FormMessage> : null}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-start">
        <Field id="ws-slot-day" label={t("day")} error={message(errors.dayOfWeek)}>
          <Select id="ws-slot-day" name="dayOfWeek" defaultValue="6">
            {dayNames.map((day, index) => (
              <option key={day} value={String(index)}>
                {day}
              </option>
            ))}
          </Select>
        </Field>
        <TimeRangeFields
          idPrefix="ws-slot"
          startLabel={t("start")}
          endLabel={t("end")}
          error={message(errors.endTime ?? errors.startTime)}
          required
        />
      </div>
      <SlotConflictNotice
        idPrefix="ws-slot"
        conflicts={conflicts.conflicts}
        policy={conflicts.policy}
        confirmed={conflicts.confirmed}
        onConfirmedChange={conflicts.setConfirmed}
      />
      <Button type="submit" disabled={pending || conflicts.blocked} className="h-11 w-full px-4 sm:w-fit">
        <Plus className="size-4" aria-hidden />
        {t("addSlot")}
      </Button>
    </form>
  );
}

export function RemoveSlotButton({ workspaceId, scheduleId, label }: { workspaceId: string; scheduleId: string; label: string }) {
  const t = useTranslations("Workspaces.classes");
  const message = useWorkspaceMessage();
  const sessionsMessage = useSessionsMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(removeWorkspaceSlotAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, {
    success: (_status, current) => sessionsMessage(current, t("slotRemoved")),
    error: (key) => message(key) ?? null,
  });
  return (
    <ConfirmAction
      label={label}
      icon={<X className="size-4" aria-hidden />}
      iconOnly
      triggerClassName="size-11"
      title={t("removeSlotTitle")}
      description={t("removeSlotDescription")}
      confirmLabel={t("removeSlotConfirm")}
      action={formAction}
      fields={{ locale, workspaceId, scheduleId, confirmConflicts: "on" }}
    />
  );
}

/** Deactivate (confirmed) or reactivate (with the conflict contract) one class. */
export function ClassActiveControl({ workspaceId, classId, active }: { workspaceId: string; classId: string; active: boolean }) {
  const t = useTranslations("Workspaces.classes");
  const message = useWorkspaceMessage();
  const sessionsMessage = useSessionsMessage();
  const locale = useLocale();
  const [state, dispatch, pending] = useGuardedActionState(setWorkspaceClassActiveAction, IDLE_WORKSPACE_STATE);
  const conflicts = useSlotConflicts(null, state);
  useActionFeedback(state, {
    success: (_status, current) => sessionsMessage(current, active ? t("deactivated") : t("reactivated")),
    error: (key) => (key === "conflictsNeedConfirmation" || key === "scheduleConflict" ? null : (message(key) ?? null)),
  });

  if (active) {
    return (
      <ConfirmAction
        label={t("deactivate")}
        icon={<PowerOff className="size-4" aria-hidden />}
        variant="outline"
        triggerClassName="h-11 w-full px-4 sm:w-fit"
        title={t("deactivateTitle")}
        description={t("deactivateDescription")}
        confirmLabel={t("deactivate")}
        action={dispatch}
        fields={{ locale, workspaceId, classId, active: "false" }}
      />
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => dispatch(new FormData(event.currentTarget)));
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="classId" value={classId} />
      <input type="hidden" name="active" value="true" />
      <SlotConflictNotice
        idPrefix={`ws-reactivate-${classId}`}
        conflicts={conflicts.conflicts}
        policy={conflicts.policy}
        confirmed={conflicts.confirmed}
        onConfirmedChange={conflicts.setConfirmed}
      />
      <Button type="submit" variant="outline" disabled={pending || conflicts.blocked} className="h-11 w-full px-4 sm:w-fit">
        <Power className="size-4" aria-hidden />
        {t("reactivate")}
      </Button>
    </form>
  );
}

export function DeleteClassButton({ workspaceId, classId }: { workspaceId: string; classId: string }) {
  const t = useTranslations("Workspaces.classes");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(deleteWorkspaceClassAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, { error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("delete")}
      icon={<Trash2 className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("deleteTitle")}
      description={t("deleteDescription")}
      action={formAction}
      fields={{ locale, workspaceId, classId }}
    />
  );
}
