"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { LocaleSwitcher } from "@/components/shared/locale-switcher";
import { NavItem } from "@/components/shell/nav-item";
import type { ShellNavItem } from "@/components/shell/nav";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { ROUTES } from "@/lib/routes";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";
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
  /** Read server-side from the cookie, so the first paint is already correct. */
  defaultCollapsed: boolean;
  children: ReactNode;
};

const COLLAPSED_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarContent({
  nav,
  brand,
  user,
  collapsed,
  onToggleCollapsed,
  onNavigate,
}: {
  nav: ShellNavItem[];
  brand: ShellBrand;
  user: ShellUser;
  /** Omitted entirely on the mobile drawer — a full-screen sheet has no rail. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const tNav = useTranslations("Nav");
  const tRoles = useTranslations("Roles");
  const tShell = useTranslations("Shell");

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-3 border-b border-sidebar-border px-4 py-4",
          collapsed && "justify-center px-2",
        )}
      >
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
        {collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-white">
              {brand.name}
            </span>
            <span className="block truncate text-xs text-text-muted">
              {tShell("productName")}
            </span>
          </span>
        )}
      </div>

      <nav
        aria-label={tShell("primaryNav")}
        className="flex-1 overflow-y-auto p-3"
      >
        <ul className="flex flex-col gap-1">
          {nav.map((item) => (
            <li key={item.href}>
              <NavItem
                item={item}
                active={isActive(pathname, item.href)}
                label={tNav(item.labelKey)}
                soonLabel={tShell("soon")}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div
          className={cn(
            "flex items-center gap-3 px-1 py-2",
            collapsed && "justify-center px-0",
          )}
        >
          <span
            aria-hidden
            title={collapsed ? user.name : undefined}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
          >
            {user.initials}
          </span>
          {collapsed ? null : (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">
                {user.name}
              </span>
              <span className="block truncate text-xs text-text-muted">
                {tRoles(user.roleKey)}
              </span>
            </span>
          )}
        </div>

        {/* Sign out and the collapse toggle share one row (icon-only, right
            next to sign out — no label, so the rail never needs its own
            scrollbar). They stack instead when the rail is already narrow. */}
        <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <div className="min-w-0 flex-1">
            <SignOutButton collapsed={collapsed} />
          </div>
          {onToggleCollapsed ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title={collapsed ? tShell("expandSidebar") : tShell("collapseSidebar")}
              aria-pressed={collapsed}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-sidebar-accent"
            >
              {/* The panel flips edge with the toggle direction, so it mirrors
                  correctly in RTL (docs/04 §7) — collapsing always "closes
                  toward the start" regardless of locale. */}
              {collapsed ? (
                <PanelLeftOpen className="size-4 rtl:-scale-x-100" />
              ) : (
                <PanelLeftClose className="size-4 rtl:-scale-x-100" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function AppShell({
  nav,
  brand,
  user,
  canSwitchCenter,
  defaultCollapsed,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // A UI preference, not a security concern — written directly so the next
    // server render (a fresh tab, a reload) starts already collapsed, with
    // no expand-then-snap-shut flash (docs/02-architecture.md §14).
    document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${COLLAPSED_COOKIE_MAX_AGE}`;
  }

  const brandStyle = { "--brand": brand.themeColor } as CSSProperties;

  return (
    <div style={brandStyle} className="min-h-dvh bg-canvas text-text-primary">
      {/* Desktop sidebar — 240px, or a 72px icon rail when collapsed
          (docs/04 §5). */}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-30 hidden flex-col bg-sidebar transition-[width] duration-200 lg:flex",
          collapsed ? "w-18" : "w-60",
        )}
      >
        <SidebarContent
          nav={nav}
          brand={brand}
          user={user}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </aside>

      {/* Below lg the sidebar becomes a drawer (docs/04 §6) — always
          expanded, since a full-screen sheet has no need for a rail. */}
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

      <div
        className={cn(
          "flex min-h-dvh flex-col transition-[padding] duration-200",
          collapsed ? "lg:ps-18" : "lg:ps-60",
        )}
      >
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
