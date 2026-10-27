"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "@/lib/i18n/navigation";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { LocaleToggle } from "@/components/shared/locale-toggle";
import {
  BranchSwitcher,
  type BranchOption,
  type RollupOption,
} from "@/components/shell/branch-switcher";
import { NavItem } from "@/components/shell/nav-item";
import { RollupNavItem } from "@/components/shell/rollup-nav-item";
import type { ShellNavItem } from "@/components/shell/nav";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { UserMenu } from "@/components/shell/user-menu";
import type { ShellExperience } from "@/lib/routes";
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
  /** Profile photo, only when `MEDIA_AVATARS_DISPLAY` is on (F8) — otherwise null and initials show. */
  photoSrc?: string | null;
  roleKey: string;
};

/**
 * What the header's branch switcher needs to render (docs/04 §11.1). Absent
 * for the experiences that have no branch scope of their own — a parent, a
 * platform admin — and for anyone with a single branch, where §11.1 says the
 * control is hidden entirely rather than disabled.
 */
export type ShellScope = {
  activeId: string | null;
  branches: BranchOption[];
  rollups: RollupOption[];
};

export type AppShellProps = {
  /** Which experience this shell is — the user menu's Account settings link returns into it (F2). */
  experience: ShellExperience;
  nav: ShellNavItem[];
  brand: ShellBrand;
  user: ShellUser;
  /** Omitted for an experience with nothing to switch between. */
  scope?: ShellScope;
  /** Nav hrefs shown disabled with a reason — "Whole Management" only. */
  disabledHrefs?: string[];
  /** Read server-side from the cookie, so the first paint is already correct. */
  defaultCollapsed: boolean;
  children: ReactNode;
};

