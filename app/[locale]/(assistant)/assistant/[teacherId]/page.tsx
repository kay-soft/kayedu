import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AssistantPermissionList } from "@/components/assistants/assistant-permission-list";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantScope, scopeOpenWorkspaces } from "@/lib/auth/assistant-context";
import { Badge } from "@/components/ui/badge";
import { BriefcaseBusiness, Building2 } from "lucide-react";

import { formatDate } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.home");
  return { title: t("metaTitle") };
}

/**
 * The assistant's landing page (W7a, D-W36; W7b, D-W37; docs/04 §11.36): the
 * teacher's name, what the teacher granted, and the teacher's branches where
 * the assistant may work (those whose "Allow teacher assistants" is on) — or
 * "Not available at the teacher's branches" when none is — and (W8d, D-W41
 * item 10) the teacher's workspaces where a workspace permission applies,
 * tagged Private (Archived when read-only). The working pages
 * are in the nav, each shown only when it is granted somewhere. The name is
 * read only through an effective link of the session's user for this route's
 * teacher (the layout's gate, re-run here from the per-request cache).
 */
export default async function AssistantHomePage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const session = await getAssistantScope(teacherId);
  if (!session) notFound();
  const [t, tPresets, locale] = await Promise.all([
    getTranslations("Assistants.home"),
    getTranslations("Assistants.presets"),
    getLocale(),
  ]);
  const { link } = session;
  const workspaces = scopeOpenWorkspaces(session);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title", { teacher: link.teacherName })} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("permissionsTitle")}</CardTitle>
          <CardDescription>
            {t("permissionsDescription", {
              preset: tPresets(`${link.preset}.label`),
              date: formatDate(link.since, locale),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <AssistantPermissionList permissions={link.permissions} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("branchesTitle")}</CardTitle>
          <CardDescription>{t("branchesDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {session.branches.length === 0 ? (
            <EmptyState compact icon={<Building2 />} title={t("noBranches")} description={t("noBranchesHint")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {session.branches.map((branch) => (
                <li key={branch.centerId} className="flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-medium text-text-primary">
                  {branch.centerName}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {session.workspaces.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("workspacesTitle")}</CardTitle>
            <CardDescription>{t("workspacesDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {workspaces.length === 0 ? (
              <EmptyState compact icon={<BriefcaseBusiness />} title={t("noWorkspaces")} description={t("noWorkspacesHint")} />
            ) : (
              <ul className="flex flex-col gap-2">
                {workspaces.map((workspace) => (
                  <li
                    key={workspace.centerId}
                    className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary"
                  >
                    <span className="min-w-0 break-words">{workspace.centerName}</span>
                    <Badge variant="neutral">{t("private")}</Badge>
                    {workspace.archivedAt ? <Badge variant="neutral">{t("archived")}</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
