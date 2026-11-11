"use client";

import { Check, UserPlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  acceptWorkspaceInvitationAction,
  declineWorkspaceInvitationAction,
} from "@/app/[locale]/(auth)/workspace-invitation-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_WORKSPACE_STUDENT_STATE } from "@/lib/validation/workspace-students";

/**
 * A workspace invitation on the hub (W8b, D-W39 item 7; docs/04 §11.37): the
 * teacher's name and the workspace's name, **Confirm** and **Cancel**, two
 * 44px buttons, full width below `sm`. Confirm links the teacher's student
 * record to this account and opens the calendar; Cancel declines it (the
 * record stays unlinked) and the card says so in place.
 */
export function WorkspaceInvitationCard({
  invitationId,
  teacherName,
  workspaceName,
}: {
  invitationId: string;
  teacherName: string;
  workspaceName: string;
}) {
  const t = useTranslations("WorkspaceStudents.invitation");
  const tErrors = useTranslations("WorkspaceStudents.errors");
  const locale = useLocale();
  const [acceptState, accept, accepting] = useGuardedActionState(acceptWorkspaceInvitationAction, IDLE_WORKSPACE_STUDENT_STATE);
  const [declineState, decline, declining] = useGuardedActionState(declineWorkspaceInvitationAction, IDLE_WORKSPACE_STUDENT_STATE);
  const errorText = (key: string) => (tErrors.has(key) ? tErrors(key) : tErrors("invitationGone"));
  useActionFeedback(acceptState, { success: t("accepted"), error: errorText });
  useActionFeedback(declineState, { success: t("declined"), error: errorText });
  const pending = accepting || declining;

  if (declineState.status === "declined") {
    return (
      <p role="status" className="rounded-xl border border-border bg-surface-subtle p-3 text-sm text-text-secondary sm:p-4">
        {t("declinedInPlace", { workspace: workspaceName })}
      </p>
    );
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-bg/40 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-warning-bg text-warning-fg">
          <UserPlus className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <Badge variant="warning">{t("badge")}</Badge>
          <p className="mt-1 break-words text-sm font-semibold text-text-primary">
            {t("title", { teacher: teacherName, workspace: workspaceName })}
          </p>
          <p className="mt-1 text-xs text-text-secondary">{t("body")}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:flex sm:justify-end">
        <form action={decline}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button type="submit" variant="outline" disabled={pending} className="h-11 w-full px-4 sm:w-auto">
            <X className="size-4" aria-hidden />
            {t("cancel")}
          </Button>
        </form>
        <form action={accept}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button type="submit" disabled={pending} className="h-11 w-full px-4 sm:w-auto">
            <Check className="size-4" aria-hidden />
            {t("confirm")}
          </Button>
        </form>
      </div>
    </article>
  );
}
