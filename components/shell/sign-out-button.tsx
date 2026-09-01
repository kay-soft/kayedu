"use client";

import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { signOutAction } from "@/app/[locale]/(auth)/actions";

export function SignOutButton() {
  const t = useTranslations("Shell");
  const locale = useLocale();

  return (
    <form action={signOutAction}>
      <input type="hidden" name="locale" value={locale} />
      <button
        type="submit"
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <LogOut className="size-4 shrink-0 rtl:-scale-x-100" />
        <span>{t("signOut")}</span>
      </button>
    </form>
  );
}
