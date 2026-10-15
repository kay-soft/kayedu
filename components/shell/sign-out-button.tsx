"use client";

import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { signOutAction } from "@/app/[locale]/(auth)/actions";
import { cn } from "@/lib/utils";

/**
 * Sign out. `sidebar` (default) is the row at the foot of the dark rail;
 * `light` is the same action on a light page — the branch hub, the invitation
 * — as a quiet ghost button (docs/04 §14.3). The navy slab it used to be there
 * was the heaviest thing on the screen, above the choices it sat under.
 */
export function SignOutButton({
  collapsed,
  variant = "sidebar",
  className,
}: {
  collapsed?: boolean;
  variant?: "sidebar" | "light";
  className?: string;
}) {
  const t = useTranslations("Shell");
  const locale = useLocale();

  return (
    <form action={signOutAction} className={className}>
      <input type="hidden" name="locale" value={locale} />
      <button
        type="submit"
        title={collapsed ? t("signOut") : undefined}
        aria-label={collapsed ? t("signOut") : undefined}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-ui",
          variant === "sidebar"
            ? "text-sidebar-foreground focus-ring-inverse hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent/70"
            : "justify-center font-medium text-text-secondary focus-ring hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
          collapsed && "justify-center px-0",
        )}
      >
        {/* Points out of the app — a direction, so it mirrors (docs/04 §7). */}
        <LogOut className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden />
        {collapsed ? null : <span>{t("signOut")}</span>}
      </button>
    </form>
  );
}
