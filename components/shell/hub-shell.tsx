import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LocaleToggle } from "@/components/shared/locale-toggle";
import type { ShellUser } from "@/components/shell/app-shell";
import { UserMenu } from "@/components/shell/user-menu";
import { Link } from "@/lib/i18n/navigation";
import { ACCOUNT_HUB_HINT, ROUTES } from "@/lib/routes";

/**
 * The neutral shell for pages opened from the branch hub (U1, docs/04 §5): the
 * app bar (platform name, language, user menu) and a back link to the hub — no
 * sidebar, no branch switcher, because no branch is active there. Used by
 * Account settings when it is opened from `/select-center`.
 */
export async function HubShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const t = await getTranslations("Shell");

  return (
    <div className="min-h-dvh bg-canvas text-text-primary">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <div className="flex h-16 items-center gap-2 px-3 sm:px-6">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("productName")}</span>
          <div className="content-edge-end ms-auto flex items-center gap-2">
            <LocaleToggle />
            <UserMenu user={user} experience={ACCOUNT_HUB_HINT} />
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="p-4 outline-none sm:p-6">
        <div className="content-shell flex flex-col gap-4">
          {/* `?switch=1` keeps the hub open even for someone with a single branch. */}
          <Link
            href={`${ROUTES.selectCenter}?switch=1`}
            className="inline-flex min-h-11 w-fit items-center gap-1 rounded-lg pe-3 text-sm font-medium text-text-secondary transition-ui focus-ring hover:text-text-primary"
          >
            <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {t("backToHub")}
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}
