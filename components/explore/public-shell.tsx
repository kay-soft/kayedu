import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { Link } from "@/lib/i18n/navigation";
import { LinkButton } from "@/components/shared/link-button";
import { LocaleToggle } from "@/components/shared/locale-toggle";
import { ProductMark } from "@/components/shared/product-mark";
import { ROUTES } from "@/lib/routes";

/**
 * The public shell (F5, docs/04 §11.24): the chrome of the Explore pages a
 * guest browses without an account — the KayEdu mark, Explore, the language
 * toggle, and Sign in / Create account (or "Go to my dashboard" for someone
 * already signed in, which goes through `/` and so lands exactly where it
 * always did). Below `sm` the header is two rows, so nothing is squeezed
 * under 44px at 375px.
 */
export async function PublicShell({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  const t = await getTranslations("Explore.shell");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <Link href={ROUTES.explore} className="flex min-h-11 items-center rounded-lg focus-ring" aria-label={t("home")}>
            <ProductMark />
          </Link>

          <LocaleToggle className="sm:order-last" />

          <nav
            aria-label={t("nav")}
            className="flex w-full items-center justify-between gap-2 sm:w-auto sm:flex-1 sm:justify-end"
          >
            <LinkButton href={ROUTES.explore} variant="ghost" className="sm:me-auto">
              {t("explore")}
            </LinkButton>
            {signedIn ? (
              <LinkButton href="/" variant="default">
                {t("dashboard")}
              </LinkButton>
            ) : (
              <span className="flex items-center gap-2">
                <LinkButton href={ROUTES.login} variant="ghost">
                  {t("signIn")}
                </LinkButton>
                <LinkButton href={ROUTES.register} variant="default">
                  {t("register")}
                </LinkButton>
              </span>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
