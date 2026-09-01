import { getLocale, getTranslations } from "next-intl/server";
import { GraduationCap, Users, Building2, ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { getTenantContext } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatNumber } from "@/lib/format";

export default async function CenterDashboardPage() {
  const ctx = await getTenantContext("center");
  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("CenterDashboard");
  const tRoles = await getTranslations("Roles");

  // Every count below is centerId-filtered by the scoped helper.
  const [staffCount, teacherCount, studentCount, branchCount] =
    await Promise.all([
      db.memberships.count({
        active: true,
        role: { in: ["OWNER", "MANAGER", "RECEPTIONIST"] },
      }),
      db.memberships.count({ active: true, role: "TEACHER" }),
      db.students.count({ active: true }),
      db.branches.count({ active: true }),
    ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title", { center: ctx.center.name })}
        description={t("subtitle")}
        action={<Badge variant="brand">{tRoles(ctx.role)}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("stats.staff")}
          value={formatNumber(staffCount, locale)}
          icon={<ShieldCheck className="size-4" />}
        />
        <StatCard
          label={t("stats.teachers")}
          value={formatNumber(teacherCount, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard
          label={t("stats.students")}
          value={formatNumber(studentCount, locale)}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("stats.branches")}
          value={formatNumber(branchCount, locale)}
          icon={<Building2 className="size-4" />}
        />
      </div>

      <FormMessage tone="info">{t("milestoneNote")}</FormMessage>
    </div>
  );
}
