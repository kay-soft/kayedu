"use client";

import { startTransition } from "react";
import { KeyRound, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  createWorkspaceShareCodeAction,
  revokeWorkspaceShareCodeAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/share-code-actions";
import { useWorkspaceStudentMessage } from "@/components/teacher/workspaces/workspace-student-controls";
import { WorkspaceCodeReveal } from "@/components/workspaces/workspace-code-reveal";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DialogLauncher, DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_SHARE_CODE_STATE } from "@/lib/validation/workspace-share-codes";

/**
 * Teacher → Workspaces → Students, on an unlinked profile (W10, D-W43 item 2;
 * docs/04 §11.37): **Share code** — a confirmation, then the code once with
 * Copy code, Copy link and WhatsApp — and **Revoke code** while one is
 * active. The server decides owner, premium, archive and "still unlinked";
 * the code never comes back once the dialog closes.
 */

type Target = { workspaceId: string; studentProfileId: string; studentName: string };

export function ShareCodeButton({ hasActiveCode, ...target }: Target & { hasActiveCode: boolean }) {
  const t = useTranslations("WorkspaceStudents.shareCode");
  return (
    <DialogLauncher
      button={(open) => (
        <Button type="button" variant="outline" onClick={open} className="h-11 w-full px-4 sm:w-fit">
          <KeyRound className="size-4" aria-hidden />
          {t("share")}
        </Button>
      )}
      render={(dialog) => <ShareCodeDialog {...dialog} {...target} hasActiveCode={hasActiveCode} />}
    />
  );
}

function ShareCodeDialog({
  open,
  onOpenChange,
  workspaceId,
  studentProfileId,
  studentName,
  hasActiveCode,
}: Target & { open: boolean; onOpenChange: (open: boolean) => void; hasActiveCode: boolean }) {
  const t = useTranslations("WorkspaceStudents.shareCode");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction, pending] = useGuardedActionState(createWorkspaceShareCodeAction, IDLE_WORKSPACE_SHARE_CODE_STATE);

  if (state.status === "created" && state.code && state.expiresAt) {
    return (
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        size="narrow"
        title={t("createdTitle")}
        description={t("createdDescription", { name: studentName })}
        cancelLabel={t("done")}
      >
        <WorkspaceCodeReveal code={state.code} expiresAt={state.expiresAt} />
      </DialogShell>
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="narrow"
      title={t("title")}
      description={t("description", { name: studentName })}
      cancelLabel={t("cancel")}
      submitLabel={t("submit")}
      submitPending={pending}
      formProps={{
        noValidate: true,
        onSubmit: (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => formAction(formData));
        },
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="studentProfileId" value={studentProfileId} />
      <div className="flex flex-col gap-3">
        {state.error ? <FormMessage>{message(state.error)}</FormMessage> : null}
        {hasActiveCode ? <FormMessage tone="warning">{t("replaceWarning")}</FormMessage> : null}
        <p className="text-sm text-text-secondary">{t("howItWorks")}</p>
        <p className="text-xs text-text-muted">{t("expiryNote")}</p>
      </div>
    </DialogShell>
  );
}

/** "Revoke code" — only while a code is active; needs no premium (it only withdraws). */
export function RevokeShareCodeButton({
  workspaceId,
  studentProfileId,
  expiresLabel,
}: Omit<Target, "studentName"> & { expiresLabel: string }) {
  const t = useTranslations("WorkspaceStudents.shareCode");
  const message = useWorkspaceStudentMessage();
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(revokeWorkspaceShareCodeAction, IDLE_WORKSPACE_SHARE_CODE_STATE);
  useActionFeedback(state, { success: t("revoked"), error: (key) => message(key) ?? null });
  return (
    <ConfirmAction
      label={t("revoke")}
      icon={<X className="size-4" aria-hidden />}
      variant="outline"
      triggerClassName="h-11 w-full px-4 sm:w-fit"
      title={t("revokeTitle")}
      description={t("revokeDescription", { date: expiresLabel })}
      confirmLabel={t("revokeConfirm")}
      action={formAction}
      fields={{ locale, workspaceId, studentProfileId }}
    />
  );
}
