import { cache } from "react";
import { getLocale } from "next-intl/server";
import type {
  Center,
  CenterSettings,
  Membership,
  Role,
  StudentProfile,
  User,
} from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { getActiveCenterId } from "@/lib/auth/active-center";
import {
  ROLE_PRECEDENCE,
  can,
  isCenterStaffRole,
  permissionGrantsFromSettings,
  type Permission,
  type PermissionGrants,
  type TenantRole,
} from "@/lib/auth/permissions";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

export type Experience = "center" | "teacher" | "student";

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
};

export type CenterRelation = {
  center: Center;
  memberships: Membership[];
  studentProfile: StudentProfile | null;
  roles: TenantRole[];
};

/**
 * The permission-grant seam is re-exported here because this is where the
 * TenantContext is assembled; the function itself lives in
 * lib/auth/permissions.ts so it stays free of runtime imports.
 */
export { permissionGrantsFromSettings };

/** Drops the joined `center` relation so the row matches its Prisma model type. */
function withoutCenter<T extends { center: unknown }>(row: T): Omit<T, "center"> {
  const copy: Record<string, unknown> = { ...row };
  delete copy.center;
  return copy as Omit<T, "center">;
}

function rolePrecedence(role: TenantRole): number {
  const index = ROLE_PRECEDENCE.indexOf(role as Role);
  // STUDENT / PLATFORM_ADMIN aren't Memberships — they sort last.
  return index === -1 ? ROLE_PRECEDENCE.length : index;
}

/** Highest-authority role first, so `roles[0]` is the role to land the user in. */
function sortRoles(roles: TenantRole[]): TenantRole[] {
  return [...new Set(roles)].sort((a, b) => rolePrecedence(a) - rolePrecedence(b));
}

/** The role a user acts with at a center when no experience is requested. */
export function primaryRole(relation: CenterRelation): TenantRole {
  return relation.roles[0] ?? "STUDENT";
}

const OWNER_ROLE: Role = "OWNER";

/**
 * Every center this user is connected to, as staff/teacher and/or as a
 * student — plus, for an OWNER, every *other* branch under the same
 * organization as a branch they already hold (M11, docs/01-data-model.md §4
 * "Branch (organization) visibility").
 *
 * This is the "widened by organizationId" resolution the milestone chose over
 * a nullable `Membership.centerId` (see docs/02-architecture.md §4): an
 * Owner's real `Membership` row is untouched — same `centerId`, same
 * `@@unique([userId, centerId, role])` — so every non-Owner role and every
 * existing Owner-at-their-own-branch behavior is provably unchanged. The only
 * new thing is that an Owner membership at branch A additionally resolves a
 * *synthetic* relation for every sibling branch B under A's organization,
 * carrying a per-branch view of the same membership row (same `id`, `centerId`
 * swapped to B). `buildContext()` still just reads `relation.center.id` as the
 * centerId to scope on, so a sibling relation scopes to B's real data exactly
 * like a real Membership at B would — `lib/db/scoped.ts` needs no changes at
 * all to support it.
 */
