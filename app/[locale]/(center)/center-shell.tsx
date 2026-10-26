import { cookies } from "next/headers";

import {
  brandFromContext,
  brandFromRollup,
  shellScope,
  shellUser,
  type ShellFrame,
} from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { RollupNotice } from "@/components/shell/rollup-notice";
import { ROUTES } from "@/lib/routes";
import {
  getOwnerOrgGroups,
  getUserCenterRelations,
  requireExperience,
} from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/** Operational pages with no roll-up meaning: disabled in the nav under "Whole Management". */
const ROLLUP_DISABLED_ROUTES = [
  ROUTES.centerReception,
  ROUTES.centerSessions,
  ROUTES.centerApprovals,
];

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
  const [relations, orgGroups, defaultCollapsed] = await Promise.all([
    getUserCenterRelations(ctx.user.id),
    getOwnerOrgGroups(ctx.user.id),
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
  ]);

  // "Whole Management": the shell names the organization, never the
  // representative branch every operational query still scopes on (docs/04
  // §11.1). `getOwnerOrgGroups` already vouched for the match in the context.
  const rollupGroup = ctx.rollupOrganizationId
    ? orgGroups.find((group) => group.organizationId === ctx.rollupOrganizationId)
    : undefined;

  return {
    props: {
      experience: "center",
      nav: navForExperience("center", ctx.role, ctx.grants),
      brand: rollupGroup
        ? brandFromRollup(ctx, rollupGroup.organizationName)
        : brandFromContext(ctx),
      disabledHrefs: rollupGroup ? [...ROLLUP_DISABLED_ROUTES] : undefined,
      user: shellUser(ctx.user, ctx.role),
      scope: shellScope(relations, orgGroups, ctx.rollupOrganizationId ?? ctx.center.id),
      defaultCollapsed,
    },
    lead: rollupGroup ? (
      <RollupNotice
        branchName={ctx.center.name}
        analyticsHref={ROUTES.centerAnalytics}
      />
    ) : null,
  };
}
