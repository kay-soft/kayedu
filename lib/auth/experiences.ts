import type { Center, PrismaClient } from "@prisma/client";
import { z } from "zod";

// Relative imports only (like `relations.ts`): `check:account` and
// `check:people` run the REAL list and the REAL cookie rule outside Next.js.
import { isCenterStaffRole, type TenantRole } from "./permissions.ts";
import {
  resolveCenterRelations,
  resolveOwnerOrgGroups,
  type CenterRelation,
  type OwnerOrgGroup,
} from "./relations.ts";
import { activeChildLinks } from "../db/parents.ts";
import { ROUTES } from "../routes.ts";
import { centerLogoSrc } from "../storage-paths.ts";

/**
 * Every experience one account has, and the cookie that remembers the last one
 * used (W5, D-W13, D-W34; docs/02-architecture.md §4 "Experiences").
 *
 * There is exactly one list: the hub, the header switcher and sign-in's landing
 * all read it. It is **derived on every request from the existing resolvers**
 * (`resolveCenterRelations`, the Owner's organization groups, `activeChildLinks`,
 * `User.isPlatformAdmin`), so a suspended, archived or deleted branch, an ended
 * membership or a revoked family link drops out exactly as it does everywhere
 * else, and there is no second answer to "what can this person open".
 *
 * Listing grants nothing. An entry only names a route; the route's own gate
 * re-checks access and tenant on every request.
 *
 * A new kind plugs in here only: W7 adds `assistant` (one per teacher, key
 * `assistant:<teacherUserId>`), and W8's PERSONAL workspaces must be left out
 * of the staff step below (CLAUDE.md rule 13), so one never reads as a branch.
 */
export type ExperienceKind = "staff" | "rollup" | "student" | "teacher" | "parent" | "admin";

/** Which glyph an entry shows — mapped to an icon in `components/shell/experience-glyph.tsx`. */
export type ExperienceIcon = "branch" | "wholeManagement" | "student" | "teacher" | "parent" | "admin";

/** How the list groups: staff per organization; the portals; the platform. */
export type ExperienceGroup =
  | { kind: "portals" }
  | { kind: "organization"; organizationId: string; name: string | null }
  | { kind: "platform" };

export type ExperienceEntry = {
  /** Stable across requests: `staff:<centerId>`, `org:<organizationId>`, `student`, `teacher`, `parent`, `admin`. */
  key: string;
  kind: ExperienceKind;
  icon: ExperienceIcon;
  /** Role + place. Role keys are `Roles.*` messages; the place is data (never translated here). */
  label: { roles: TenantRole[]; place: string | null };
  /** The experience's real landing route: never a query, never a remembered page. */
  href: string;
  /** The staff branch this entry makes active (`kayedu_center`). */
  centerId?: string;
  /** The organization a staff or Whole Management entry belongs to. */
  organizationId?: string;
  group: ExperienceGroup;
  /** A branch's own mark, for a staff entry. */
  brand?: { name: string; logoUrl: string | null; themeColor: string };
  /** Whole Management only: how many branches it sums. */
  branchCount?: number;
};

export type ExperienceSources = {
  relations: CenterRelation[];
  orgGroups: OwnerOrgGroup[];
  hasLinkedChild: boolean;
  isPlatformAdmin: boolean;
  organizationNames: ReadonlyMap<string, string>;
};

export function staffExperienceKey(centerId: string): string {
  return `staff:${centerId}`;
}

export function rollupExperienceKey(organizationId: string): string {
  return `org:${organizationId}`;
}

function branchBrand(center: Center): ExperienceEntry["brand"] {
  return { name: center.name, logoUrl: centerLogoSrc(center), themeColor: center.themeColor };
}

/**
 * The list, from what the resolvers returned. Portals first (each spans every
 * branch), then each organization's staff entries with its Whole Management on
 * top, then the platform console.
 */
