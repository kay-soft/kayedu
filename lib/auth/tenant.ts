import { cache } from "react";
import { getLocale } from "next-intl/server";
import type {
  Center,
  CenterSettings,
  Membership,
  StudentProfile,
  User,
} from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { getActiveCenterId } from "@/lib/auth/active-center";
import {
  canInContext,
  isCenterStaffRole,
  type Permission,
  type PermissionGrants,
  type TenantRole,
} from "@/lib/auth/permissions";
import {
  resolveCenterRelations,
  roleForExperience,
  type CenterRelation,
  type Experience,
} from "@/lib/auth/relations";
import { loadPermissionGrants } from "@/lib/db/permissions";
import { verifiedChildLinks } from "@/lib/db/parents";
import { fullName, localName } from "@/lib/identity";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";

export type { CenterRelation, Experience };

/**
 * Everything a request needs to be safely tenant-scoped
 * (docs/02-architecture.md §4).
 *
 * `membership` is null for the student experience and for a platform admin
 * viewing a center — those relationships are a StudentProfile / the platform
 * admin flag, not a Membership.
 */
export type TenantContext = {
  user: User;
  center: Center;
  settings: CenterSettings | null;
  membership: Membership | null;
  studentProfile: StudentProfile | null;
  /** The role this request acts with at this center. */
  role: TenantRole;
  /** Every role this user holds at this center (a person can be staff + teacher). */
  roles: TenantRole[];
  /** Center-configurable permission grants on top of the role baseline. */
  grants: PermissionGrants;
  isPlatformAdmin: boolean;
  /**
   * SEC-09: the request asked for an experience (centre / teacher / student)
   * this user holds no role for at this centre. Such a context grants
   * nothing: `ctxCan` denies every permission, and every Server Action's
   * experience guard (`actionContext`) refuses it. `role` is then the user's
   * highest role here, kept only so a page can redirect them home.
   */
  experienceDenied: boolean;
  /**
   * Set when the active-selection cookie named an Organization rather than a
   * branch — an Owner's "Whole Management" choice (M11). `center` above is
   * still one real, resolved branch (a representative one) that every
   * operational query scopes on unchanged; only a consumer that wants the
   * roll-up (Analytics) reads this field. `null` for every other request.
   */
  rollupOrganizationId: string | null;
};

/** The role a user acts with at a center when no experience is requested. */
export function primaryRole(relation: CenterRelation): TenantRole {
  return relation.roles[0] ?? "STUDENT";
}

/**
 * Every center this user is connected to — see `lib/auth/relations.ts`'s
 * `resolveCenterRelations` for the resolution itself (the Owner/org widening,
 * branch grants, student profiles). This is just the per-request `cache()`
 * around it: React's cache is per-request only, so a role or grant change
 * still takes effect on the very next request (security fix 17, below).
 */
export const getUserCenterRelations = cache(
  async (userId: string): Promise<CenterRelation[]> => resolveCenterRelations(prisma, userId),
);

export type OwnerOrgGroup = {
  organizationId: string;
  organizationName: string;
  branches: Center[];
};

/**
 * The organizations this user is an Owner of, where the organization actually
 * has more than one branch — the set the "Whole Management" option in the
 * branch switcher offers (M11, spec §4.1). A single-branch organization has
 * nothing for a roll-up to sum, so it never appears here; the switcher still
 * lists that one branch as an ordinary card via `getUserCenterRelations`.
 */