export const getUserCenterRelations = cache(
  async (userId: string): Promise<CenterRelation[]> => {
    const memberships = await prisma.membership.findMany({
      where: { userId, active: true, center: { active: true } },
      include: { center: true },
    });

    const ownerOrgIds = [
      ...new Set(
        memberships
          .filter((membership) => membership.role === OWNER_ROLE)
          .map((membership) => membership.center.organizationId),
      ),
    ];

    const [studentProfiles, siblingBranches] = await Promise.all([
      prisma.studentProfile.findMany({
        where: { userId, active: true, center: { active: true } },
        include: { center: true },
      }),
      ownerOrgIds.length > 0
        ? prisma.center.findMany({
            where: { organizationId: { in: ownerOrgIds }, active: true },
          })
        : Promise.resolve([]),
    ]);

    const byCenter = new Map<string, CenterRelation>();

    const ensure = (center: Center): CenterRelation => {
      const existing = byCenter.get(center.id);
      if (existing) return existing;
      const created: CenterRelation = {
        center,
        memberships: [],
        studentProfile: null,
        roles: [],
      };
      byCenter.set(center.id, created);
      return created;
    };

    for (const membership of memberships) {
      const relation = ensure(membership.center);
      relation.memberships.push(withoutCenter(membership));
      relation.roles.push(membership.role);
    }

    // Widen: every Owner membership's organization reaches every branch under
    // it, even branches with no real Membership row. A branch this user
    // already holds a real membership at (its own branch, or one they also
    // happen to be TEACHER/STUDENT at) is skipped — the real row above is
    // never shadowed by a synthetic one.
    const branchesByOrg = new Map<string, Center[]>();
    for (const branch of siblingBranches) {
      const list = branchesByOrg.get(branch.organizationId) ?? [];
      list.push(branch);
      branchesByOrg.set(branch.organizationId, list);
    }
    for (const membership of memberships) {
      if (membership.role !== OWNER_ROLE) continue;
      const siblings = branchesByOrg.get(membership.center.organizationId) ?? [];
      for (const branch of siblings) {
        if (branch.id === membership.centerId) continue;
        const relation = ensure(branch);
        if (relation.roles.includes(OWNER_ROLE)) continue;
        relation.memberships.push({ ...withoutCenter(membership), centerId: branch.id });
        relation.roles.push(OWNER_ROLE);
      }
    }

    for (const profile of studentProfiles) {
      const relation = ensure(profile.center);
      relation.studentProfile = withoutCenter(profile);
      relation.roles.push("STUDENT");
    }

    return [...byCenter.values()]
      .map((relation) => ({ ...relation, roles: sortRoles(relation.roles) }))
      .sort((a, b) => a.center.name.localeCompare(b.center.name));
  },
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

function roleForExperience(
  relation: CenterRelation,
  experience?: Experience,
): TenantRole {
  const staff = relation.roles.find((role) => isCenterStaffRole(role));
  const teacher = relation.roles.find((role) => role === "TEACHER");
  const student = relation.roles.find((role) => role === "STUDENT");

  if (experience === "center" && staff) return staff;
  if (experience === "teacher" && teacher) return teacher;
  if (experience === "student" && student) return student;

  return staff ?? teacher ?? student ?? "STUDENT";
}

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

  const role = roleForExperience(relation, experience);
  const membership = relation.memberships.find((item) => item.role === role) ?? null;

  return {
    user,
    center: relation.center,
    settings,
    membership,
    studentProfile: relation.studentProfile,
    role,
    roles: relation.roles,
    grants: permissionGrantsFromSettings(settings),
    isPlatformAdmin: user.isPlatformAdmin,
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
 */
export const getTenantContext = cache(
  async (experience?: Experience): Promise<TenantContext> => {
    const user = await getCurrentUser();
    if (!user) return redirectTo(ROUTES.login);

    const relations = await getUserCenterRelations(user.id);

    if (relations.length === 0) {
      if (user.isPlatformAdmin) return redirectTo(ROUTES.adminCenters);
      return redirectTo(ROUTES.selectCenter);
    }

    const activeCenterId = await getActiveCenterId();
    let relation = activeCenterId
      ? relations.find((item) => item.center.id === activeCenterId)
      : undefined;

    if (!relation) {
      // Auto-select when there is exactly one center; otherwise go pick one.
      // (A Server Component cannot write the cookie — selecting persists it.)
      if (relations.length === 1) {
        relation = relations[0];
      } else {
        return redirectTo(ROUTES.selectCenter);
      }
    }

    return buildContext(user, relation, experience);
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
    logoUrl: session.studentRelation.center.logoUrl,
    themeColor: session.studentRelation.center.themeColor,
  };
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
  if (!hasExperience(ctx, experience)) {
    return redirectTo(homePathForRole(ctx.role));
  }
  return ctx;
}

/** Authoritative permission check bound to the resolved context. */
export function ctxCan(ctx: TenantContext, permission: Permission): boolean {
  return can(ctx.role, permission, ctx.grants);
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
    const role = relations[0] ? roleForExperience(relations[0]) : "STUDENT";
    return redirectTo(homePathForRole(role));
  }
  return user;
}
