/**
 * Pure tenant-scoping primitives — see docs/01-data-model.md §4 and
 * docs/02-architecture.md §5.
 *
 * This module deliberately has **no runtime imports**: it is the piece the
 * isolation check (`npm run check:isolation`) exercises directly, and it must
 * stay usable outside the Next.js runtime.
 *
 * Rule: a tenant-scoped row is only ever read or written through a `where`
 * that carries the active `centerId`. Never `findUnique({ where: { id } })`
 * on a tenant table — an id from another center must resolve to "not found",
 * not to a row.
 */

export type CenterScopedRow = { centerId: string };

export class TenantScopeError extends Error {
  readonly entity: string;
  readonly entityId: string;

  constructor(entity: string, entityId: string) {
    super(`Tenant scope violation: ${entity} "${entityId}" is not in the active center.`);
    this.name = "TenantScopeError";
    this.entity = entity;
    this.entityId = entityId;
  }
}

export class MissingCenterScopeError extends Error {
  constructor() {
    super("A tenant-scoped query was built without a centerId. Resolve one with getTenantContext() first.");
    this.name = "MissingCenterScopeError";
  }
}

/** Injects the active centerId into any Prisma `where`. */
export function scopedWhere<W extends object>(
  centerId: string,
  where?: W,
): W & { centerId: string } {
  if (!centerId) throw new MissingCenterScopeError();
  return { ...((where ?? {}) as W), centerId };
}

/** Injects the active centerId into any Prisma `data` payload. */
export function scopedData<D extends object>(
  centerId: string,
  data: D,
): D & { centerId: string } {
  if (!centerId) throw new MissingCenterScopeError();
  return { ...data, centerId };
}

/** Throws unless the row exists AND belongs to the active center. */
export function assertInCenter<T extends CenterScopedRow>(
  centerId: string,
  row: T | null | undefined,
  entity: string,
  entityId: string,
): T {
  if (!centerId) throw new MissingCenterScopeError();
  if (!row || row.centerId !== centerId) {
    throw new TenantScopeError(entity, entityId);
  }
  return row;
}

/** The minimum surface of a Prisma delegate this module needs. */
export type ScopedFindDelegate<T> = {
  findFirst(args: {
    where: { id: string; centerId: string };
  }): PromiseLike<T | null>;
};

/**
 * Looks a tenant row up by id *within the active center*. Returns null when the
 * id belongs to another center — this is the primitive that makes
 * "Center A cannot load a Center B record by ID" true.
 */
export async function scopedFindById<T extends CenterScopedRow>(
  delegate: ScopedFindDelegate<T>,
  centerId: string,
  id: string,
): Promise<T | null> {
  const row = await delegate.findFirst({ where: scopedWhere(centerId, { id }) });
  // Belt and braces: the where already filters, this catches a bad delegate.
  return row && row.centerId === centerId ? row : null;
}

/** Same as scopedFindById but throws TenantScopeError instead of returning null. */
export async function requireScopedById<T extends CenterScopedRow>(
  delegate: ScopedFindDelegate<T>,
  centerId: string,
  id: string,
  entity: string,
): Promise<T> {
  return assertInCenter(centerId, await scopedFindById(delegate, centerId, id), entity, id);
}
