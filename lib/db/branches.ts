import type { Center, CenterLifecycleState, Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose — `npm run check:branches` and
// `check:permissions` exercise this module directly, outside the Next.js
// runtime (same reasoning as lib/db/platform.ts). The client is injected.
import { can } from "../auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../auth/relations.ts";
import { writeAuditRow } from "./audit-row.ts";
import {
  ACCESSIBLE_LIFECYCLE_STATES,
  COUNTED_BRANCHES,
  lockOrganizationBranches,
  provisionBranch,
} from "./platform.ts";
import { baselineGrantKeys } from "./provision.ts";
import type { BranchCopyKey } from "../branch-setup.ts";
import { runInTransaction } from "./session-lifecycle.ts";

/**
 * An Owner's own "Add branch" (F1, OD-12 (b), docs/00 §5.1 "Branch
 * architecture"). The organization's limit is set by a platform admin
 * (`Organization.maxBranches`, `lib/db/platform.ts`); an Owner adds branches
 * up to it from Settings → Branches.
 *
 * **This module is the authority, not the page.** `addBranchAsOwner` takes
 * the actor's id and the branch they act from — never an organization id —
 * re-resolves the actor's relations itself (`resolveCenterRelations`, the
 * resolution `getTenantContext()` runs on), and refuses unless they resolve to
 * a role that `can()` grants `organization.branch.create`, an OWNER-only
 * ceiling action. The organization is the acting branch's own, so a branch can
 * never be added to another customer's organization by naming it; the setup
 * source must be a branch of that same organization the actor also owns.
 *
 * One transaction: lock the organization row, recount, refuse at the limit,
 * create the branch through `provisionBranch` (the same path Super Admin
 * uses — no second provisioning implementation), apply the ticked copies,
 * pick a unique slug, audit `organization.branch.create`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type OwnerBranchInput = {
  actorUserId: string;
  /** The branch the Owner is acting from — its organization is the target. */
  actingCenterId: string;
  /** "Copy setup from"; must be a branch of the same organization. */
  copyFromCenterId: string;
  name: string;
  nameEn: string | null;
  themeColor: string;
  timezone: string;
  copy: readonly BranchCopyKey[];
};

export type OwnerBranchResult =
  | { ok: true; center: Center }
  | {
      ok: false;
      error: "forbidden" | "sourceNotFound" | "branchLimitReached" | "tryAgain";
    };