const COLLAPSED_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Consecutive items that share a `group` — each run gets one heading. */
function groupNav(nav: ShellNavItem[]) {
  const runs: { group: string | undefined; items: ShellNavItem[] }[] = [];
  for (const item of nav) {
    const last = runs[runs.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else runs.push({ group: item.group, items: [item] });
  }
  return runs;
}

function SidebarContent({
  nav,
  brand,
  user,
  collapsed,
  onNavigate,
  onClose,
  closeRef,
  disabledHrefs,
}: {
  nav: ShellNavItem[];
  brand: ShellBrand;
  user: ShellUser;
  /** Omitted entirely on the mobile drawer — a full-screen sheet has no rail. */
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Drawer only: draws the close button on the brand row. */
  onClose?: () => void;
  /** Drawer only: the close button, focused when the drawer opens. */
  closeRef?: Ref<HTMLButtonElement>;
  /** Under "Whole Management": the operational pages shown disabled (docs/04 §11.1). */
  disabledHrefs?: string[];
}) {
  const pathname = usePathname();
  const tNav = useTranslations("Nav");
  const tGroups = useTranslations("NavGroups");
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
        {/* Logo when the centre has one, otherwise its real initial —
            `lib/initials.ts` explains why `name.charAt(0)` was wrong. */}
        <BrandAvatar
          name={brand.name}
          logoUrl={brand.logoUrl}
          themeColor={brand.themeColor}
          size="md"
          className="rounded-lg"
        />
        {collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-white">
              {brand.name}
            </span>
            <span className="block truncate text-xs text-text-on-dark-muted">
              {tShell("productName")}
            </span>
          </span>
        )}
        {onClose ? (
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={tShell("closeMenu")}
            className="-me-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground transition-ui focus-ring-inverse hover:bg-sidebar-accent active:bg-sidebar-accent/70"
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      <nav
        aria-label={tShell("primaryNav")}
        className="scrollbar-sidebar flex-1 overflow-y-auto overscroll-contain p-3"
      >
        <ul className="flex flex-col gap-1">
          {groupNav(nav).map((run, runIndex) => (
            <Fragment key={run.group ?? `ungrouped-${runIndex}`}>
              {/* A heading names a group of links; on the icon rail there is no
                  room for words, so a hairline marks the same boundary. */}
              {runIndex > 0 ? (
                run.group && !collapsed ? (
                  <li
                    role="presentation"
                    className="px-3 pt-4 pb-1 text-xs font-medium text-text-on-dark-muted"
                  >
                    {tGroups(run.group)}
                  </li>
                ) : (
                  <li
                    role="separator"
                    className="mx-3 my-2 border-t border-sidebar-border"
                  />
                )
              ) : null}
              {run.items.map((item) => (
                <li key={item.href}>
                  {disabledHrefs?.includes(item.href) ? (
                    <RollupNavItem
                      item={item}
                      label={tNav(item.labelKey)}
                      reason={tShell("rollupDisabledReason")}
                      collapsed={collapsed}
                    />
                  ) : (
                    <NavItem
                      item={item}
                      active={isActive(pathname, item.href)}
                      label={tNav(item.labelKey)}
                      collapsed={collapsed}
                      onNavigate={onNavigate}
                    />
                  )}
                </li>
              ))}
            </Fragment>
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
              <span className="block truncate text-xs text-text-on-dark-muted">
                {tRoles(user.roleKey)}
              </span>
            </span>
          )}
        </div>

        <SignOutButton collapsed={collapsed} />
      </div>
    </>
  );
}

export function AppShell({
  experience,
  nav,
  brand,
  user,
  scope,
  disabledHrefs,
  defaultCollapsed,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const tShell = useTranslations("Shell");
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!drawerOpen) {
      // Closing hands focus back to the button that opened the drawer — only
      // after it was actually open, never on the first render (docs/04 §14.3).
      if (wasOpen.current) menuRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    // The page behind is inert while the drawer is open, so the drawer must
    // close if the window grows into the desktop layout (docs/04 §14.3).
    const desktop = window.matchMedia("(min-width: 64rem)");
    const onDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onDesktop);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onDesktop);
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
      {/* The first focusable thing on every page (docs/04 §14.3). */}
      <a
        href="#main"
        inert={drawerOpen}
        className="sr-only z-[60] rounded-lg bg-surface px-4 py-3 text-sm font-medium text-text-primary shadow-popover focus-ring focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        {tShell("skipToContent")}
      </a>
      {/* Desktop sidebar — 240px, or a 72px icon rail when collapsed
          (docs/04 §5). */}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-30 hidden flex-col bg-sidebar transition-[width] duration-[var(--motion-slow)] ease-[var(--ease-out)] lg:flex",
          collapsed ? "w-18" : "w-60",
        )}
      >
        <SidebarContent
          nav={nav}
          brand={brand}
          user={user}
          collapsed={collapsed}
          disabledHrefs={disabledHrefs}
        />
      </aside>

      {/* Below lg the sidebar becomes a drawer (docs/04 §6) — always
          expanded, since a full-screen sheet has no need for a rail. */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-sidebar/50 backdrop-blur-[1px] transition-opacity duration-[var(--motion-slow)] lg:hidden",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />
      <aside
        id="app-drawer"
        aria-label={tShell("primaryNav")}
        // `inert` while closed: off-screen links must not stay in the tab
        // order of every phone page (it had only been aria-hidden).
        inert={!drawerOpen}
        // A modal while open: everything behind it is inert (docs/04 §14.3).
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen || undefined}
        className={cn(
          "fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar lg:hidden",
          "transition-transform duration-[var(--motion-slow)] ease-[var(--ease-out)]",
          drawerOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
        )}
      >
        <SidebarContent
          nav={nav}
          brand={brand}
          user={user}
          onNavigate={() => setDrawerOpen(false)}
          onClose={() => setDrawerOpen(false)}
          closeRef={closeRef}
          disabledHrefs={disabledHrefs}
        />
      </aside>

      <div
        // Tab must not walk out of an open drawer into the page under it.
        inert={drawerOpen}
        className={cn(
          "flex min-h-dvh flex-col transition-[padding] duration-[var(--motion-slow)] ease-[var(--ease-out)]",
          collapsed ? "lg:ps-18" : "lg:ps-60",
        )}
      >
        {/* The app bar (docs/04 §5): branch context on the start edge, account
            and language on the end edge, one baseline, real controls. */}
        <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          {/* The start cluster (sidebar toggle, branch switcher) sits at the
              start edge of the main column, directly beside the sidebar, on
              the standard gutter. The end cluster still ends at the content's
              edge (`content-edge-end`), so past 1536px it does not run off to
              the screen's edge while the content stays centred. */}
          <div className="flex h-16 items-center gap-2 px-3 sm:px-6">
            <button
              ref={menuRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={tShell("openMenu")}
              aria-controls="app-drawer"
              aria-expanded={drawerOpen}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover active:bg-surface-active lg:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </button>
            {/* From lg the same start-edge spot collapses the rail (docs/04
                §14.3). It used to sit beside Sign out, where one slip signed a
                receptionist out; on the brand row it cut the branch name. */}
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? tShell("expandSidebar") : tShell("collapseSidebar")}
              title={collapsed ? tShell("expandSidebar") : tShell("collapseSidebar")}
              aria-pressed={collapsed}
              className="hidden size-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover active:bg-surface-active lg:flex"
            >
              {/* The panel flips edge with the reading direction (docs/04 §7):
                  collapsing always closes toward the start. */}
              {collapsed ? (
                <PanelLeftOpen className="size-5 rtl:-scale-x-100" aria-hidden />
              ) : (
                <PanelLeftClose className="size-5 rtl:-scale-x-100" aria-hidden />
              )}
            </button>

            {scope ? (
              <BranchSwitcher
                activeName={brand.name}
                activeLogoUrl={brand.logoUrl}
                activeThemeColor={brand.themeColor}
                activeId={scope.activeId}
                branches={scope.branches}
                rollups={scope.rollups}
              />
            ) : null}

            {/* Below lg the sidebar's own branding is behind the drawer, so
                the bar carries the name — unless the switcher already does. */}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-semibold",
                scope && (scope.branches.length > 1 || scope.rollups.length > 0)
                  ? "hidden"
                  : "lg:hidden",
              )}
            >
              {brand.name}
            </span>

            <div className="content-edge-end ms-auto flex items-center gap-2">
              <LocaleToggle />
              <UserMenu user={user} experience={experience} />
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none sm:p-6">
          <div className="content-shell">{children}</div>
        </main>
      </div>
    </div>
  );
}
