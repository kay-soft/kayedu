import { cache } from "react";
import { getLocale } from "next-intl/server";
import type { User } from "@prisma/client";

import { getTeacherBranchId } from "@/lib/auth/active-center";
import type { Permission } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import {
  ctxCan,
  getTeacherContexts,
  getTenantContextForBranch,
  getUserCenterRelations,
  type CenterRelation,
  type TenantContext,
} from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * What the teacher portal reads (U7, docs/02-architecture.md §4 "The teacher
 * portal's scope"). A teacher works at several branches; the portal shows them
 * **all at once** by default — every read below is a union of per-branch
 * `scoped(ctx)` reads over `inView`, summed or listed in memory, never one
 * `where` spanning branches (CLAUDE.md rule 1, docs/02 §14). Narrowing to one
 * branch is the switcher's choice (`kayedu_teacher_branch`), checked here
 * against the teacher's own relations — a cookie naming anything else reads
 * as All branches.
 */
export type TeacherScope = {
  user: User;
  relations: CenterRelation[];
  /** One context per branch this user teaches at, by branch name. */
  contexts: TenantContext[];
  /** The branch the teacher picked, or null for All branches (the default). */
  selected: TenantContext | null;
  /** What the portal reads: the picked branch, or every branch. */
  inView: TenantContext[];
};

async function redirectTo(href: string): Promise<never> {
  redirect({ href, locale: await getLocale() });
  throw new Error("redirect failed");
}

/**
 * The teacher portal's gate and scope, once per request. A signed-out user
 * goes to sign-in; a user who teaches nowhere to the centre directory (M15).
 */
export const getTeacherScope = cache(async (): Promise<TeacherScope> => {
  const user = await getCurrentUser();
  if (!user) return redirectTo(ROUTES.login);
  const scope = await resolveTeacherScope(user);
  return scope ?? redirectTo(ROUTES.teacherCenters);
});

/**
 * The same scope for a teacher Server Action that reads across branches (the
 * type-aheads): `null` — the caller answers with nothing — instead of a
 * redirect, when there is no user or no TEACHER role anywhere (SEC-44).
 */
export async function teacherActionScope(): Promise<TeacherScope | null> {
  const user = await getCurrentUser();
  return user ? resolveTeacherScope(user) : null;
}

async function resolveTeacherScope(user: User): Promise<TeacherScope | null> {
  const [relations, contexts, choice] = await Promise.all([
    getUserCenterRelations(user.id),
    getTeacherContexts(user.id),
    getTeacherBranchId(),
  ]);
  if (contexts.length === 0) return null;

  const selected = choice ? (contexts.find((ctx) => ctx.center.id === choice) ?? null) : null;
  return { user, relations, contexts, selected, inView: selected ? [selected] : contexts };
}

/**
 * The branches a teacher page reads after its Branch filter (`?branch=`): the
 * one named, when it is in view, else everything in view. The filter only
 * narrows — it can never reach a branch the scope does not already hold.
 */
export function branchesInView(scope: TeacherScope, branchId: string | null | undefined): TenantContext[] {
  const named = branchId ? scope.inView.find((ctx) => ctx.center.id === branchId) : undefined;
  return named ? [named] : scope.inView;
}

/** Whether a page shows its Branch column and filter: All branches, with more than one. */
export function showsBranches(scope: TeacherScope): boolean {
  return scope.inView.length > 1;
}

/** The first branch in view that grants `permission` — what a page gate checks (U7). */
export function firstGranting(scope: TeacherScope, permission: Permission): TenantContext {
  return scope.inView.find((ctx) => ctxCan(ctx, permission)) ?? scope.inView[0];
}

/**
 * The teacher Server Action guard for a write on one branch's row (U7,
 * SEC-44). Under All branches a write names its branch — the session's,
 * booking's, class's, or a form's Branch select — and that id is **never
 * trusted**: it is re-resolved here through the actor's own relations into a
 * full `TenantContext` (`getTenantContextForBranch`), `null` unless they hold
 * an active TEACHER role there. The caller then checks its permission with
 * `ctxCan` on this context and reads/writes through `scoped()` on it, so a
 * row id from another branch is simply "not found".
 */
export async function teacherBranchContext(centerId: string | null | undefined): Promise<TenantContext | null> {
  if (!centerId) return null;
  return getTenantContextForBranch(centerId, "teacher");
}

/**
 * The branch a teacher page's row lives at (U7): the same scoped lookup run
 * at each branch in view — a union of per-branch reads, never a `where`
 * across branches — and the first branch that finds it. A row id from a
 * branch outside the scope is found nowhere, exactly like a foreign id.
 */
export async function findInBranches<T>(
  branches: TenantContext[],
  lookup: (ctx: TenantContext) => Promise<T | null | undefined>,
): Promise<{ ctx: TenantContext; found: T } | null> {
  const results = await Promise.all(branches.map(async (ctx) => ({ ctx, found: await lookup(ctx) })));
  const hit = results.find((result) => result.found !== null && result.found !== undefined);
  return hit ? { ctx: hit.ctx, found: hit.found as T } : null;
}
