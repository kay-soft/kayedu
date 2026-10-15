import type {
  CenterPaymentMethod,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { nameClashes } from "../like.ts";

/**
 * A centre's configurable payment methods (R1, docs/01-data-model.md §3 and
 * "Config layer"). Every rule that decides whether a method may change state
 * lives here, so a Server Action and `npm run check:payment-methods` exercise
 * the exact same code — no `@/` imports, for the same reason as
 * `lib/db/payments.ts`.
 *
 * The two invariants:
 * - **At least one active method per centre, always.** Deactivating or
 *   deleting the last active one is refused (`lastActiveMethod`). Each
 *   state change locks the centre's method rows first (`SELECT … FOR UPDATE`)
 *   so two concurrent deactivations can't each see "another one is still
 *   active" and together leave none.
 * - **History is never orphaned.** A method a `Payment` references is
 *   deactivated instead of deleted (the M18 hard-delete-only-when-unreferenced
 *   convention); the FK is `RESTRICT` as a backstop. A recorded payment shows
 *   its own frozen `methodLabelSnapshot`, so neither a rename nor a
 *   deactivation ever changes what history displays.
 *
 * `centerId` is taken explicitly (like `recordPayment`) — the caller resolves
 * it from `getTenantContext()`, never from the client.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** What a brand-new centre starts with (R1). Pickers list oldest first. */
export const DEFAULT_PAYMENT_METHOD_NAMES = ["Cash", "InstaPay", "Vodafone Cash"] as const;

/** Picker order: oldest first, so a centre's first method is the preselected one. */
export const PAYMENT_METHOD_ORDER: Prisma.CenterPaymentMethodOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/**
 * Rows for a nested `paymentMethods: { create: … }`, with `createdAt`
 * staggered by a millisecond so the defaults keep their stated order even
 * though they are written in one statement.
 */
export function defaultPaymentMethodRows(now: Date = new Date()): { name: string; createdAt: Date }[] {
  return DEFAULT_PAYMENT_METHOD_NAMES.map((name, index) => ({
    name,
    createdAt: new Date(now.getTime() + index),
  }));
}

/**
 * Gives a centre the default methods if it has none at all — idempotent, for
 * the seed and any configure path that may run twice. A centre that already
 * has methods (even only inactive ones) is left exactly as it is.
 */
export async function ensureDefaultPaymentMethods(db: Db, centerId: string): Promise<void> {
  const existing = await db.centerPaymentMethod.count({ where: { centerId } });
  if (existing > 0) return;
  await db.centerPaymentMethod.createMany({
    data: defaultPaymentMethodRows().map((row) => ({ ...row, centerId })),
  });
}

/** The methods a picker may offer — active only, in picker order. */
export function listActivePaymentMethods(db: Db, centerId: string): Promise<CenterPaymentMethod[]> {
  return db.centerPaymentMethod.findMany({
    where: { centerId, active: true },
    orderBy: PAYMENT_METHOD_ORDER,
  });
}

/**
 * The one lookup `recordPayment` trusts: this centre's row, and only if it
 * is active. Another centre's id, an inactive id and a made-up id all come
 * back `null` alike.
 */
export function findActivePaymentMethod(
  db: Db,
  centerId: string,
  paymentMethodId: string,
): Promise<CenterPaymentMethod | null> {
  return db.centerPaymentMethod.findFirst({
    where: { centerId, id: paymentMethodId, active: true },
  });
}

export type PaymentMethodChangeResult =
  | { ok: true; before: CenterPaymentMethod; after: CenterPaymentMethod | null }
  | { ok: false; error: "notFound" | "lastActiveMethod" | "duplicateName" };

async function lockCenterMethods(tx: Prisma.TransactionClient, centerId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "CenterPaymentMethod" WHERE "centerId" = ${centerId} FOR UPDATE`;
}

async function nameTaken(
  db: Db,
  centerId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  // SEC-61: compared by the one name key, never with an (I)LIKE.
  const others = await db.centerPaymentMethod.findMany({
    where: { centerId, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { name: true },
  });
  return nameClashes(name, others);
}

export async function createPaymentMethod(
  db: Db,
  centerId: string,
  name: string,
): Promise<{ ok: true; method: CenterPaymentMethod } | { ok: false; error: "duplicateName" }> {
  if (await nameTaken(db, centerId, name)) return { ok: false, error: "duplicateName" };
  const method = await db.centerPaymentMethod.create({ data: { centerId, name } });
  return { ok: true, method };
}

/**
 * Renames a method. Recorded payments keep their own `methodLabelSnapshot`,
 * so this changes only what future payments are labelled.
 */
export async function renamePaymentMethod(
  db: Db,
  centerId: string,
  id: string,
  name: string,
): Promise<PaymentMethodChangeResult> {
  const before = await db.centerPaymentMethod.findFirst({ where: { centerId, id } });
  if (!before) return { ok: false, error: "notFound" };
  if (await nameTaken(db, centerId, name, id)) return { ok: false, error: "duplicateName" };
  const after = await db.centerPaymentMethod.update({ where: { id: before.id }, data: { name } });
  return { ok: true, before, after };
}

/** Activates or deactivates; refuses to deactivate the last active method. */
export function setPaymentMethodActive(
  prisma: PrismaClient,
  centerId: string,
  id: string,
  active: boolean,
): Promise<PaymentMethodChangeResult> {
  return prisma.$transaction(async (tx) => {
    await lockCenterMethods(tx, centerId);
    const before = await tx.centerPaymentMethod.findFirst({ where: { centerId, id } });
    if (!before) return { ok: false, error: "notFound" };
    if (before.active === active) return { ok: true, before, after: before };

    if (!active) {
      const otherActive = await tx.centerPaymentMethod.count({
        where: { centerId, active: true, NOT: { id } },
      });
      if (otherActive === 0) return { ok: false, error: "lastActiveMethod" };
    }

    const after = await tx.centerPaymentMethod.update({ where: { id }, data: { active } });
    return { ok: true, before, after };
  });
}

export type DeletePaymentMethodResult =
  | { ok: true; outcome: "deleted"; before: CenterPaymentMethod }
  | { ok: true; outcome: "deactivated"; before: CenterPaymentMethod; after: CenterPaymentMethod }
  | { ok: false; error: "notFound" | "lastActiveMethod" };

/**
 * Hard-deletes a method no payment references; deactivates one that is
 * referenced (M18 convention — history keeps pointing at a real row). Either
 * way, the last active method is refused: deleting it or deactivating it
 * would leave the centre unable to record a payment at all.
 */
export function deletePaymentMethod(
  prisma: PrismaClient,
  centerId: string,
  id: string,
): Promise<DeletePaymentMethodResult> {
  return prisma.$transaction(async (tx) => {
    await lockCenterMethods(tx, centerId);
    const before = await tx.centerPaymentMethod.findFirst({ where: { centerId, id } });
    if (!before) return { ok: false, error: "notFound" };

    if (before.active) {
      const otherActive = await tx.centerPaymentMethod.count({
        where: { centerId, active: true, NOT: { id } },
      });
      if (otherActive === 0) return { ok: false, error: "lastActiveMethod" };
    }

    const references = await tx.payment.count({ where: { centerId, paymentMethodId: id } });
    if (references > 0) {
      const after = before.active
        ? await tx.centerPaymentMethod.update({ where: { id }, data: { active: false } })
        : before;
      return { ok: true, outcome: "deactivated", before, after };
    }

    await tx.centerPaymentMethod.delete({ where: { id } });
    return { ok: true, outcome: "deleted", before };
  });
}
