import type { ReactNode } from "react";
import type { User } from "@prisma/client";
import { centerLogoSrc } from "@/lib/storage-paths";

import type {
  AppShellProps,
  ShellBrand,
  ShellScope,
  ShellUser,
} from "@/components/shell/app-shell";
import type { CenterRelation, OwnerOrgGroup, TenantContext } from "@/lib/auth/tenant";
import type { TenantRole } from "@/lib/auth/permissions";
import { personInitials } from "@/lib/initials";

/**
 * One experience's shell, as data (F2): what its layout hands `AppShell`, and
 * what goes around the page. Each `(group)/*-shell.tsx` builds one; the
 * group's layout renders it, and so does Account settings — one shell
 * selection, never a copy of it.
 */
export type ShellFrame = {
  props: Omit<AppShellProps, "children">;
  /** Rendered above the page — a notice, a pop-up. */
  lead?: ReactNode;
  /** Rendered instead of the page — the student completion gate. */
  replace?: ReactNode;
};

/** The platform's own brand — a shell with no branch of its own (docs/04 §2). */
export const PLATFORM_BRAND: ShellBrand = {
  name: "KayEdu",
  logoUrl: null,
  themeColor: "#2563EB",
};

function initials(user: User): string {
  return personInitials(user.firstName, user.lastName);
}

function fullName(user: User): string {
  return [user.firstName, user.lastName.replace(/^-+$/, "")]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Center branding is data, not code — logo + theme color come from the row. */
export function brandFromContext(ctx: TenantContext): ShellBrand {
  return {
    name: ctx.center.name,
    logoUrl: centerLogoSrc(ctx.center),
    themeColor: ctx.center.themeColor,
  };
}

/**
 * Under "Whole Management" the shell names the organization, never the
 * representative branch the operational queries happen to scope on: its name
 * and logo are replaced (the avatar then falls back to the name's initial),
 * and only the theme colour — not a name — carries over.
 */
export function brandFromRollup(
  ctx: TenantContext,
  organizationName: string,
): ShellBrand {
  return {
    name: organizationName,
    logoUrl: null,
    themeColor: ctx.center.themeColor,
  };
}

export function shellUser(user: User, role: TenantRole): ShellUser {
  return {
    name: fullName(user),
    email: user.email,
    initials: initials(user),
    roleKey: role,
  };
}

/**
 * What the header branch switcher renders (docs/04 §11.1). Built from the
 * relations a layout has already resolved — this adds no query and no new
 * visibility: it is exactly the set `/select-center` offers the same user.
 */
export function shellScope(
  relations: CenterRelation[],
  orgGroups: OwnerOrgGroup[],
  activeId: string | null,
): ShellScope {
  return {
    activeId,
    branches: relations.map((relation) => ({
      id: relation.center.id,
      name: relation.center.name,
      logoUrl: centerLogoSrc(relation.center),
      themeColor: relation.center.themeColor,
    })),
    rollups: orgGroups.map((group) => ({
      organizationId: group.organizationId,
      organizationName: group.organizationName,
      branchCount: group.branches.length,
    })),
  };
}
