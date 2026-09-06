import type { User } from "@prisma/client";

import type { ShellBrand, ShellUser } from "@/components/shell/app-shell";
import type { TenantContext } from "@/lib/auth/tenant";
import type { TenantRole } from "@/lib/auth/permissions";

function initials(user: User): string {
  const first = user.firstName.trim().charAt(0);
  const last = user.lastName.replace(/^-+$/, "").trim().charAt(0);
  return (first + last).toUpperCase() || "?";
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
    logoUrl: ctx.center.logoUrl,
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
