import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { LocaleSwitcher } from "@/components/shared/locale-switcher";

export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getTranslations("Shell");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground"
          >
            K
          </span>
          <span className="text-sm font-semibold">{t("productName")}</span>
        </span>
        <LocaleSwitcher />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center sm:px-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
