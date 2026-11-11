import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { weeklySlotsLine, workspaceClassLabel } from "@/components/teacher/workspaces/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getAssistantScope, scopeCan, scopeWorkspace } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import { workspaceClasses } from "@/lib/db/workspaces";
import { formatDayRange, formatMoney } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.workspaces");
  return { title: t("classesTitle") };
}

/**
 * One of the teacher's workspaces — its classes, read-only, for an assistant
 * with `classes.view` there (W8d, D-W41 item 9). The workspace is matched
 * among the teacher's own (`scopeWorkspace`); a swapped id is a 404. No class
 * form, no enrolment, no archive: the assistant never edits a class.
 */
export default async function AssistantWorkspaceClassesPage({ params }: { params: Promise<{ teacherId: string; id: string }> }) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const workspace = scopeWorkspace(scope, id);
  if (!workspace || !scopeCan(scope, "classes.view", workspace.centerId)) notFound();

  const [t, tClasses, locale] = await Promise.all([
    getTranslations("Assistants.work.workspaces"),
    getTranslations("Classes"),
    getLocale(),
  ]);
  const dayNames = tClasses.raw("dayNames") as string[];
  const classes = await workspaceClasses(prisma, workspace.centerId, todayInTimezone(workspace.zone));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={workspace.centerName}
        description={t("classesSubtitle")}
        back={{ href: ROUTES.assistantWorkspaces(teacherId), label: t("back") }}
        meta={<Badge variant="neutral">{t("private")}</Badge>}
        action={<LinkButton href={ROUTES.assistantWorkspaceSessions(teacherId, workspace.centerId)}>{t("sessions")}</LinkButton>}
      />
      {classes.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t("noClasses")} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {classes.map((row) => (
            <li key={row.id}>
              <Card className="h-full">
                <CardContent className="flex flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words text-sm font-semibold text-text-primary">
                      {workspaceClassLabel(locale, row, t("untitledClass"))}
                    </p>
                    {row.active ? null : <Badge variant="neutral">{t("inactive")}</Badge>}
                  </div>
                  <p className="text-xs text-text-secondary">{weeklySlotsLine(locale, dayNames, row.schedules)}</p>
                  <p className="text-xs text-text-muted">
                    {formatDayRange(row.startDate, row.endDate, locale)} · {formatMoney(row.price, locale)}
                  </p>
                  <LinkButton href={ROUTES.assistantWorkspaceClass(teacherId, workspace.centerId, row.id)} className="w-full sm:w-fit">
                    {t("openClass")}
                  </LinkButton>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
