"use client";

import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { signOutAction } from "@/app/[locale]/(auth)/actions";
import { cn } from "@/lib/utils";

export function SignOutButton({ collapsed }: { collapsed?: boolean }) {
  const t = useTranslations("Shell");
  const locale = useLocale();

  return (
    <form action={signOutAction}>
      <input type="hidden" name="locale" value={locale} />
      <button
        type="submit"
        title={collapsed ? t("signOut") : undefined}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-ui focus-ring-inverse hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent/70",
          collapsed && "justify-center px-0",
        )}
      >
        <LogOut className="size-4 shrink-0 rtl:-scale-x-100" />
        {collapsed ? null : <span>{t("signOut")}</span>}
      </button>
    </form>
  );
}
