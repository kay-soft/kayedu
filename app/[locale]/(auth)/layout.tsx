import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { LocaleToggle } from "@/components/shared/locale-toggle";

/**
 * The signed-out shell (docs/04-design-system.md §5 "Auth layout").
 *
 * These four screens are the first thing anyone sees, and they were a bare
 * white card floating on the app canvas — no framing, no product presence,
 * and a header that was two loose links. This gives them a real page: a
 * branded panel on the product's own dark navy from `lg` up, the form on the
 * light working canvas beside it, and one column on a phone.
 *
 * The panel is decoration in the strict sense — it carries no information the
 * form needs — so it is the half that disappears first, below `lg`.
 */
export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getTranslations("Shell");
  const tAuth = await getTranslations("Auth.shell");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* Brand panel — the product saying what it is, once. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex">
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-xl bg-brand text-base font-bold text-brand-foreground"
          >
            K
          </span>
          <span className="text-lg font-semibold text-white">
            {t("productName")}
          </span>
        </span>

        <div className="flex max-w-xs flex-col gap-3">
          <p className="text-2xl leading-snug font-semibold text-white">
            {tAuth("headline")}
          </p>
          <p className="text-sm leading-relaxed text-text-on-dark/70">
            {tAuth("subhead")}
          </p>
        </div>

        {/* A single soft brand wash, anchored to the logical end corner so it
            mirrors with the page rather than sitting on the wrong side in
            Arabic (docs/04 §7). */}
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -end-24 size-64 rounded-full bg-brand/20 blur-3xl"
        />
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <span className="flex items-center gap-2 lg:invisible">
            <span
              aria-hidden
              className="flex size-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground"
            >
              K
            </span>
            <span className="text-sm font-semibold">{t("productName")}</span>
          </span>
          <LocaleToggle />
        </header>

        <main className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center sm:px-6">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
