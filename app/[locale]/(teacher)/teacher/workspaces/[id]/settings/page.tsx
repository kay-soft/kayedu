import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ArchiveWorkspaceButton,
  RenameWorkspaceForm,
  UnarchiveWorkspaceButton,
} from "@/components/teacher/workspaces/workspace-controls";
import { PageSection } from "@/components/shared/page-section";
import { Card, CardContent } from "@/components/ui/card";
import { isPremium } from "@/lib/auth/premium";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { prisma } from "@/lib/db/client";
import { WORKSPACE_ACTIVE_CAP, countActiveWorkspaces } from "@/lib/db/workspaces";
import { formatNumber } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Workspaces.settings");
  return { title: t("title") };
}

/**
 * A workspace's Settings (W8a, D-W38 items 5, 6 and 10): its name, and
 * Archive / Unarchive, each confirmed. Archive is offered whatever the
 * premium state — reducing what is active is never gated. Unarchive needs
 * premium and a free slot under the 100 cap; the server re-counts under the
 * teacher's lock.
 */
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const [t, locale] = await Promise.all([getTranslations("Workspaces.settings"), getLocale()]);
  const archived = ctx.workspace.archivedAt !== null;
  const premium = isPremium(ctx.user);
  const active = archived ? await countActiveWorkspaces(prisma, ctx.user.id) : 0;
  const full = active >= WORKSPACE_ACTIVE_CAP;

  return (
    <div className="flex flex-col gap-6">
      <PageSection title={t("nameTitle")} description={t("nameDescription")}>
        <Card>
          <CardContent>
            <RenameWorkspaceForm workspaceId={ctx.center.id} name={ctx.center.name} disabled={!workspaceOffersWrites(ctx)} />
          </CardContent>
        </Card>
      </PageSection>

      <PageSection title={archived ? t("unarchiveSection") : t("archiveSection")}>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-text-secondary">{archived ? t("unarchiveHelp") : t("archiveHelp")}</p>
            {archived ? (
              <>
                <UnarchiveWorkspaceButton workspaceId={ctx.center.id} disabled={!premium || full} />
                {!premium ? <p className="text-xs text-text-secondary">{t("unarchivePremium")}</p> : null}
                {premium && full ? (
                  <p className="text-xs text-text-secondary">
                    {t("unarchiveFull", { active: formatNumber(active, locale), max: formatNumber(WORKSPACE_ACTIVE_CAP, locale) })}
                  </p>
                ) : null}
              </>
            ) : (
              <ArchiveWorkspaceButton workspaceId={ctx.center.id} />
            )}
          </CardContent>
        </Card>
      </PageSection>
    </div>
  );
}
