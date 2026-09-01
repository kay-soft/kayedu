import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import {
  SettingsNav,
  type SettingsNavItem,
} from "@/components/settings/settings-nav";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

/**
 * The center-configuration shell (M2). Sub-navigation is built from the
 * caller's permissions, so a link that renders here is always one they may
 * open — and each page re-checks server-side anyway (client-side `can()` only
 * hides controls, docs/02 §6).
 */
export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = await getTenantContext("center");
  const t = await getTranslations("Settings");

  const items: SettingsNavItem[] = [];

  if (ctxCan(ctx, "center.settings.edit")) {
    items.push(
      { href: ROUTES.centerSettings, labelKey: "general" },
      { href: ROUTES.centerSettingsBranches, labelKey: "branches" },
      { href: ROUTES.centerSettingsRooms, labelKey: "rooms" },
      {
        href: ROUTES.centerSettingsEducationSystems,
        labelKey: "educationSystems",
      },
      { href: ROUTES.centerSettingsGrades, labelKey: "grades" },
      { href: ROUTES.centerSettingsSubjects, labelKey: "subjects" },
      { href: ROUTES.centerSettingsCard, labelKey: "card" },
    );
    if (ctxCan(ctx, "staff.manage")) {
      items.push({
        href: ROUTES.centerSettingsPermissions,
        labelKey: "permissions",
      });
    }
  }

  if (ctxCan(ctx, "staff.invite")) {
    items.push({ href: ROUTES.centerStaff, labelKey: "staff" });
  }

  // Nothing here is open to this role — send them back to their own home.
  if (items.length === 0) {
    redirect({ href: homePathForRole(ctx.role), locale: await getLocale() });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8">
        <SettingsNav items={items} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
