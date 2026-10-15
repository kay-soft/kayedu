import type { User } from "@prisma/client";
import { centerLogoSrc } from "@/lib/storage-paths";

import type {
  ShellBrand,
  ShellScope,
  ShellUser,
} from "@/components/shell/app-shell";
import type { CenterRelation, OwnerOrgGroup, TenantContext } from "@/lib/auth/tenant";
import type { TenantRole } from "@/lib/auth/permissions";
import { personInitials } from "@/lib/initials";

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
