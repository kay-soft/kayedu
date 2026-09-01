"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { LocaleSwitcher } from "@/components/shared/locale-switcher";
import { ShellIcon } from "@/components/shell/shell-icon";
import type { ShellNavItem } from "@/components/shell/nav";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

export type ShellBrand = {
  name: string;
  logoUrl: string | null;
  themeColor: string;
};

export type ShellUser = {
  name: string;
  email: string | null;
  initials: string;
  roleKey: string;
};

type AppShellProps = {
  nav: ShellNavItem[];
  brand: ShellBrand;
  user: ShellUser;
  canSwitchCenter: boolean;
  children: ReactNode;
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarContent({
  nav,
  brand,
  user,
  onNavigate,
}: {
  nav: ShellNavItem[];
  brand: ShellBrand;
  user: ShellUser;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const tNav = useTranslations("Nav");
  const tRoles = useTranslations("Roles");
  const tShell = useTranslations("Shell");

  return (
    <>
      <div className="flex items-center gap-3 border-b border-sidebar-border px-4 py-4">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote center logos; Storage wiring lands in M3
          <img
            src={brand.logoUrl}
            alt=""
            className="size-9 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground"
          >
            {brand.name.trim().charAt(0)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">
            {brand.name}
          </span>
          <span className="block truncate text-xs text-text-muted">
            {tShell("productName")}
          </span>
        </span>
      </div>

      <nav
        aria-label={tShell("primaryNav")}
        className="flex-1 overflow-y-auto p-3"
      >
        <ul className="flex flex-col gap-1">
          {nav.map((item) => {
            const active = isActive(pathname, item.href);
            const label = tNav(item.labelKey);

            if (item.disabled) {
              return (
                <li key={item.href}>
                  <span
                    aria-disabled="true"
                    className="flex min-h-11 cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted/70"
                  >
                    <ShellIcon name={item.icon} className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{label}</span>
                    <Badge
                      variant="neutral"
                      className="bg-white/5 text-text-muted ring-white/10"
                    >
                      {tShell("soon")}
                    </Badge>
                  </span>
                </li>
              );
            }

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-brand font-medium text-brand-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <ShellIcon name={item.icon} className="size-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 px-1 py-2">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
          >
            {user.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-white">
              {user.name}
            </span>
            <span className="block truncate text-xs text-text-muted">
              {tRoles(user.roleKey)}
            </span>
          </span>
        </div>
        <SignOutButton />
      </div>
    </>
  );
}

export function AppShell({
  nav,
  brand,
  user,
  canSwitchCenter,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const tShell = useTranslations("Shell");

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  const brandStyle = { "--brand": brand.themeColor } as CSSProperties;

  return (
    <div style={brandStyle} className="min-h-dvh bg-canvas text-text-primary">
      {/* Desktop sidebar — 240px, fixed, dark navy (docs/04 §5). */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-60 flex-col bg-sidebar lg:flex">
        <SidebarContent nav={nav} brand={brand} user={user} />
      </aside>

      {/* Below lg the sidebar becomes a drawer (docs/04 §6). */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-slate-900/50 transition-opacity lg:hidden",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />
      <aside
        id="app-drawer"
        aria-label={tShell("primaryNav")}
        aria-hidden={!drawerOpen}
        className={cn(
          "fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar transition-transform duration-200 lg:hidden",
          drawerOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
        )}
      >
        <div className="flex justify-end p-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label={tShell("closeMenu")}
            className="flex size-11 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <X className="size-5" />
          </button>
        </div>
        <SidebarContent
          nav={nav}
          brand={brand}
          user={user}
          onNavigate={() => setDrawerOpen(false)}
        />
      </aside>

      <div className="flex min-h-dvh flex-col lg:ps-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-surface px-3 sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={tShell("openMenu")}
            aria-controls="app-drawer"
            aria-expanded={drawerOpen}
            className="flex size-11 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-subtle lg:hidden"
          >
            <Menu className="size-5" />
          </button>

          <span className="min-w-0 flex-1 truncate text-sm font-semibold lg:hidden">
            {brand.name}
          </span>

          <div className="ms-auto flex items-center gap-2 sm:gap-3">
            {canSwitchCenter ? (
              <Link
                href={`${ROUTES.selectCenter}?switch=1`}
                className="hidden rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-surface-subtle sm:inline-flex"
              >
                {tShell("switchCenter")}
              </Link>
            ) : null}
            <LocaleSwitcher />
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
