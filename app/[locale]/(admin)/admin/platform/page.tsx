import { getLocale, getTranslations } from "next-intl/server";
import { Building2, CalendarClock, GraduationCap, Users } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { PageSection } from "@/components/shared/page-section";
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
import { formatMonthYear, formatNumber } from "@/lib/format";

const TREND_MONTHS = 6;


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

      <StatGrid count={4} dense>
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

      {/* One proportional bar per month (docs/04 §14.4) — six rows of
          "0 new … 5 new" gave nothing to compare at a glance. The month is
          formatted by lib/format.ts: a hand-built name beside a raw Latin
          year had mixed numerals in Arabic. */}
      <PageSection title={t("adoption.title")} description={t("adoption.description")}>
        <Card>
          <CardContent>
            <ul className="flex flex-col divide-y divide-border">
              {trend.map((point) => {
                const peak = Math.max(1, ...trend.map((entry) => entry.count));
                return (
                  <li
                    key={point.monthKey}
                    className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                  >
                    <span className="text-sm text-text-secondary">
                      {formatMonthYear(new Date(`${point.monthKey}-01T00:00:00Z`), locale)}
                    </span>
                    <span aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-hover">
                      <span
                        className="block h-full rounded-full bg-brand/60"
                        style={{ width: `${(point.count / peak) * 100}%` }}
                      />
                    </span>
                    <span className="text-end text-sm font-medium whitespace-nowrap tabular-nums text-text-primary">
                      {t("adoption.newCenters", { count: formatNumber(point.count, locale) })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </PageSection>
    </div>
  );
}
