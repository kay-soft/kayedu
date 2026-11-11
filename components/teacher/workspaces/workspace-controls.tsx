"use client";

import { Archive, ArchiveRestore, Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  archiveWorkspaceAction,
  createWorkspaceAction,
  renameWorkspaceAction,
  unarchiveWorkspaceAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/actions";
import { useWorkspaceMessage } from "@/components/teacher/workspaces/use-workspace-message";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_STATE, WORKSPACE_NAME_MAX_LENGTH } from "@/lib/validation/workspaces";

/**
 * The workspace-level controls (W8a, D-W38, docs/04 §11.37): New workspace,
 * Rename, Archive and Unarchive. Each posts to `./actions.ts`; the server
 * decides ownership, premium, the archive flag and the 100 cap.
 */

/** "New workspace" — a name, then the new workspace's own page. */
export function NewWorkspaceButton({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const t = useTranslations("Workspaces.list");
  return (
    <div className="flex flex-col gap-1.5">
      <DialogLauncher
        button={(open) => (
          <Button
            type="button"
            onClick={open}
            disabled={disabled}
            aria-describedby={disabled && disabledReason ? "new-workspace-reason" : undefined}
            className="h-11 w-full px-4 sm:w-fit"
          >
            <Plus className="size-4" aria-hidden />
            {t("new")}
          </Button>
        )}
        render={(dialog) => <NewWorkspaceDialog {...dialog} />}
      />
      {disabled && disabledReason ? (
        <p id="new-workspace-reason" className="text-xs text-text-secondary">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

function NewWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Workspaces.create");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(createWorkspaceAction, IDLE_WORKSPACE_STATE);
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title")}
      description={t("description")}
      cancelLabel={t("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      formProps={{ action: formAction }}
    >
      <input type="hidden" name="locale" value={locale} />
      <div className="flex flex-col gap-4">
        {state.error ? <FormMessage>{message(state.error, state.errorValues)}</FormMessage> : null}
        <Field id="workspace-name" label={t("name")} hint={t("nameHint")} error={message(state.fieldErrors?.name)}>
          <Input id="workspace-name" name="name" required maxLength={WORKSPACE_NAME_MAX_LENGTH} autoComplete="off" />
        </Field>
      </div>
    </DialogShell>
  );
}

/** Settings → Name. */
export function RenameWorkspaceForm({
  workspaceId,
  name,
  disabled,
}: {
  workspaceId: string;
  name: string;
  disabled: boolean;
}) {
  const t = useTranslations("Workspaces.settings");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(renameWorkspaceAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, { success: t("renamed") });
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {state.error ? <FormMessage>{message(state.error)}</FormMessage> : null}
      <Field id="workspace-rename" label={t("name")} error={message(state.fieldErrors?.name)}>
        <Input
          id="workspace-rename"
          name="name"
          defaultValue={name}
          required
          maxLength={WORKSPACE_NAME_MAX_LENGTH}
          disabled={disabled}
          autoComplete="off"
        />
      </Field>
      <Button type="submit" disabled={disabled || pending} className="h-11 w-full px-5 sm:w-fit">
        {t("save")}
      </Button>
    </form>
  );
}

/** Settings → Archive, confirmed. Never needs premium. */
export function ArchiveWorkspaceButton({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("Workspaces.settings");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(archiveWorkspaceAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, { success: t("archived"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("archive")}
      icon={<Archive className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("archiveTitle")}
      description={t("archiveDescription")}
      confirmLabel={t("archiveConfirm")}
      action={formAction}
      fields={{ locale, workspaceId }}
    />
  );
}

/** Settings → Unarchive, confirmed. Needs premium and a free slot under the cap. */
export function UnarchiveWorkspaceButton({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const t = useTranslations("Workspaces.settings");
  const message = useWorkspaceMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(unarchiveWorkspaceAction, IDLE_WORKSPACE_STATE);
  useActionFeedback(state, {
    success: t("unarchived"),
    error: (key, current) => message(key, current.errorValues) ?? null,
  });
  return (
    <ConfirmAction
      label={t("unarchive")}
      icon={<ArchiveRestore className="size-4" aria-hidden />}
      variant="outline"
      tone="default"
      disabled={disabled}
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("unarchiveTitle")}
      description={t("unarchiveDescription")}
      confirmLabel={t("unarchiveConfirm")}
      action={formAction}
      fields={{ locale, workspaceId }}
    />
  );
}
