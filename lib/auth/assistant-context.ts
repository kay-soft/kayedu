import { cache } from "react";
import { getLocale } from "next-intl/server";
import type { User } from "@prisma/client";

import type { AssistantPermission } from "@/lib/assistant-catalog";
import { getCurrentUser } from "@/lib/auth/session";
import { getTeacherContexts, type TenantContext } from "@/lib/auth/tenant";
import {
  assistantCan,
  assistantFloorAt,
  resolveAssistantActing,
  type AssistantActing,
  type AssistantActingBranch,
} from "@/lib/db/assistant-acting";
import { findEffectiveAssistantLink, type EffectiveAssistantLink } from "@/lib/db/assistants";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";

export type AssistantSession = { user: User; link: EffectiveAssistantLink };

/**
 * The assistant experience's gate (W7a, D-W36). The link is resolved **on the
 * server from the session's user and the route's teacherId** — never from a
 * posted id — and only an effective one counts: live, and the teacher premium
 * on this request (`findEffectiveAssistantLink`, D-W15). `null` means "not
 * yours": no link, a removed or left one, a lapsed teacher, or someone else's
 * teacher id; the route answers not-found for all of them alike.
 *
 * It resolves **no tenant context of the assistant's own**: an assistant is no
 * member of any branch and holds no centre permission (D-W36, D-W37 item 13).
 */
export const getAssistantSession = cache(async (teacherUserId: string): Promise<AssistantSession | null> => {
  const user = await getCurrentUser();
  if (!user) {
    redirect({ href: ROUTES.login, locale: await getLocale() });
    throw new Error("redirect failed");
  }
  const link = await findEffectiveAssistantLink(prisma, { assistantUserId: user.id, teacherUserId });
  return link ? { user, link } : null;
});

/**
 * One of the teacher's branches the assistant may reach (W7b): the acting
 * branch, the **teacher's** `TenantContext` there (built for the teacher's own
 * membership, as for the teacher — `getTeacherContexts`), and the assistant's
 * read floor there (the stricter of the branch's teacher window and the
 * teacher's own `teacherHistoryDays`, D-W19).
 */
export type AssistantBranch = AssistantActingBranch & { ctx: TenantContext; floor: Date; zone: string };

export type AssistantScope = {
  user: User;
  link: EffectiveAssistantLink;
  acting: AssistantActing;
  /** The teacher's branches that allow assistants; a branch with the setting off is absent. */
  branches: AssistantBranch[];
};

/**
 * The one way an assistant's scope is built (D-W37 items 1 and 13):
 * `resolveAssistantActing` first — the effective link and the teacher's
 * branches — and only then the **teacher's** contexts, one per branch it
 * returned. Nothing is ever resolved from the assistant's own identity: no
 * relation, no Membership, no context (`check:assistants`, statically).
 */
async function loadAssistantScope(user: User, teacherUserId: string): Promise<AssistantScope | null> {
  const acting = await resolveAssistantActing(prisma, { assistantUserId: user.id, teacherUserId });
  if (!acting) return null;
  const link = acting.link;
  const contexts = await getTeacherContexts(acting.teacherUserId);
  const now = new Date();
  const branches = acting.branches.flatMap((branch): AssistantBranch[] => {
    const ctx = contexts.find((candidate) => candidate.center.id === branch.centerId && !candidate.experienceDenied);
    if (!ctx) return [];
    return [{ ...branch, ctx, floor: assistantFloorAt(acting, branch, now), zone: centreTimeZone(ctx.settings) }];
  });
  return { user, link, acting: { ...acting, branches: acting.branches.filter((b) => branches.some((x) => x.centerId === b.centerId)) }, branches };
}

/**
 * The assistant pages' scope (W7b, D-W37 items 1 and 13), once per request:
 * the effective link and what it may do, re-resolved from the session's user
 * and the route's teacherId on every request. `null` = not-found for the page.
 */
export const getAssistantScope = cache(async (teacherUserId: string): Promise<AssistantScope | null> => {
  const session = await getAssistantSession(teacherUserId);
  if (!session) return null;
  return loadAssistantScope(session.user, teacherUserId);
});

/**
 * The same scope for an assistant Server Action: `null` — the action answers
 * `forbidden`, never a redirect (the SEC-09 shape) — without a user, a valid
 * teacher id or an effective link.
 */
export async function assistantActionScope(teacherUserId: unknown): Promise<AssistantScope | null> {
  if (typeof teacherUserId !== "string" || teacherUserId.length === 0 || teacherUserId.length > 64) return null;
  const user = await getCurrentUser();
  return user ? loadAssistantScope(user, teacherUserId) : null;
}

/** `assistantCan` on the scope's acting — the one decision (D-W37 item 2). */
export function scopeCan(scope: AssistantScope, permission: AssistantPermission, centerId: string): boolean {
  return assistantCan(scope.acting, permission, centerId);
}

/** The branches where the assistant holds `permission`, in branch order. */
export function scopeBranches(scope: AssistantScope, permission: AssistantPermission): AssistantBranch[] {
  return scope.branches.filter((branch) => scopeCan(scope, permission, branch.centerId));
}

/** The branch an entity lives at among `branches` — a per-branch lookup, the first that finds it (U7). */
export async function findAtBranches<T>(
  branches: AssistantBranch[],
  lookup: (branch: AssistantBranch) => Promise<T | null | undefined>,
): Promise<{ branch: AssistantBranch; found: T } | null> {
  const results = await Promise.all(branches.map(async (branch) => ({ branch, found: await lookup(branch) })));
  const hit = results.find((result) => result.found !== null && result.found !== undefined);
  return hit ? { branch: hit.branch, found: hit.found as T } : null;
}
