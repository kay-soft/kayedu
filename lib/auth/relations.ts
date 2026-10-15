import type { Center, Membership, PrismaClient, Role, StudentProfile } from "@prisma/client";

// Relative imports only (P1): this is the pure half of `lib/auth/tenant.ts` —
// "which centres is this user connected to, in which roles" — pulled out so
// `scripts/diagnose-nav.ts` and `scripts/seed-verify.ts` can run the REAL
// resolution (not a copy of it) outside the Next.js runtime, where
// `next-intl/server`, `next/headers` and the `@/` alias do not resolve. It
// takes a `PrismaClient` as a parameter and has no cookie, no `cache()` and no
// redirect in it; `tenant.ts` wraps it with React's per-request `cache()`.
import {
  ROLE_PRECEDENCE,
  isBranchGrantableRole,
  isCenterStaffRole,
  type TenantRole,
} from "./permissions.ts";
import { membershipBranchGrantsFor } from "../db/permissions.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "../db/platform.ts";

export type Experience = "center" | "teacher" | "student";

export type CenterRelation = {
  center: Center;
  memberships: Membership[];
  studentProfile: StudentProfile | null;
  roles: TenantRole[];
};

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
export async function resolveCenterRelations(
  prisma: PrismaClient,
  userId: string,
): Promise<CenterRelation[]> {
  // Student profiles depend only on the user, not on the memberships, so that
  // read starts now and runs alongside the memberships (and their centre join)
  // instead of after them — one fewer serial round trip (docs/08 §4.6.2).
  const studentProfilesPromise = prisma.studentProfile.findMany({
    where: {
      userId,
      active: true,
      center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    },
    include: { center: true },
  });
  // If the memberships read throws first, this one must not surface as an
  // unhandled rejection (it is awaited below only on the success path).
  studentProfilesPromise.catch(() => undefined);

  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      active: true,
      center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    },
    include: { center: true },
  });

  const ownerOrgIds = [
    ...new Set(
      memberships
        .filter((membership) => membership.role === OWNER_ROLE)
        .map((membership) => membership.center.organizationId),
    ),
  ];

  const branchGrantableMembershipIds = memberships
    .filter((membership) => isBranchGrantableRole(membership.role))
    .map((membership) => membership.id);

  const [studentProfiles, siblingBranches, branchGrantsByMembership] = await Promise.all([
    studentProfilesPromise,
    ownerOrgIds.length > 0
      ? prisma.center.findMany({
          where: {
            organizationId: { in: ownerOrgIds },
            lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] },
          },
        })
      : Promise.resolve([]),
    membershipBranchGrantsFor(prisma, branchGrantableMembershipIds),
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

  // Widen again: an Owner-granted MembershipBranchGrant lets a
  // MANAGER/RECEPTIONIST/ACCOUNTANT membership additionally reach specific
  // extra branches (M12) — additive only, and bounded to exactly the
  // branches an Owner explicitly granted, unlike the Owner's own
  // every-sibling-branch widening above.
  for (const membership of memberships) {
    if (!isBranchGrantableRole(membership.role)) continue;
    const grantedBranches = branchGrantsByMembership.get(membership.id) ?? [];
    for (const branch of grantedBranches) {
      if (branch.id === membership.centerId) continue;
      const relation = ensure(branch);
      if (relation.roles.includes(membership.role)) continue;
      relation.memberships.push({ ...withoutCenter(membership), centerId: branch.id });
      relation.roles.push(membership.role);
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
}

/**
 * The role a user acts with at a center for a given experience — or, with no
 * experience asked for, their highest role there.
 *
 * SEC-09: when an experience **is** asked for and the user holds no role of
 * that kind here, the answer is `null` — a denial, never a fall-back to
 * whatever role they do hold. (Before SEC-2a a TEACHER-only member resolved
 * to TEACHER inside every centre Server Action and passed any gate the
 * matrix granted TEACHER.)
 */
export function roleForExperience(
  relation: CenterRelation,
  experience?: Experience,
): Role | "STUDENT" | null {
  const staff = relation.roles.find((role) => isCenterStaffRole(role));
  const teacher = relation.roles.find((role) => role === "TEACHER");
  const student = relation.roles.find((role) => role === "STUDENT");

  if (experience === "center") return staff ?? null;
  if (experience === "teacher") return teacher ?? null;
  if (experience === "student") return student ?? null;

  return staff ?? teacher ?? student ?? "STUDENT";
}
