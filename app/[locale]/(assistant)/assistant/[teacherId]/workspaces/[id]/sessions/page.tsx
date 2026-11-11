import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { WorkspaceSessionList } from "@/components/teacher/workspaces/workspace-session-list";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { getAssistantScope, scopeCan, scopeWorkspace } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import { workspaceSessions } from "@/lib/db/workspaces";
import { ROUTES } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.workspaces");
  return { title: t("sessionsTitle") };
}

/**
 * A workspace's sessions for the assistant (W8d, D-W41 item 10): from the
 * assistant's floor (the teacher's `teacherHistoryDays`, D-W19), each opening
 * its session page — read-only rows with no reschedule, cancel or delete (an
 * assistant never edits a session). Open to any of `classes.view`,
 * `checkin.workspace` and `payments.workspace` there (`scopeWorkspace`).
 */
export default async function AssistantWorkspaceSessionsPage({ params }: { params: Promise<{ teacherId: string; id: string }> }) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const workspace = scopeWorkspace(scope, id);
  if (!workspace) notFound();
  const t = await getTranslations("Assistants.work.workspaces");
  const rows = await workspaceSessions(prisma, workspace.centerId, { from: workspace.floor });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={workspace.centerName}
        description={t("sessionsSubtitle")}
        back={{ href: ROUTES.assistantWorkspaces(teacherId), label: t("back") }}
        meta={<Badge variant="neutral">{t("private")}</Badge>}
        action={
          scopeCan(scope, "classes.view", workspace.centerId) ? (
            <LinkButton href={ROUTES.assistantWorkspace(teacherId, workspace.centerId)}>{t("classes")}</LinkButton>
          ) : undefined
        }
      />
      <WorkspaceSessionList
        workspaceId={workspace.centerId}
        rows={rows}
        timeZone={workspace.zone}
        todayIso={dateKey(todayInTimezone(workspace.zone))}
        writable={false}
        sessionHref={(sessionId) => ROUTES.assistantWorkspaceSession(teacherId, workspace.centerId, sessionId)}
      />
    </div>
  );
}