export function buildExperiences(sources: ExperienceSources): ExperienceEntry[] {
  const { relations, orgGroups, hasLinkedChild, isPlatformAdmin, organizationNames } = sources;
  const entries: ExperienceEntry[] = [];

  if (relations.some((relation) => relation.roles.includes("STUDENT"))) {
    entries.push({
      key: "student",
      kind: "student",
      icon: "student",
      label: { roles: ["STUDENT"], place: null },
      href: ROUTES.studentSchedule,
      group: { kind: "portals" },
    });
  }
  if (relations.some((relation) => relation.roles.includes("TEACHER"))) {
    entries.push({
      key: "teacher",
      kind: "teacher",
      icon: "teacher",
      label: { roles: ["TEACHER"], place: null },
      href: ROUTES.teacherDashboard,
      group: { kind: "portals" },
    });
  }
  if (hasLinkedChild) {
    entries.push({
      key: "parent",
      kind: "parent",
      icon: "parent",
      label: { roles: ["PARENT"], place: null },
      href: ROUTES.parentHome,
      group: { kind: "portals" },
    });
  }

  const staffRelations = relations.filter((relation) => relation.roles.some((role) => isCenterStaffRole(role)));
  const organizationIds = [
    ...new Set([
      ...orgGroups.map((group) => group.organizationId),
      ...staffRelations.map((relation) => relation.center.organizationId),
    ]),
  ].sort((a, b) => (organizationNames.get(a) ?? "").localeCompare(organizationNames.get(b) ?? ""));

  for (const organizationId of organizationIds) {
    const group: ExperienceGroup = {
      kind: "organization",
      organizationId,
      name: organizationNames.get(organizationId) ?? null,
    };
    const rollup = orgGroups.find((item) => item.organizationId === organizationId);
    if (rollup) {
      entries.push({
        key: rollupExperienceKey(organizationId),
        kind: "rollup",
        icon: "wholeManagement",
        label: { roles: ["OWNER"], place: rollup.organizationName },
        href: ROUTES.centerAnalytics,
        organizationId,
        group,
        branchCount: rollup.branches.length,
      });
    }
    for (const relation of staffRelations) {
      if (relation.center.organizationId !== organizationId) continue;
      entries.push({
        key: staffExperienceKey(relation.center.id),
        kind: "staff",
        icon: "branch",
        label: { roles: relation.roles.filter((role) => isCenterStaffRole(role)), place: relation.center.name },
        href: ROUTES.centerDashboard,
        centerId: relation.center.id,
        organizationId,
        group,
        brand: branchBrand(relation.center),
      });
    }
  }

  if (isPlatformAdmin) {
    entries.push({
      key: "admin",
      kind: "admin",
      icon: "admin",
      label: { roles: ["PLATFORM_ADMIN"], place: null },
      href: ROUTES.adminCenters,
      group: { kind: "platform" },
    });
  }

  return entries;
}

/** The reads the list is built from. `lib/auth/tenant.ts` hands in its per-request cached ones. */
export type ExperienceReads = {
  relations: (userId: string) => Promise<CenterRelation[]>;
  orgGroups: (userId: string) => Promise<OwnerOrgGroup[]>;
  hasLinkedChild: (userId: string) => Promise<boolean>;
  isPlatformAdmin: (userId: string) => Promise<boolean>;
};

/** The same resolvers with no request cache: what a gate runs. */
export function directExperienceReads(prisma: PrismaClient): ExperienceReads {
  return {
    relations: (userId) => resolveCenterRelations(prisma, userId),
    orgGroups: async (userId) => resolveOwnerOrgGroups(prisma, await resolveCenterRelations(prisma, userId)),
    hasLinkedChild: async (userId) => (await activeChildLinks(prisma, userId)).length > 0,
    isPlatformAdmin: async (userId) =>
      (await prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } }))?.isPlatformAdmin ?? false,
  };
}

export async function loadExperiences(
  prisma: PrismaClient,
  userId: string,
  reads: ExperienceReads = directExperienceReads(prisma),
): Promise<ExperienceEntry[]> {
  const [relations, orgGroups, hasLinkedChild, isPlatformAdmin] = await Promise.all([
    reads.relations(userId),
    reads.orgGroups(userId),
    reads.hasLinkedChild(userId),
    reads.isPlatformAdmin(userId),
  ]);
  // `Organization` is global, not a tenant table (CLAUDE.md rule 1): only the
  // names of organizations these relations already resolved.
  const organizationIds = [
    ...new Set(
      relations
        .filter((relation) => relation.roles.some((role) => isCenterStaffRole(role)))
        .map((relation) => relation.center.organizationId),
    ),
  ];
  const organizations =
    organizationIds.length > 0
      ? await prisma.organization.findMany({ where: { id: { in: organizationIds } }, select: { id: true, name: true } })
      : [];
  return buildExperiences({
    relations,
    orgGroups,
    hasLinkedChild,
    isPlatformAdmin,
    organizationNames: new Map(organizations.map((organization) => [organization.id, organization.name])),
  });
}

// ── The remembered experience ────────────────────────────────────────────────

/** A hint only (D-W34): it orders and labels the hub, and it never grants or selects anything. */
export const LAST_EXPERIENCE_COOKIE = "kayedu_last_experience";

const lastExperienceSchema = z
  .object({
    key: z.string().min(1).max(120),
    centerId: z.string().min(1).max(64).optional(),
  })
  .strict();

export type LastExperience = z.infer<typeof lastExperienceSchema>;

export function lastExperienceOf(entry: Pick<ExperienceEntry, "key" | "centerId">): LastExperience {
  return entry.centerId ? { key: entry.key, centerId: entry.centerId } : { key: entry.key };
}

/** The cookie's value, or null when it is not one the app wrote. */
export function parseLastExperience(raw: string | null | undefined): LastExperience | null {
  if (!raw || raw.length > 256) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = lastExperienceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What a stored value means **against the current list**: the entry it still
 * names, or `stale` (access lost, or a tampered value) so the caller ignores
 * and clears it. The list is always the authority: a value only ever picks an
 * entry the person already holds, so it cannot widen anything.
 */
export function resolveLastExperience(
  raw: string | null | undefined,
  entries: ExperienceEntry[],
): { entry: ExperienceEntry | null; stale: boolean } {
  if (!raw) return { entry: null, stale: false };
  const last = parseLastExperience(raw);
  const entry = last ? entries.find((item) => item.key === last.key) : undefined;
  if (!last || !entry || (last.centerId ?? null) !== (entry.centerId ?? null)) {
    return { entry: null, stale: true };
  }
  return { entry, stale: false };
}
