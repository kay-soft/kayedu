import type { Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports only — `npm run check:permissions`, `check:admin`, the seed
// and `seed:verify` all call this outside the Next.js runtime (the same
// discipline as lib/db/permissions.ts and lib/db/platform.ts).
import { DEFAULT_ROLE_GRANTS } from "../auth/permissions.ts";
import { ensureDefaultPaymentMethods } from "./payment-methods.ts";

/**
 * **The one definition of "a centre that works"** (P1, docs/02-architecture.md
 * §6.1 "Provisioning a centre").
 *
 * The permission matrix is deny-by-default, so a `Center` row on its own is a
 * centre nobody can do anything in: an Owner who signs in sees the Dashboard
 * and nothing else, because every other nav item and page is gated on a stored
 * `PermissionGrant` row. P1 found exactly that in the dev database — the
 * seeded Center 60 branches had been created with `prisma.center.upsert` and
 * never given a baseline. Every path that creates a centre therefore goes
 * through this function and **only** this function:
 *
 *  - `lib/db/platform.ts`'s `createCenterWithSettings` (Super Admin
 *    provisioning, M9), and
 *  - `prisma/seed.ts` (the demo organizations),
 *
 * and a gate fixture that needs a working centre may call it too. A
 * statically-asserted rule in `check:permissions` keeps both callers honest.
 *
 * What a new centre needs, and nothing more:
 *  1. its `CenterSettings` row (default cut 15%, 10-minute late threshold,
 *     Cairo time — the same defaults the M9 provisioning step always used);
 *  2. the baseline `PermissionGrant` rows — `DEFAULT_ROLE_GRANTS`, the one
 *     canonical list the M12 migration also backfilled from;
 *  3. the default payment methods (Cash / InstaPay / Vodafone Cash — a centre
 *     must always have at least one active method, R1).
 *
 * Deliberately **not** here: rooms, terms, catalog picks, expense categories,
 * staff, anything the centre authors itself (those are configuration, not the
 * floor a centre stands on).
 *
 * **Idempotent and non-destructive.** Every part only fills what is missing:
 * the settings row is created, never rewritten; a grant row that already
 * exists keeps whatever `allowed` value an Owner set (so re-running this never
 * undoes a deliberate change in `/settings/permissions`); the payment methods
 * are only added to a centre that has none at all.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The defaults a new centre's settings row starts from (docs/01 §2). */
export const BASELINE_SETTINGS = {
  defaultShareType: "PERCENTAGE",
  defaultShareValue: 15,
  defaultLateThreshold: 10,
  timezone: "Africa/Cairo",
} as const;

export type BaselineGrantKey = `${Role}:${string}`;

/** Every `ROLE:action` pair the baseline stores — what a complete centre holds. */
export function baselineGrantKeys(): BaselineGrantKey[] {
  return (Object.entries(DEFAULT_ROLE_GRANTS) as [Role, readonly string[]][]).flatMap(
    ([role, actions]) => actions.map((action): BaselineGrantKey => `${role}:${action}`),
  );
}

export type ProvisionReport = {
  settingsCreated: boolean;
  grantsCreated: number;
  paymentMethodsCreated: number;
};

export async function provisionCenterBaseline(
  tx: Db,
  centerId: string,
): Promise<ProvisionReport> {
  const hadSettings =
    (await tx.centerSettings.findUnique({ where: { centerId }, select: { id: true } })) !== null;
  if (!hadSettings) {
    await tx.centerSettings.create({ data: { centerId, ...BASELINE_SETTINGS } });
  }

  const grants = await tx.permissionGrant.createMany({
    data: (Object.entries(DEFAULT_ROLE_GRANTS) as [Role, readonly string[]][]).flatMap(
      ([role, actions]) => actions.map((action) => ({ centerId, role, action, allowed: true })),
    ),
    skipDuplicates: true,
  });

  const methodsBefore = await tx.centerPaymentMethod.count({ where: { centerId } });
  await ensureDefaultPaymentMethods(tx, centerId);
  const methodsAfter = await tx.centerPaymentMethod.count({ where: { centerId } });

  return {
    settingsCreated: !hadSettings,
    grantsCreated: grants.count,
    paymentMethodsCreated: methodsAfter - methodsBefore,
  };
}

export type BaselineGaps = {
  missingSettings: boolean;
  /** `ROLE:action` pairs the baseline defines that this centre has no row for. */
  missingGrants: BaselineGrantKey[];
  activePaymentMethods: number;
};

/**
 * Read-only: what a centre lacks of the baseline. A row that exists with
 * `allowed: false` is **not** a gap — an Owner switching a baseline action off
 * is a deliberate configuration, and this never second-guesses it. Used by
 * `scripts/diagnose-nav.ts`, `scripts/seed-verify.ts` and the gates; it never
 * writes (P1: existing centres are reported, never silently backfilled).
 */
export async function centerBaselineGaps(db: Db, centerId: string): Promise<BaselineGaps> {
  const [settings, rows, activePaymentMethods] = await Promise.all([
    db.centerSettings.findUnique({ where: { centerId }, select: { id: true } }),
    db.permissionGrant.findMany({ where: { centerId }, select: { role: true, action: true } }),
    db.centerPaymentMethod.count({ where: { centerId, active: true } }),
  ]);
  const have = new Set(rows.map((row) => `${row.role}:${row.action}`));
  return {
    missingSettings: settings === null,
    missingGrants: baselineGrantKeys().filter((key) => !have.has(key)),
    activePaymentMethods,
  };
}

export function hasFullBaseline(gaps: BaselineGaps): boolean {
  return !gaps.missingSettings && gaps.missingGrants.length === 0 && gaps.activePaymentMethods > 0;
}
