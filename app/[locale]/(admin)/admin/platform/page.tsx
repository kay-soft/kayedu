import { getLocale, getTranslations } from "next-intl/server";
import { Building2, CalendarClock, GraduationCap, Users } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Card, CardContent } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import {
  platformAdoptionTrend,
  platformCenterCounts,
  platformSessionCount,
  platformStudentCount,
  platformTeacherCount,
} from "@/lib/db/platform";
import { formatNumber } from "@/lib/format";

const TREND_MONTHS = 6;

const MONTH_INDEX = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * Platform KPIs (spec §4.4): active centers, total teachers, total students,
 * total sessions, and an adoption trend. Every figure reads through an
 * aggregate/`groupBy`/`count` (`lib/db/platform.ts`) — never fetch-and-sum,
 * the same discipline M6's analytics module established (docs/02 §14).
 */
export default async function AdminPlatformPage() {
  await requirePlatformAdmin();

  const locale = await getLocale();
  const t = await getTranslations("AdminPlatform");
  const tMonths = await getTranslations("AdminPlatform.months");

  const [centers, teachers, students, sessions, trend] = await Promise.all([
    platformCenterCounts(prisma),
    platformTeacherCount(prisma),
    platformStudentCount(prisma),
    platformSessionCount(prisma),
    platformAdoptionTrend(prisma, TREND_MONTHS),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <StatGrid count={4}>
        <StatCard
          label={t("activeCenters")}
          value={formatNumber(centers.operational, locale)}
          hint={t("suspendedHint", {
            count: formatNumber(centers.byState.SUSPENDED + centers.byState.ARCHIVED, locale),
          })}
          icon={<Building2 className="size-4" />}
        />
        <StatCard
          label={t("totalTeachers")}
          value={formatNumber(teachers, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard
          label={t("totalStudents")}
          value={formatNumber(students, locale)}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("totalSessions")}
          value={formatNumber(sessions, locale)}
          icon={<CalendarClock className="size-4" />}
        />
      </StatGrid>

      <SectionHeader title={t("adoption.title")} description={t("adoption.description")} />
      <Card>
        <CardContent>
          <ul className="flex flex-col gap-3 md:gap-0">
            {trend.map((point) => {
              const [, monthNum] = point.monthKey.split("-");
              const monthLabel = tMonths(MONTH_INDEX[Number(monthNum) - 1]);
              return (
                <li
                  key={point.monthKey}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border p-3 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:last:border-0"
                >
                  <span className="text-sm text-text-secondary">
                    {monthLabel} {point.monthKey.split("-")[0]}
                  </span>
                  <span className="text-sm font-medium tabular-nums text-text-primary">
                    {t("adoption.newCenters", { count: formatNumber(point.count, locale) })}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
