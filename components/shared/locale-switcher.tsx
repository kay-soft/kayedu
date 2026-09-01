"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { routing } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

export function LocaleSwitcher() {
  const t = useTranslations("LocaleSwitcher");
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t("label")}:</span>
      <div className="flex items-center gap-1">
        {routing.locales.map((loc) => (
          <Link
            key={loc}
            href={pathname}
            locale={loc}
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              loc === locale
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-muted"
            )}
            aria-current={loc === locale ? "true" : undefined}
          >
            {t(loc)}
          </Link>
        ))}
      </div>
    </div>
  );
}
