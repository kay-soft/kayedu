"use client";

import { startTransition, useState, type FormEvent } from "react";
import { Banknote, CalendarClock, Layers, Pencil, Plus, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createWorkspaceClassAction,
  updateWorkspaceClassAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/actions";
import { CatalogPickerFields } from "@/components/center/catalog-picker-fields";
import { ClassPeriodFields } from "@/components/center/class-period-fields";
import { SlotConflictNotice, useSlotConflicts } from "@/components/center/slot-conflict-notice";
import { WeeklyScheduleRows } from "@/components/center/weekly-schedule-rows";
import { useWorkspaceMessage } from "@/components/teacher/workspaces/use-workspace-message";
import { DialogLauncher, DialogSections, DialogShell, FormSection } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CatalogPickerData } from "@/lib/catalog-picker";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_STATE } from "@/lib/validation/workspaces";

/**
 * The workspace's New class / Edit class dialog (W8a, D-W38, docs/04
 * §11.37) — the branch class dialog's own sections and fields
 * (`CatalogPickerFields`, `ClassPeriodFields`, `WeeklyScheduleRows`, the
 * conflict notice), minus what a workspace never sets: the teacher (always
 * the owner, shown as a note), the rooms (one hidden room), the cut (forced
 * to 0, shown as a note), single-session booking and terms. The server
 * forces each of them whatever is posted.
 */

export type WorkspaceClassDefaults = {
  classId: string;
  educationSystemId: string;
  gradeId: string;
  subjectId: string;
  /** "123.00" — EGP as typed. */
  price: string;
  lateThresholdMinutes: string;
  startDate: string;
  endDate: string;
};

type Props = {
  workspaceId: string;
  catalog: CatalogPickerData;
  noneLabel: string;
  /** Present → Edit; absent → New. */
  defaults?: WorkspaceClassDefaults;
};

export function WorkspaceClassButton(props: Props) {
  const t = useTranslations("Workspaces.classes");
  const editing = Boolean(props.defaults);
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant={editing ? "outline" : "default"} onClick={open} className="h-11 w-full px-4 sm:w-fit">
          {editing ? <Pencil className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {editing ? t("edit") : t("new")}
        </Button>
      )}
      render={(dialog) => <WorkspaceClassDialog {...dialog} {...props} />}
    />
  );
}

function WorkspaceClassDialog({
  open,
  onOpenChange,
  workspaceId,
  catalog,
  noneLabel,
  defaults,
}: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Workspaces.classes");
  const tFields = useTranslations("Classes.fields");
  const tSections = useTranslations("Classes.sections");
  const tSync = useTranslations("Classes.sessionsSync");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const editing = Boolean(defaults);
  const [state, dispatch, pending] = useGuardedActionState(
    editing ? updateWorkspaceClassAction : createWorkspaceClassAction,
    IDLE_WORKSPACE_STATE,
  );
  const conflicts = useSlotConflicts(null, state);
  const [price, setPrice] = useState(defaults?.price ?? "0.00");
  const errors = state.fieldErrors ?? {};

  useActionFeedback(state, {
    success: (status, current) => {
      if (status !== "created" && status !== "saved") return null;
      onOpenChange(false);
      const created = current.sessions?.created ?? 0;
      return created > 0 ? tSync("created", { count: created }) : status === "created" ? t("created") : t("saved");
    },
  });

  // Keep everything typed after a refusal: submit through a transition, not
  // a `<form action>` that React would reset.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    if (conflicts.confirmed) formData.set("confirmConflicts", "on");
    startTransition(() => dispatch(formData));
  }

  const showBanner = state.error && state.error !== "conflictsNeedConfirmation" && state.error !== "scheduleConflict";

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("editTitle") : t("newTitle")}
      description={editing ? t("editDescription") : t("newDescription")}
      cancelLabel={t("cancel")}
      submitLabel={editing ? t("save") : t("create")}
      submitPending={pending}
      submitDisabled={conflicts.blocked}
      formProps={{ onSubmit: submit, noValidate: true }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {defaults ? <input type="hidden" name="classId" value={defaults.classId} /> : null}

      <div className="flex flex-col gap-4">
        {showBanner ? <FormMessage>{message(state.error)}</FormMessage> : null}

        <DialogSections>
          <FormSection title={tSections("basics")} icon={<Layers className="size-4" aria-hidden />} wide>
            <div className="grid gap-4 md:grid-cols-3">
              <CatalogPickerFields
                idPrefix="ws-class"
                data={catalog}
                noneLabel={noneLabel}
                defaultValues={defaults}
                errors={{
                  educationSystemId: message(errors.educationSystemId),
                  gradeId: message(errors.gradeId),
                  subjectId: message(errors.subjectId),
                }}
              />
            </div>
          </FormSection>

          <FormSection title={tSections("teacher")} icon={<UserRound className="size-4" aria-hidden />}>
            <p className="text-sm text-text-secondary">{t("teacherNote")}</p>
          </FormSection>

          <FormSection title={tSections("pricing")} icon={<Banknote className="size-4" aria-hidden />}>
            <div className="flex flex-col gap-4">
              <Field id="ws-class-price" label={tFields("price")} error={message(errors.price)}>
                <Input
                  id="ws-class-price"
                  name="price"
                  type="number"
                  dir="ltr"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  aria-invalid={errors.price ? true : undefined}
                />
              </Field>
              <p className="text-xs text-text-secondary">{t("cutNote")}</p>
            </div>
          </FormSection>

          <FormSection title={tSections("attendance")} icon={<CalendarClock className="size-4" aria-hidden />} wide>
            <div className="flex flex-col gap-4">
              <ClassPeriodFields
                idPrefix="ws-class"
                terms={[]}
                withTerms={false}
                defaultValue={{ startDate: defaults?.startDate ?? "", endDate: defaults?.endDate ?? "" }}
                startError={message(errors.startDate)}
                endError={message(errors.endDate)}
              />
              <Field
                id="ws-class-late"
                label={tFields("lateThreshold")}
                hint={tFields("lateThresholdHint")}
                error={message(errors.lateThresholdMinutes)}
              >
                <Input
                  id="ws-class-late"
                  name="lateThresholdMinutes"
                  type="number"
                  dir="ltr"
                  inputMode="numeric"
                  min={0}
                  max={240}
                  defaultValue={defaults?.lateThresholdMinutes ?? "10"}
                />
              </Field>
            </div>
          </FormSection>

          {editing ? null : (
            <FormSection title={tSections("schedule")} description={t("scheduleHint")} wide>
              <WeeklyScheduleRows idPrefix="ws-class-slots" error={message(errors.slots)} />
            </FormSection>
          )}
        </DialogSections>

        <SlotConflictNotice
          idPrefix="ws-class"
          conflicts={conflicts.conflicts}
          policy={conflicts.policy}
          confirmed={conflicts.confirmed}
          onConfirmedChange={conflicts.setConfirmed}
        />
      </div>
    </DialogShell>
  );
}
