import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefcaseBusiness } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getAssistantScope, scopeCan, scopeOpenWorkspaces } from "@/lib/auth/assistant-context";
import { ROUTES } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.workspaces");
  return { title: t("title") };
}

/**
 * The teacher's PERSONAL workspaces, for their assistant (W8d, D-W41 items 9,
 * 10; docs/04 §11.36): each one where the assistant holds `classes.view`,
 * `checkin.workspace` or `payments.workspace` (`assistantCan` — the grant and
 * the teacher's own workspace capability). Built from the teacher's id alone
 * (`resolveAssistantActing`); another teacher's workspace never appears.
 * Read-only here: no create, rename, archive, students or settings — ever.
 */
export default async function AssistantWorkspacesPage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const workspaces = scopeOpenWorkspaces(scope);
  if (workspaces.length === 0) notFound();
  const t = await getTranslations("Assistants.work.workspaces");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { teacher: scope.link.teacherName })} />
      <ul className="grid gap-4 md:grid-cols-2">
          {workspaces.map((workspace) => (
            <li key={workspace.centerId}>
              <Card className="h-full">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <BriefcaseBusiness className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <p className="min-w-0 break-words text-sm font-semibold text-text-primary">{workspace.centerName}</p>
                    <Badge variant="neutral">{t("private")}</Badge>
                    {workspace.archivedAt ? <Badge variant="neutral">{t("archived")}</Badge> : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    {scopeCan(scope, "classes.view", workspace.centerId) ? (
                      <LinkButton href={ROUTES.assistantWorkspace(teacherId, workspace.centerId)} className="w-full sm:w-fit">
                        {t("classes")}
                      </LinkButton>
                    ) : null}
                    <LinkButton href={ROUTES.assistantWorkspaceSessions(teacherId, workspace.centerId)} className="w-full sm:w-fit">
                      {t("sessions")}
                    </LinkButton>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
      </ul>
    </div>
  );
}