export const getOwnerOrgGroups = cache(
  async (userId: string): Promise<OwnerOrgGroup[]> => {
    const relations = await getUserCenterRelations(userId);
    const branchesByOrg = new Map<string, Center[]>();
    for (const relation of relations) {
      if (!relation.roles.includes("OWNER")) continue;
      const orgId = relation.center.organizationId;
      const list = branchesByOrg.get(orgId) ?? [];
      list.push(relation.center);
      branchesByOrg.set(orgId, list);
    }

    const multiOrgIds = [...branchesByOrg.entries()]
      .filter(([, branches]) => branches.length > 1)
      .map(([orgId]) => orgId);
    if (multiOrgIds.length === 0) return [];

    const organizations = await prisma.organization.findMany({
      where: { id: { in: multiOrgIds } },
    });

    return organizations.map((organization) => ({
      organizationId: organization.id,
      organizationName: organization.name,
      branches: (branchesByOrg.get(organization.id) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
  },
);

async function redirectTo(href: string): Promise<never> {
  redirect({ href, locale: await getLocale() });
  // next-intl's redirect throws; this is unreachable and only satisfies TS.
  throw new Error("redirect failed");
}

/**
 * Resolves one relation into a full `TenantContext` for a given experience —
 * the piece `getTenantContext` and `getTeacherContexts` share. Pulled out on
 * its own because the teacher portal (M7) needs a *context per center*, not
 * just the single active one the `kayedu_center` cookie names (docs/01 §4:
 * "combined views are unions of permitted per-center data").
 */
async function buildContext(
  user: User,
  relation: CenterRelation,
  experience: Experience | undefined,
): Promise<TenantContext> {
  const settings = await prisma.centerSettings.findUnique({
    where: { centerId: relation.center.id },
  });

  const requested = roleForExperience(relation, experience);
  const experienceDenied = requested === null;
  const role = requested ?? roleForExperience(relation) ?? "STUDENT";
  const membership = relation.memberships.find((item) => item.role === role) ?? null;

  // STUDENT is a resolved role, not a Membership — it never has PermissionGrant
  // rows (docs/01-data-model.md "Permissions layer" is centerId × Role × action,
  // and Role has no STUDENT value), so there is nothing to load. A denied
  // experience loads nothing either: it grants nothing (SEC-09).
  const grants =
    role === "STUDENT" || experienceDenied
      ? {}
      : await loadPermissionGrants(prisma, relation.center.id, role);

  return {
    user,
    center: relation.center,
    settings,
    membership,
    studentProfile: relation.studentProfile,
    role,
    roles: relation.roles,
    grants,
    isPlatformAdmin: user.isPlatformAdmin,
    experienceDenied,
    rollupOrganizationId: null,
  };
}

/**
 * Resolves who is asking, which center they are in, and what they may do.
 * Called at the top of every protected loader and every Server Action.
 * Redirects (never returns) when there is no valid user/center relationship.
 *
 * A layout and the page(s) it wraps both call this on every request, so it is
 * wrapped in React's `cache()` (docs/02-architecture.md §14) — one request
 * resolves the user, the relations and the settings row **once**, no matter
 * how many components ask. It takes `experience` as a plain optional string
 * rather than an options object on purpose: `cache()` keys object arguments
 * by reference, so a fresh `{ experience: "center" }` literal at every call
 * site would never hit the cache — a primitive keys by value instead.
 *
 * Security fix 17 (M12, docs/00-master-product-spec.md §5, criterion 20):
 * a role/grant change must take effect on the very next request, never on the
 * next login. React's `cache()` here is per-request only — it never survives
 * past the response — and no cookie or JWT anywhere in this app carries a
 * role, a permission, or a grant: `kayedu_center` (`lib/auth/active-center.ts`)
 * holds only a center/organization selection, and Supabase's own session
 * cookie holds only the auth identity. `role`/`grants` are re-derived from
 * `Membership`/`PermissionGrant` fresh on every request via
 * `getUserCenterRelations()`/`loadPermissionGrants()` above, so there is no
 * snapshot to invalidate — the very next request already reads the changed
 * row. This is the mechanism `check:permissions` asserts directly: writing a
 * `PermissionGrant`/`Membership.role` change and re-resolving immediately
 * (no fresh login, no cache warm-up) must show the new value.
 */
export const getTenantContext = cache(
  async (experience?: Experience): Promise<TenantContext> => {
    const user = await getCurrentUser();
    if (!user) return redirectTo(ROUTES.login);

    const relations = await getUserCenterRelations(user.id);

    if (relations.length === 0) {
      if (user.isPlatformAdmin) return redirectTo(ROUTES.adminCenters);
      // A zero-relation user requesting the teacher experience lands on the
      // centre directory, never the generic (student-leaning) empty state
      // (M15, spec §5.1 "Teacher onboarding") — `requireTeacherUser()` is the
      // gate that actually renders `/teacher/centers` itself without ever
      // reaching this redirect, so this only covers a teacher-experience page
      // reached some other way (a direct `/teacher/dashboard` URL, say).
      if (experience === "teacher") return redirectTo(ROUTES.teacherCenters);
      return redirectTo(ROUTES.selectCenter);
    }

    const selectionId = await getActiveCenterId();
    let relation = selectionId
      ? relations.find((item) => item.center.id === selectionId)
      : undefined;

    // Not a branch id this user holds — it may be an Organization id from an
    // Owner's "Whole Management" choice (M11). One cookie, one value, two
    // things it can name; this is the one place that distinction is made
    // (lib/auth/active-center.ts's doc comment). `getOwnerOrgGroups` already
    // only returns organizations this user is actually an Owner of, so
    // finding a match here is itself the authorization check — nothing here
    // trusts the cookie value beyond that lookup.
    let rollupOrganizationId: string | null = null;
    if (!relation && selectionId) {
      const orgGroups = await getOwnerOrgGroups(user.id);
      const group = orgGroups.find((item) => item.organizationId === selectionId);
      if (group) {
        // A representative branch — sorted deterministically by
        // getOwnerOrgGroups — is what every operational query still scopes
        // on; the roll-up is Analytics' own concern, read off the flag below.
        relation = relations.find((item) => item.center.id === group.branches[0].id);
        rollupOrganizationId = selectionId;
      }
    }

    if (!relation) {
      // Auto-select when there is exactly one center; otherwise go pick one.
      // (A Server Component cannot write the cookie — selecting persists it.)
      if (relations.length === 1) {
        relation = relations[0];
      } else {
        return redirectTo(ROUTES.selectCenter);
      }
    }

    const ctx = await buildContext(user, relation, experience);
    return { ...ctx, rollupOrganizationId };
  },
);

/**
 * Every center this user teaches at, each resolved into its own full
 * `TenantContext` — not just the single center the active-center cookie
 * names. This is the seam the teacher portal's cross-center dashboard reads
 * through (M7, docs/01-data-model.md §4 "Teacher cross-center visibility"):
 * the caller loops over the returned contexts and runs the *same* scoped
 * queries (`scoped(ctx)`) it would for a single center, then unions the
 * results in memory — never a query that spans centers at the database
 * layer. Ignores the active-center cookie entirely; it is not "which one is
 * active", it is "every one this teacher belongs to".
 */
export const getTeacherContexts = cache(
  async (userId: string): Promise<TenantContext[]> => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return [];

    const relations = await getUserCenterRelations(userId);
    const teacherRelations = relations.filter((relation) =>
      relation.roles.includes("TEACHER"),
    );

    return Promise.all(
      teacherRelations.map((relation) => buildContext(user, relation, "teacher")),
    );
  },
);

/**
 * Every center this user has an active `StudentProfile` at, each resolved
 * into its own full `TenantContext` — the student-portal mirror of
 * `getTeacherContexts` (M7), used for the Schedule page's per-center
 * `scoped(ctx)` queries, unioned in memory (docs/01-data-model.md §4).
 *
 * Deliberately narrower than the student *experience* itself: a student can
 * have a PENDING `Reservation` at a center with no `StudentProfile` there yet
 * (M8, `lib/db/reservations.ts`) — that center has nothing to loop over here
 * until the request is confirmed or instantly enrolled. "My reservations"
 * reads across every center by `studentId` directly instead
 * (`lib/db/student-portal.ts`), the same identity-scoped shape
 * `getUserCenterRelations` already uses.
 */
export const getStudentContexts = cache(
  async (userId: string): Promise<TenantContext[]> => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return [];

    const relations = await getUserCenterRelations(userId);
    const studentRelations = relations.filter((relation) =>
      relation.roles.includes("STUDENT"),
    );

    return Promise.all(
      studentRelations.map((relation) => buildContext(user, relation, "student")),
    );
  },
);

export type TeacherSession =
  | { hasCenter: true; ctx: TenantContext; relations: CenterRelation[] }
  | { hasCenter: false; user: User; relations: CenterRelation[] };

/**
 * The (teacher) route group's gate — deliberately **not**
 * `requireExperience("teacher")` on its own. A teacher who belongs to zero
 * centres must land on the centre directory (`/teacher/centers`, M15, spec
 * §5.1 "Teacher onboarding") rather than being swept into `/select-center`'s
 * generic empty state, which — before this milestone — only ever pointed a
 * zero-relation user at the student Discover screen (the exact "wrong
 * fall-through" the spec calls out). This mirrors `requireStudentUser()`
 * exactly: only a signed-in `User` is required, and the caller (the teacher
 * layout) decides what to render when there is no `TEACHER` relation yet.
 */
export async function requireTeacherUser(): Promise<TeacherSession> {
  const user = await getCurrentUser();
  if (!user) return redirectTo(ROUTES.login);

  const relations = await getUserCenterRelations(user.id);
  const hasTeacherCenter = relations.some((relation) => relation.roles.includes("TEACHER"));

  if (!hasTeacherCenter) return { hasCenter: false, user, relations };

  const ctx = await getTenantContext("teacher");
  return { hasCenter: true, ctx, relations };
}

/** The platform default before a student has connected anywhere (docs/04 §2). */
const DEFAULT_STUDENT_BRAND = {
  name: "KayEdu",
  logoUrl: null as string | null,
  themeColor: "#2563EB",
};

export type StudentSession = {
  user: User;
  /** Every center this user is connected to, in any role — for "switch center". */
  relations: CenterRelation[];
  /** The relation to brand the student shell with — the first STUDENT one, if any. */
  studentRelation: CenterRelation | null;
};

/**
 * The (student) route group's gate — deliberately **not**
 * `requireExperience("student")`. Discover is the mechanism by which a
 * brand-new sign-up becomes a student at all (spec §4.3, docs/02 §3 "students
 * by discovery/enroll"): requiring an existing `StudentProfile`/role before a
 * user can even reach Discover would make that self-serve path unreachable —
 * `getTenantContext` redirects a zero-relation user to `/select-center`
 * before any role check runs. This only requires a signed-in `User`; a person
 * with zero relations anywhere still gets a `StudentSession` (with
 * `studentRelation: null`), rendered with the platform default brand instead
 * of a center's theme, so they can browse and make their first reservation.
 */
export async function requireStudentUser(): Promise<StudentSession> {
  const user = await getCurrentUser();
  if (!user) return redirectTo(ROUTES.login);

  const relations = await getUserCenterRelations(user.id);
  const studentRelation =
    relations.find((relation) => relation.roles.includes("STUDENT")) ?? null;

  return { user, relations, studentRelation };
}

export function studentBrand(session: StudentSession) {
  if (!session.studentRelation) return DEFAULT_STUDENT_BRAND;
  return {
    name: session.studentRelation.center.name,
    logoUrl: centerLogoSrc(session.studentRelation.center),
    themeColor: session.studentRelation.center.themeColor,
  };
}

export type ParentChildOption = {
  linkId: string;
  centerId: string;
  centerName: string;
  centerLogoUrl: string | null;
  centerThemeColor: string;
  studentProfileId: string;
  childName: string;
};

/**
 * A parent's readable children — the **only** child list any parent-portal
 * page may build on (M16, `lib/db/parents.ts`'s `verifiedChildLinks`, which
 * is itself already filtered to VERIFIED). A PENDING link contributes
 * nothing here, which is what makes "inert until verified" true for the
 * child selector too, not just for the schedule read underneath it.
 */
export const getVerifiedParentChildren = cache(
  async (parentUserId: string): Promise<ParentChildOption[]> => {
    const links = await verifiedChildLinks(prisma, parentUserId);
    return links.map((link) => ({
      linkId: link.id,
      centerId: link.center.id,
      centerName: link.center.name,
      centerLogoUrl: centerLogoSrc(link.center),
      centerThemeColor: link.center.themeColor,
      studentProfileId: link.studentProfileId,
      childName: fullName(localName(link.studentProfile, link.studentProfile.user)),
    }));
  },
);

/**
 * Where a signed-in user with NO centre relation belongs (SYS): the platform
 * admin's console, the parent portal when they hold a verified child link
 * (a `ParentLink` is not a centre relation, so the hub would otherwise tell a
 * parent "not connected to a branch" with no way to their children), else the
 * hub's empty state.
 */
export async function homeWithoutBranch(user: Pick<User, "id" | "isPlatformAdmin">): Promise<string> {
  if (user.isPlatformAdmin) return ROUTES.adminCenters;
  const children = await getVerifiedParentChildren(user.id);
  return children.length > 0 ? ROUTES.parentHome : ROUTES.selectCenter;
}

export type ParentSession = {
  user: User;
  /** Verified children only — see `getVerifiedParentChildren`'s doc comment. */
  children: ParentChildOption[];
};

/**
 * The (parent) route group's gate (M16, spec §4.5 "Parent portal"). Any
 * signed-in `User` — a brand-new parent account has zero VERIFIED children
 * until OD-6's still-open verification step happens, and the page itself
 * renders that as an empty state rather than a redirect (mirroring
 * `requireStudentUser`'s "zero relations is a valid state to render" shape).
 */
export async function requireParentUser(): Promise<ParentSession> {
  const user = await getCurrentUser();
  if (!user) return redirectTo(ROUTES.login);

  const children = await getVerifiedParentChildren(user.id);
  return { user, children };
}

export function hasExperience(ctx: TenantContext, experience: Experience): boolean {
  switch (experience) {
    case "center":
      return ctx.roles.some((role) => isCenterStaffRole(role));
    case "teacher":
      return ctx.roles.includes("TEACHER");
    case "student":
      return ctx.roles.includes("STUDENT");
  }
}

/** Route-group role gate: resolves context and bounces users who don't belong. */
export async function requireExperience(
  experience: Experience,
): Promise<TenantContext> {
  const ctx = await getTenantContext(experience);
  if (ctx.experienceDenied || !hasExperience(ctx, experience)) {
    return redirectTo(homePathForRole(ctx.role));
  }
  return ctx;
}

/**
 * The Server Action guard (SEC-09, SEC-44). A layout's `requireExperience`
 * protects pages, never actions — so every `(teacher)` action that has no
 * permission check of its own, and anything else that needs it, resolves its
 * context through here: `null` (the caller answers FORBIDDEN, never a
 * redirect) unless the user holds an **active** role of this experience at
 * the active centre. `ctxCan` refuses a denied context on its own too, which
 * is what covers every `(center)` action.
 */
export async function actionContext(experience: Experience): Promise<TenantContext | null> {
  const ctx = await getTenantContext(experience);
  if (ctx.experienceDenied || !hasExperience(ctx, experience)) return null;
  return ctx;
}

/**
 * Authoritative permission check bound to the resolved context. A context
 * whose requested experience was denied grants nothing (SEC-09) — this is the
 * one choke point every `(center)` Server Action already passes through.
 */
export function ctxCan(ctx: TenantContext, permission: Permission): boolean {
  return canInContext(ctx, permission);
}

export async function requirePermission(
  ctx: TenantContext,
  permission: Permission,
): Promise<void> {
  if (!ctxCan(ctx, permission)) {
    await redirectTo(homePathForRole(ctx.role));
  }
}

export async function requirePlatformAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) return redirectTo(ROUTES.login);
  if (!user.isPlatformAdmin) {
    const relations = await getUserCenterRelations(user.id);
    const role = relations[0] ? (roleForExperience(relations[0]) ?? "STUDENT") : "STUDENT";
    return redirectTo(homePathForRole(role));
  }
  return user;
}
