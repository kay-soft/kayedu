"use client";

import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { signOutAction } from "@/app/[locale]/(auth)/actions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ShellUser } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";

/**
 * The header's account control (docs/04-design-system.md §5 "App bar"). The
 * sidebar keeps its own user block and sign-out — that is where a desktop
 * user looks — but below `lg` the sidebar is a drawer, so without this the
 * only way to see who you are signed in as, or to sign out, was to open the
 * navigation. An account action does not belong behind a nav drawer.
 */
export function UserMenu({ user }: { user: ShellUser }) {
  const t = useTranslations("Shell");
  const tRoles = useTranslations("Roles");
  const locale = useLocale();

  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("accountMenu")}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full border border-transparent",
          "bg-surface-subtle text-xs font-semibold text-text-secondary transition-ui outline-none",
          "hover:border-border hover:bg-surface-hover active:bg-surface-active",
          "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
          "data-[popup-open]:border-brand data-[popup-open]:text-brand",
        )}
      >
        {user.initials}
      </PopoverTrigger>

      <PopoverContent align="end" className="w-60">
        <div className="border-b border-border px-2 pt-1 pb-2">
          <p className="truncate text-sm font-medium text-text-primary">
            {user.name}
          </p>
          {user.email ? (
            <p className="truncate text-xs text-text-muted" dir="ltr">
              {user.email}
            </p>
          ) : null}
          <p className="mt-1 text-xs font-medium text-brand">
            {tRoles(user.roleKey)}
          </p>
        </div>

        <form action={signOutAction} className="pt-1">
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className={cn(
              "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start text-sm",
              "text-danger transition-ui-fast focus-ring",
              "hover:bg-danger-bg active:bg-danger-bg",
            )}
          >
            {/* Points out of the app — a direction, so it mirrors (docs/04 §7). */}
            <LogOut className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden />
            {t("signOut")}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
