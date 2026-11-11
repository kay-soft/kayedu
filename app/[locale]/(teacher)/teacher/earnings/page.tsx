import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { EarningsView } from "@/components/teacher/earnings/earnings-view";
import { PageHeader } from "@/components/shared/page-header";
import { ctxCan, requireTeacherUser } from "@/lib/auth/tenant";
import { getTeacherScope } from "@/lib/auth/teacher-scope";
import { prisma } from "@/lib/db/client";
import {
  earningsClassLabels,
  ownedWorkspaceSources,
  teacherEarnings,
  type EarningsSource,
} from "@/lib/db/teacher-earnings";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { parseEarningsPeriod } from "@/lib/validation/earnings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Earnings");
  return { title: t("title") };
}

/**
 * Teacher → Earnings (W8d — D-W25, D-W29, D-W41; docs/04 §11.38). Every
 * branch in view where the teacher may see their own earnings
 * (`analytics.own.view`, SEC-15 — under All branches every such branch, or the
 * one the switcher picked) and every PERSONAL workspace they own, each read by
 * its own scoped query (`lib/db/teacher-earnings.ts`) and unioned in memory.
 * The teacher's own window everywhere: `teacherHistoryDays` (U6) — no centre
 * window binds the teacher's portal. A workspace-only account reaches it from
 * the minimal shell; an account with neither sees the empty state.
 */
export default async function TeacherEarningsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireTeacherUser();
  const raw = await searchParams;
  const choice = parseEarningsPeriod(raw);
  const [t, locale] = await Promise.all([getTranslations("Earnings"), getLocale()]);
  const now = new Date();

  const scope = session.hasCenter ? await getTeacherScope() : null;
  const user = scope?.user ?? session.user;
  const branchSources: EarningsSource[] = (scope?.inView ?? [])
    .filter((ctx) => ctxCan(ctx, "analytics.own.view"))
    .map((ctx) => ({
      kind: "BRANCH",
      centerId: ctx.center.id,
      name: ctx.center.name,
      timeZone: centreTimeZone(ctx.settings),
      floor: teacherPortalHistoryFloor({ user, settings: ctx.settings }, now),
      withSettlements: true,
    }));
  const workspaceSources = await ownedWorkspaceSources(prisma, user.id, user.teacherHistoryDays, now);
  const sources = [...branchSources, ...workspaceSources];

  const result = await teacherEarnings(prisma, user.id, sources, choice, now);
  const classLabels = await earningsClassLabels(prisma, result.sources, locale);
  const todayIso = dateKey(todayInTimezone(commonTimeZone(sources.map((source) => source.timeZone)), now));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <EarningsView
        audience="teacher"
        choice={choice}
        invalid={choice.invalid}
        todayIso={todayIso}
        resetHref={ROUTES.teacherEarnings}
        sources={result.sources}
        summary={result.summary}
        classLabels={classLabels}
      />
    </div>
  );
}
