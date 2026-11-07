"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * A workspace's three sections — Classes (its home, and every class page
 * under it), Sessions, Settings (W8a, docs/04 §11.37). Three even columns at
 * every width, so they never wrap or scroll sideways at 375px; each a 44px
 * target.
 */
export function WorkspaceTabs({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("Workspaces.tabs");
  const pathname = usePathname();
  const sessions = ROUTES.teacherWorkspaceSessions(workspaceId);
  const settings = ROUTES.teacherWorkspaceSettings(workspaceId);
  const tabs = [
    { href: ROUTES.teacherWorkspace(workspaceId), label: t("classes"), active: !pathname.startsWith(sessions) && !pathname.startsWith(settings) },
    { href: sessions, label: t("sessions"), active: pathname.startsWith(sessions) },
    { href: settings, label: t("settings"), active: pathname.startsWith(settings) },
  ];
  return (
    <nav aria-label={t("label")}>
      <ul className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center justify-center rounded-lg border px-4 py-2 text-sm transition-ui focus-ring",
                tab.active
                  ? "border-brand/30 bg-brand/10 font-medium text-brand"
                  : "border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
              )}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
