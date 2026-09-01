import { getTranslations } from "next-intl/server";

import { PermissionGrantsForm } from "@/app/[locale]/(center)/settings/permissions/permissions-form";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { can, type Permission } from "@/lib/auth/permissions";
import {
  getTenantContext,
  permissionGrantsFromSettings,
  requirePermission,
} from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";

/** The permissions a center may grant a receptionist (docs/02 §6). */
const GRANTABLE: { permission: Permission; labelKey: string }[] = [
  { permission: "center.profit.view", labelKey: "viewProfitLabel" },
  { permission: "attendance.correct", labelKey: "correctAttendanceLabel" },
];

export default async function PermissionsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");
  await requirePermission(ctx, "staff.manage");

  const settings = await scoped(ctx).settings.get();
  const t = await getTranslations("Settings.permissions");
  const tRoles = await getTranslations("Roles");

  // Resolved through the same seam every request uses, so what this screen
  // reports is exactly what the server will enforce.
  const grants = permissionGrantsFromSettings(settings);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <PermissionGrantsForm
        receptionistCanViewProfit={settings?.receptionistCanViewProfit ?? false}
        receptionistCanCorrectAttendance={
          settings?.receptionistCanCorrectAttendance ?? false
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("effectiveTitle")}</CardTitle>
          <CardDescription>
            {t("effectiveDescription", { role: tRoles("RECEPTIONIST") })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-3 md:gap-0">
            {GRANTABLE.map((entry) => {
              const allowed = can("RECEPTIONIST", entry.permission, grants);
              return (
                <li
                  key={entry.permission}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between md:rounded-none md:border-0 md:border-b md:px-2 md:py-3"
                >
                  <span className="min-w-0 text-sm text-text-primary">
                    {t(entry.labelKey)}
                  </span>
                  <Badge variant={allowed ? "success" : "neutral"}>
                    {allowed ? t("allowed") : t("denied")}
                  </Badge>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-text-muted">{t("widenOnlyNote")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