export async function addBranchAsOwner(
  db: PrismaClient,
  input: OwnerBranchInput,
): Promise<OwnerBranchResult> {
  const relations = await resolveCenterRelations(db, input.actorUserId);
  const acting = relations.find((relation) => relation.center.id === input.actingCenterId);
  const actingRole = acting ? roleForExperience(acting, "center") : null;
  // `organization.branch.create` is ceiling-forced (OWNER_ONLY_ACTIONS): no
  // stored grant row is consulted, so none is loaded.
  if (!acting || !actingRole || !can(actingRole, "organization.branch.create")) {
    return { ok: false, error: "forbidden" };
  }
  const organizationId = acting.center.organizationId;

  const source = relations.find((relation) => relation.center.id === input.copyFromCenterId);
  const sourceRole = source ? roleForExperience(source, "center") : null;
  if (
    !source ||
    source.center.organizationId !== organizationId ||
    !sourceRole ||
    !can(sourceRole, "organization.branch.create")
  ) {
    return { ok: false, error: "sourceNotFound" };
  }

  try {
    return await runInTransaction(db, async (tx): Promise<OwnerBranchResult> => {
      const lock = await lockOrganizationBranches(tx, organizationId);
      if (!lock) return { ok: false, error: "forbidden" };
      if (lock.used >= lock.maxBranches) return { ok: false, error: "branchLimitReached" };

      // The new branch takes the lifecycle state of the one the Owner acts
      // from, read under the lock; afterwards only the admin transitions it.
      const from = await tx.center.findUnique({
        where: { id: input.actingCenterId },
        select: { slug: true, lifecycleState: true },
      });
      if (!from || !ACCESSIBLE_LIFECYCLE_STATES.includes(from.lifecycleState)) {
        return { ok: false, error: "forbidden" };
      }

      const center = await provisionBranch(tx, {
        organizationId,
        name: input.name,
        nameEn: input.nameEn,
        slug: await uniqueBranchSlug(tx, input.nameEn, from.slug),
        themeColor: input.themeColor,
        lifecycleState: from.lifecycleState,
      });
      await tx.centerSettings.update({
        where: { centerId: center.id },
        data: { timezone: input.timezone },
      });
      const copied = await copyBranchSetup(tx, source.center.id, center.id, input.copy);

      await writeAuditRow(tx, {
        centerId: center.id,
        actorUserId: input.actorUserId,
        action: "organization.branch.create",
        entityType: "Center",
        entityId: center.id,
        after: {
          organizationId,
          actingCenterId: input.actingCenterId,
          sourceCenterId: source.center.id,
          lifecycleState: center.lifecycleState,
          copied,
          usedBefore: lock.used,
          maxBranches: lock.maxBranches,
        },
      });
      return { ok: true, center };
    });
  } catch (error) {
    // Only the slug can collide (another organization took it between the
    // check and the insert) — nothing was written; asking again picks anew.
    if (isUniqueViolation(error)) return { ok: false, error: "tryAgain" };
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Object && "code" in error && (error as { code?: string }).code === "P2002";
}

/** Lowercase letters, digits and single hyphens — the shape `Center.slug` takes everywhere. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * The new branch's slug: from its English name when it has a usable one, else
 * from the acting branch's slug, then the first free `-2`, `-3`… The Owner
 * never types one; the unique index is still the final word (`tryAgain`).
 */
async function uniqueBranchSlug(
  tx: Prisma.TransactionClient,
  nameEn: string | null,
  fromSlug: string,
): Promise<string> {
  const fromName = nameEn ? slugify(nameEn) : "";
  const base = fromName.length >= 2 ? fromName : slugify(`${fromSlug}-branch`);
  const taken = new Set(
    (
      await tx.center.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Copies the ticked setup from one branch to a branch created in this same
 * transaction. **Never copied**, by construction — nothing here reads them:
 * rooms, classes, sessions, people (memberships, students, invitations),
 * money (payments, refunds, settlements, expenses and their categories), the
 * ID-card layout and the logo. Returns the keys it applied, for the audit row.
 */
export async function copyBranchSetup(
  tx: Prisma.TransactionClient,
  fromCenterId: string,
  toCenterId: string,
  keys: readonly BranchCopyKey[],
): Promise<BranchCopyKey[]> {
  const wanted = new Set(keys);
  const applied: BranchCopyKey[] = [];

  if (wanted.has("catalog")) {
    // The picks with the centre's own renames and base prices (M13, R8).
    const selections = await tx.centerCatalogSelection.findMany({
      where: { centerId: fromCenterId, active: true },
    });
    if (selections.length > 0) {
      await tx.centerCatalogSelection.createMany({
        data: selections.map((row) => ({
          centerId: toCenterId,
          kind: row.kind,
          educationSystemId: row.educationSystemId,
          gradeId: row.gradeId,
          subjectId: row.subjectId,
          displayNameAr: row.displayNameAr,
          displayNameEn: row.displayNameEn,
          basePrice: row.basePrice,
        })),
        skipDuplicates: true,
      });
    }
    applied.push("catalog");
  }

  if (wanted.has("paymentMethods")) {
    // Replace the defaults the baseline just wrote — nothing references them
    // yet — with the source's active methods. A branch always keeps one
    // active method (R1); the source has one by the same rule, and when it
    // somehow has none the defaults stay.
    const methods = await tx.centerPaymentMethod.findMany({
      where: { centerId: fromCenterId, active: true },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    });
    if (methods.length > 0) {
      await tx.centerPaymentMethod.deleteMany({ where: { centerId: toCenterId } });
      await tx.centerPaymentMethod.createMany({
        data: methods.map((method) => ({ centerId: toCenterId, name: method.name })),
      });
    }
    applied.push("paymentMethods");
  }

  if (wanted.has("terms")) {
    // Presets only — a class copies a term's dates, never links to it (R4).
    const terms = await tx.centerTerm.findMany({
      where: { centerId: fromCenterId, active: true },
      select: { name: true, startDate: true, endDate: true },
    });
    if (terms.length > 0) {
      await tx.centerTerm.createMany({
        data: terms.map((term) => ({ ...term, centerId: toCenterId })),
      });
    }
    applied.push("terms");
  }

  if (wanted.has("holidays")) {
    const holidays = await tx.holiday.findMany({
      where: { centerId: fromCenterId },
      select: { date: true, name: true },
    });
    if (holidays.length > 0) {
      await tx.holiday.createMany({
        data: holidays.map((holiday) => ({ ...holiday, centerId: toCenterId })),
        skipDuplicates: true,
      });
    }
    applied.push("holidays");
  }

  if (wanted.has("permissions")) {
    // The new branch behaves exactly as the source does: every stored cell
    // is copied, and a baseline cell the source has no row for (denied there)
    // is stored as denied here — so the new branch has no baseline gap
    // (`centerBaselineGaps`) and grants nothing the source does not.
    const rows = await tx.permissionGrant.findMany({
      where: { centerId: fromCenterId },
      select: { role: true, action: true, allowed: true },
    });
    const writes = new Map<string, { role: Role; action: string; allowed: boolean }>();
    for (const key of baselineGrantKeys()) {
      const [role, action] = key.split(":") as [Role, string];
      writes.set(key, { role, action, allowed: false });
    }
    for (const row of rows) writes.set(`${row.role}:${row.action}`, row);
    for (const write of writes.values()) {
      await tx.permissionGrant.upsert({
        where: { centerId_role_action: { centerId: toCenterId, role: write.role, action: write.action } },
        update: { allowed: write.allowed },
        create: { centerId: toCenterId, role: write.role, action: write.action, allowed: write.allowed },
      });
    }
    applied.push("permissions");
  }

  if (wanted.has("generalSettings")) {
    const settings = await tx.centerSettings.findUnique({ where: { centerId: fromCenterId } });
    if (settings) {
      await tx.centerSettings.update({
        where: { centerId: toCenterId },
        data: {
          defaultShareType: settings.defaultShareType,
          defaultShareValue: settings.defaultShareValue,
          defaultLateThreshold: settings.defaultLateThreshold,
          scheduleConflictPolicy: settings.scheduleConflictPolicy,
          dataVisibilityDays: settings.dataVisibilityDays,
          teacherEditDeadlineHours: settings.teacherEditDeadlineHours,
        },
      });
    }
    applied.push("generalSettings");
  }

  return applied;
}

export type OrganizationBranchUsage = {
  maxBranches: number;
  /** Non-ARCHIVED branches — what the limit counts. */
  used: number;
  branches: {
    id: string;
    name: string;
    nameEn: string | null;
    lifecycleState: CenterLifecycleState;
  }[];
};

/**
 * Settings → Branches: the organization's limit, its usage and every branch
 * with its lifecycle state. Takes the organization id the caller resolved
 * from `getTenantContext()` — `Organization` isolates nothing, so there is no
 * `centerId` to scope this by (docs/01, Organization layer).
 */
export async function organizationBranchUsage(
  db: Db,
  organizationId: string,
): Promise<OrganizationBranchUsage | null> {
  const [organization, branches, used] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId }, select: { maxBranches: true } }),
    db.center.findMany({
      where: { organizationId },
      select: { id: true, name: true, nameEn: true, lifecycleState: true },
      orderBy: { createdAt: "asc" },
    }),
    db.center.count({ where: { organizationId, ...COUNTED_BRANCHES } }),
  ]);
  if (!organization) return null;
  return { maxBranches: organization.maxBranches, used, branches };
}
