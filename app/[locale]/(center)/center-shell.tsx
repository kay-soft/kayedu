import { cookies } from "next/headers";

import {
  brandFromContext,
  brandFromRollup,
  shellScope,
  shellUser,
  type ShellFrame,
} from "@/components/shell/from-context";
import { navForExperience, withPendingCount } from "@/components/shell/nav";
import { getPendingApprovalCounts } from "@/lib/auth/approval-counts";
import { ROUTES } from "@/lib/routes";
import {
  ctxCan,
  getOwnerOrgGroups,
  getUserCenterRelations,
  requireExperience,
} from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The center ERP's shell (F2: shared by `(center)/layout.tsx` and Account
 * settings). Role gate: staff roles only — requireExperience() redirects
 * anyone else to their own home.
 */
export async function centerShell(): Promise<ShellFrame> {
  const ctx = await requireExperience("center");
  // Both reads are `cache()`d and share one underlying query
  // (`lib/auth/tenant.ts`); `getOwnerOrgGroups` returns [] with no extra query
  // for anyone who is not an Owner of a multi-branch organization. They feed
  // the header switcher (docs/04 §11.1) — the same set `/select-center`
  // already offers this user, resolved by the same helpers.
  // F7 — the Approvals badge: only for someone who can act on the queue, and
  // never under "Whole Management", where Approvals is a disabled item with no
  // roll-up meaning. Read fresh on every navigation (no polling, no cross-request
  // cache), and shared with the Approvals page's tabs through `cache()`.
  const showApprovalsBadge = !ctx.rollupOrganizationId && ctxCan(ctx, "approvals.manage");
  const [relations, orgGroups, defaultCollapsed, approvalCounts] = await Promise.all([
    getUserCenterRelations(ctx.user.id),
    getOwnerOrgGroups(ctx.user.id),
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
    showApprovalsBadge ? getPendingApprovalCounts(ctx) : null,
  ]);

  // "Whole Management": the shell names the organization, never the
  // representative branch every operational query still scopes on (docs/04
  // §11.1). `getOwnerOrgGroups` already vouched for the match in the context.
  const rollupGroup = ctx.rollupOrganizationId
    ? orgGroups.find((group) => group.organizationId === ctx.rollupOrganizationId)
    : undefined;

  const nav = withPendingCount(
    navForExperience("center", ctx.role, ctx.grants),
    ROUTES.centerApprovals,
    approvalCounts?.total,
  );

  return {
    props: {
      experience: "center",
      nav,
      brand: rollupGroup
        ? brandFromRollup(ctx, rollupGroup.organizationName)
        : brandFromContext(ctx),
      // T6: Analytics is the only page with a roll-up meaning; every other
      // item is branch-scoped and stays visible but disabled, with a reason.
      disabledHrefs: rollupGroup
        ? nav.filter((item) => item.href !== ROUTES.centerAnalytics).map((item) => item.href)
        : undefined,
      user: shellUser(ctx.user, ctx.role),
      scope: shellScope(relations, orgGroups, ctx.rollupOrganizationId ?? ctx.center.id),
      defaultCollapsed,
    },
  };
}
