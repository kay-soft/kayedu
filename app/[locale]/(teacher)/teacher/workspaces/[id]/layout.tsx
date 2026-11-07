import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Archive, Lock } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { WorkspaceTabs } from "@/components/teacher/workspaces/workspace-tabs";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { isPremium } from "@/lib/auth/premium";
import { getWorkspaceContext } from "@/lib/auth/workspace-context";
import { ROUTES } from "@/lib/routes";

/**
 * One PERSONAL workspace (W8a, D-W38 items 10 and 12; docs/04 §11.37). The
 * workspace is resolved for its **owner** only (`getWorkspaceContext`) — any
 * other account, and any id that is not a live workspace, is not-found — and
 * every section below reads under that context. Read-only states are shown
 * once, here: lapsed premium ("renew premium to make changes", D-W15) and
 * archived (D-W28). Each section hides its write controls in either state, and
 * the server refuses the write anyway.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const t = await getTranslations("Workspaces.workspace");
  const lapsed = !isPremium(ctx.user);
  const archived = ctx.workspace.archivedAt !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={ctx.center.name}
        back={{ href: ROUTES.teacherWorkspaces, label: t("back") }}
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant={archived ? "neutral" : "success"}>{archived ? t("statusArchived") : t("statusActive")}</Badge>
            {lapsed || archived ? <Badge variant="warning">{t("readOnlyBadge")}</Badge> : null}
          </div>
        }
      />

      {lapsed ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg/60 p-4 text-sm text-text-primary">
          <Lock className="mt-0.5 size-5 shrink-0 text-warning-fg" aria-hidden />
          <p>{t("lapsedBanner")}</p>
        </div>
      ) : null}
      {archived ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-surface-subtle p-4 text-sm text-text-primary">
          <Archive className="mt-0.5 size-5 shrink-0 text-text-muted" aria-hidden />
          <p>{t("archivedBanner")}</p>
        </div>
      ) : null}

      <WorkspaceTabs workspaceId={ctx.center.id} />
      {children}
    </div>
  );
}
