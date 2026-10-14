import type { CenterTerm, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:class-periods` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/payment-methods.ts). The client is injected, never imported.
import { classPeriodError, type ClassPeriodError } from "../scheduling.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { nameClashes } from "../like.ts";

/**
 * A centre's term presets (R4, docs/00-master-product-spec.md §5.1 "Class
 * periods and centre terms", docs/01-data-model.md "Config layer"). The only
 * writer of `CenterTerm`.
 *
 * A term is a **preset**, nothing more: the class form copies its dates onto
 * the class, and no row ever points back at it. So renaming or redating a
 * term moves no class, and a delete is always a hard delete — nothing can be
 * orphaned. Terms may overlap ("Full year" and "Semester 1" legitimately do).
 *
 * Two rules, both here:
 * - **Name unique per centre, case-insensitively** ("Semester 1" and
 *   "semester 1" are the same term). Each write locks the centre row first,
 *   so two concurrent creates of the same name cannot both pass the check.
 * - **The period rule** is `lib/scheduling.ts`'s `classPeriodError` — the
 *   same rule a class's own period follows (end on or after start, at most
 *   `MAX_CLASS_PERIOD_DAYS`), since a term exists only to fill one.
 *
 * `centerId` is taken explicitly — the caller resolves it from
 * `getTenantContext()`, never from the client.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type TermInput = { name: string; startDate: Date; endDate: Date };

export type TermWriteError = "duplicateName" | ClassPeriodError;

/** Settings order: active first, then by start date, then name. */
export function listCenterTerms(
  db: Db,
  centerId: string,
  options: { activeOnly?: boolean } = {},
): Promise<CenterTerm[]> {
  return db.centerTerm.findMany({
    where: scopedWhere(centerId, options.activeOnly ? { active: true } : {}),
    orderBy: [{ active: "desc" }, { startDate: "asc" }, { name: "asc" }],
  });
}

async function lockCenter(tx: Prisma.TransactionClient, centerId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Center" WHERE "id" = ${centerId} FOR UPDATE`;
}

async function nameTaken(db: Db, centerId: string, name: string, exceptId?: string): Promise<boolean> {
  // SEC-61: compared by the one name key, never with an (I)LIKE.
  const others = await db.centerTerm.findMany({
    where: scopedWhere(centerId, exceptId ? { id: { not: exceptId } } : {}),
    select: { name: true },
  });
  return nameClashes(name, others);
}

export async function createTerm(
  db: PrismaClient,
  centerId: string,
  input: TermInput,
): Promise<{ ok: true; term: CenterTerm } | { ok: false; error: TermWriteError }> {
  const periodError = classPeriodError(input.startDate, input.endDate);
  if (periodError) return { ok: false, error: periodError };
  return db.$transaction(async (tx) => {
    await lockCenter(tx, centerId);
    if (await nameTaken(tx, centerId, input.name)) return { ok: false as const, error: "duplicateName" as const };
    const term = await tx.centerTerm.create({ data: { centerId, ...input } });
    return { ok: true as const, term };
  });
}

/** Renames and/or redates a term. Classes that copied its dates do not move. */
export async function updateTerm(
  db: PrismaClient,
  centerId: string,
  id: string,
  input: TermInput,
): Promise<
  { ok: true; before: CenterTerm; term: CenterTerm } | { ok: false; error: "notFound" | TermWriteError }
> {
  const periodError = classPeriodError(input.startDate, input.endDate);
  if (periodError) return { ok: false, error: periodError };
  return db.$transaction(async (tx) => {
    await lockCenter(tx, centerId);
    const before = await tx.centerTerm.findFirst({ where: scopedWhere(centerId, { id }) });
    if (!before) return { ok: false as const, error: "notFound" as const };
    if (await nameTaken(tx, centerId, input.name, id)) return { ok: false as const, error: "duplicateName" as const };
    const term = await tx.centerTerm.update({ where: { id }, data: input });
    return { ok: true as const, before, term };
  });
}

export async function setTermActive(
  db: Db,
  centerId: string,
  id: string,
  active: boolean,
): Promise<{ ok: true; before: CenterTerm } | { ok: false; error: "notFound" }> {
  const before = await db.centerTerm.findFirst({ where: scopedWhere(centerId, { id }) });
  if (!before) return { ok: false, error: "notFound" };
  await db.centerTerm.updateMany({ where: scopedWhere(centerId, { id }), data: { active } });
  return { ok: true, before };
}

/** Always a hard delete: classes copied the dates, nothing references a term. */
export async function deleteTerm(
  db: Db,
  centerId: string,
  id: string,
): Promise<{ ok: true; before: CenterTerm } | { ok: false; error: "notFound" }> {
  const before = await db.centerTerm.findFirst({ where: scopedWhere(centerId, { id }) });
  if (!before) return { ok: false, error: "notFound" };
  await db.centerTerm.deleteMany({ where: scopedWhere(centerId, { id }) });
  return { ok: true, before };
}
