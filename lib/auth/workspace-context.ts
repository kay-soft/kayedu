import { cache } from "react";

import { isPremium } from "@/lib/auth/premium";
import { getCurrentUser } from "@/lib/auth/session";
import type { TenantContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { resolveWorkspaceAccess, type WorkspaceAccess } from "@/lib/db/workspaces";

/**
 * A PERSONAL workspace's own `TenantContext` (W8a, D-W38 item 12;
 * docs/02-architecture.md §4 "Workspaces"). A workspace is never one of the
 * account's centre relations (`ACCESSIBLE_CENTER` reads BRANCH only), so it is
 * resolved here, by id, for its **owner** only — any other account (another
 * teacher, a centre's staff, a student, an assistant, a platform admin acting
 * as a normal user) gets `null`, and the page answers not-found.
 *
 * The context is the owner's TEACHER membership at the workspace, scoped by
 * its `centerId` exactly like a branch's (`scoped(ctx)` is unchanged). It
 * carries **no grants** — the centre matrix is never consulted, so `ctxCan`
 * allows nothing on it — and `isPlatformAdmin` is false whatever the account
 * is: authority here is `workspaceCan(ctx, …)` and nothing else.
 */
export type WorkspaceContext = TenantContext & { workspace: WorkspaceAccess };

export const getWorkspaceContext = cache(async (workspaceId: string): Promise<WorkspaceContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const access = await resolveWorkspaceAccess(prisma, user.id, workspaceId);
  if (!access || !access.membershipId) return null;
  const [center, settings, membership] = await Promise.all([
    prisma.center.findUnique({ where: { id: access.centerId } }),
    prisma.centerSettings.findUnique({ where: { centerId: access.centerId } }),
    prisma.membership.findFirst({ where: { id: access.membershipId, centerId: access.centerId } }),
  ]);
  if (!center || !membership) return null;
  return {
    user,
    center,
    settings,
    membership,
    studentProfile: null,
    role: "TEACHER",
    roles: ["TEACHER"],
    grants: {},
    isPlatformAdmin: false,
    experienceDenied: false,
    rollupOrganizationId: null,
    workspace: access,
  };
});

/**
 * Whether a workspace page offers its write controls: the owner premium now
 * and the workspace not archived. A display decision only — every writer in
 * `lib/db/workspaces.ts` re-checks both (`assertWorkspaceWritable`).
 */
export function workspaceOffersWrites(ctx: WorkspaceContext, now: Date = new Date()): boolean {
  return isPremium(ctx.user, now) && ctx.workspace.archivedAt === null;
}
