import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { EarningsView } from "@/components/teacher/earnings/earnings-view";
import { PageHeader } from "@/components/shared/page-header";
import { getAssistantScope, scopeBranches, scopeWorkspaces } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import { earningsClassLabels, teacherEarnings, type EarningsSource } from "@/lib/db/teacher-earnings";
import { ROUTES } from "@/lib/routes";
import { commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { parseEarningsPeriod } from "@/lib/validation/earnings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Earnings");
  return { title: t("title") };
}

/**
 * The teacher's Earnings, for their assistant (W8d, D-W41 item 9) —
 * `analytics.view` only (the Full preset), read-only: the teacher page's own
 * reads (`teacherEarnings`) over the sources `assistantCan` grants it — each
 * branch where the teacher holds `analytics.own.view` and allows assistants,
 * each of the teacher's workspaces — under the assistant's windows (D-W19):
 * the stricter of the branch's teacher window and `teacherHistoryDays` at a
 * branch, `teacherHistoryDays` in a workspace. **No paid-out split** — an
 * assistant never sees a settlement. Without `analytics.view` anywhere, a 404.
 */
export default async function AssistantEarningsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teacherId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const branches = scopeBranches(scope, "analytics.view");
  const workspaces = scopeWorkspaces(scope, "analytics.view");
  if (branches.length === 0 && workspaces.length === 0) notFound();

  const choice = parseEarningsPeriod(await searchParams);
  const [t, locale] = await Promise.all([getTranslations("Earnings"), getLocale()]);
  const now = new Date();
  const sources: EarningsSource[] = [
    ...branches.map((branch): EarningsSource => ({
      kind: "BRANCH",
      centerId: branch.centerId,
      name: branch.centerName,
      timeZone: branch.zone,
      floor: branch.floor,
      withSettlements: false,
    })),
    ...workspaces.map((workspace): EarningsSource => ({
      kind: "WORKSPACE",
      centerId: workspace.centerId,
      name: workspace.centerName,
      timeZone: workspace.zone,
      floor: workspace.floor,
      withSettlements: false,
    })),
  ];
  const result = await teacherEarnings(prisma, scope.acting.teacherUserId, sources, choice, now);
  const classLabels = await earningsClassLabels(prisma, result.sources, locale);
  const todayIso = dateKey(todayInTimezone(commonTimeZone(sources.map((source) => source.timeZone)), now));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("assistantSubtitle", { teacher: scope.link.teacherName })} />
      <EarningsView
        audience="assistant"
        choice={choice}
        invalid={choice.invalid}
        todayIso={todayIso}
        resetHref={ROUTES.assistantEarnings(teacherId)}
        sources={result.sources}
        summary={result.summary}
        classLabels={classLabels}
      />
    </div>
  );
}
