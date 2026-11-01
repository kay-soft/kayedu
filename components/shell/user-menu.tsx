"use client";

import { LogOut, UserCog } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { signOutAction } from "@/app/[locale]/(auth)/actions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UserAvatar } from "@/components/shared/user-avatar";
import type { ShellUser } from "@/components/shell/app-shell";
import { Link } from "@/lib/i18n/navigation";
import { accountPath, type AccountOrigin } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The header's account control (docs/04-design-system.md §5 "App bar"). The
 * sidebar keeps its own user block and sign-out — that is where a desktop
 * user looks — but below `lg` the sidebar is a drawer, so without this the
 * only way to see who you are signed in as, or to sign out, was to open the
 * navigation. An account action does not belong behind a nav drawer.
 */
export function UserMenu({
  user,
  experience,
}: {
  user: ShellUser;
  /** The shell this menu sits in — Account settings opens inside it (F2). */
  experience: AccountOrigin;
}) {
  const t = useTranslations("Shell");
  const tRoles = useTranslations("Roles");
  const locale = useLocale();

  return (
    <Popover>
      {/* The same 36px visual in a 44px hit area as the language toggle beside
          it (docs/04 §14.3) — it had been a grey disc that read as disabled. */}
      <PopoverTrigger
        aria-label={t("accountMenu")}
        className="group/account inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-ring"
      >
        <UserAvatar
          initials={user.initials}
          className={cn(
            "border border-border-strong shadow-card transition-ui",
            "group-hover/account:border-brand group-hover/account:bg-brand/10 group-hover/account:text-brand",
            "group-active/account:scale-95 group-data-[popup-open]/account:border-brand group-data-[popup-open]/account:text-brand",
          )}
        />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-60">
        <div className="border-b border-border px-2 pt-1 pb-2">
          <p className="truncate text-sm font-medium text-text-primary">
            {user.name}
          </p>
          {user.email ? (
            <p className="truncate text-xs text-text-muted" dir="ltr" translate="no">
              {user.email}
            </p>
          ) : null}
          {/* The hub shell has no branch, so no role to name. */}
          {user.roleKey ? (
            <p className="mt-1 text-xs font-medium text-brand">
              {tRoles(user.roleKey)}
            </p>
          ) : null}
        </div>

        {/* F2: every signed-in person's own account, above Sign out. */}
        <Link
          href={accountPath(experience)}
          className={cn(
            "mt-1 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start text-sm",
            "text-text-primary transition-ui-fast focus-ring",
            "hover:bg-surface-hover active:bg-surface-active",
          )}
        >
          <UserCog className="size-4 shrink-0 text-text-secondary" aria-hidden />
          {t("accountSettings")}
        </Link>

        <form action={signOutAction}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className={cn(
              "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start text-sm",
              "text-danger-fg transition-ui-fast focus-ring",
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
