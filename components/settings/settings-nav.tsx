"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { cn } from "@/lib/utils";

export type SettingsNavItem = {
  href: string;
  /** Key under the `Settings.nav` namespace. */
  labelKey: string;
};

/**
 * Sub-navigation for the center-configuration shell.
 *
 * Below `lg` it wraps into a pill row above the content (never a horizontal
 * scroller); from `lg` it becomes a fixed column beside it — docs/04 §6.
 * Items are filtered by permission on the server, so a link that appears here
 * is always one this user may open.
 */
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  const pathname = usePathname();
  const t = useTranslations("Settings.nav");

  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
        {items.map((item) => {
          // /settings is the general page; only an exact match highlights it.
          const active =
            item.href === "/settings"
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-lg border px-3 py-2 text-sm transition-ui focus-ring lg:w-full",
                  active
                    ? "border-brand/30 bg-brand/10 font-medium text-brand"
                    : "border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
                )}
              >
                {t(item.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
