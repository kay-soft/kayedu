import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { workspaceClassLabel } from "@/components/teacher/workspaces/labels";
import { NewWorkspaceSessionButton } from "@/components/teacher/workspaces/workspace-session-controls";
import { WorkspaceSessionList } from "@/components/teacher/workspaces/workspace-session-list";
import { PageSection } from "@/components/shared/page-section";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { prisma } from "@/lib/db/client";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { workspaceClasses, workspaceSessions } from "@/lib/db/workspaces";
import { centreTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Workspaces.sessions");
  return { title: t("title") };
}

/**
 * A workspace's Sessions (W8a, D-W38 items 7 and 10): every session, from
 * the teacher's own history window on, oldest first — the generated weekly
 * sessions, extra ones and one-time ones — with Reschedule, Cancel and Delete
 * where the engine allows them. Never in the teacher's All-branches lists or
 * calendar (D-W38 item 9; backlog).
 */
export default async function WorkspaceSessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const [t, locale] = await Promise.all([getTranslations("Workspaces.sessions"), getLocale()]);
  const timeZone = centreTimeZone(ctx.settings);
  const today = todayInTimezone(timeZone);
  const writable = workspaceOffersWrites(ctx);
  const [rows, classes] = await Promise.all([
    workspaceSessions(prisma, ctx.center.id, { from: teacherPortalHistoryFloor(ctx) }),
    writable ? workspaceClasses(prisma, ctx.center.id, today) : Promise.resolve([]),
  ]);
  const options = classes
    .filter((row) => row.active)
    .map((row) => ({ id: row.id, label: workspaceClassLabel(locale, row, t("untitledClass")) }));

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        writable ? <NewWorkspaceSessionButton workspaceId={ctx.center.id} classes={options} todayIso={dateKey(today)} /> : undefined
      }
    >
      <WorkspaceSessionList
        workspaceId={ctx.center.id}
        rows={rows}
        timeZone={timeZone}
        todayIso={dateKey(today)}
        writable={writable}
      />
    </PageSection>
  );
}
