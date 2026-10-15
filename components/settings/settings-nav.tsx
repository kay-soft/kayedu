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
      {/* Two even columns of chips on a phone, a wrapping row from sm, the
          side list from lg (DES, docs/04 §14.8) — at 375 it had wrapped to
          three or four ragged rows of borderless text. */}
      <ul className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:flex-col lg:gap-1">
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
                    : "border-border bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active lg:border-transparent lg:bg-transparent",
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
