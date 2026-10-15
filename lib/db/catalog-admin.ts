import type { Prisma, PrismaClient } from "@prisma/client";

import {
  CATALOG_NAME_MAX,
  catalogNameKey,
  normalizeCatalogName,
  type CatalogEntryKind,
} from "../catalog.ts";
import { MAX_PRICE_PIASTRES } from "../money.ts";
import { writeAuditRow } from "./audit-row.ts";

/**
 * The platform admin's write path to the global academic catalog (R8,
 * docs/00-master-product-spec.md §4.4). **This is the only code in the
 * repository that writes a `CatalogEducationSystem`/`CatalogGrade`/
 * `CatalogSubject` row**, and every function here starts by loading the acting
 * user and refusing unless `user.isPlatformAdmin` — a direct call from a
 * centre role (or anyone else) is `forbidden`, regardless of what the caller
 * did or did not check first. The Server Actions in `app/[locale]/(admin)/
 * admin/catalog/actions.ts` additionally call `requirePlatformAdmin()`; this
 * is the second, structural lock (same shape as `lib/db/platform.ts`).
 *
 * Every write is one transaction — check → write → `AuditLog` — and the audit
 * row (`platform.catalog.create|update|deactivate|reactivate|delete`, no
 * `centerId`: a platform action belongs to no tenant) carries before/after.
 *
 * Rules (docs/00 §5.1 "Global academic catalog"):
 * - both `nameAr` and `nameEn` are required, trimmed, 1..80 characters;
 * - a name may not repeat — compared case-insensitively, for `nameEn` and
 *   `nameAr` each — among the entries of the **same parent** (all systems;
 *   the grades of one system, or the parentless grades; the subjects of one
 *   grade, or the parentless subjects), deactivated entries included;
 * - delete is a hard delete **only** if nothing references the row; otherwise
 *   it is refused with the counts, and Deactivate is the way out. Deactivated
 *   entries vanish from every picker but still resolve in history.
 */

type Kind = CatalogEntryKind;

export type CatalogWriteError =
  | "forbidden"
  | "notFound"
  | "nameArRequired"
  | "nameEnRequired"
  | "nameArTooLong"
  | "nameEnTooLong"
  | "duplicateNameAr"
  | "duplicateNameEn"
  | "parentNotFound"
  | "invalidShare"
  | "alreadyInState"
  | "inUse";

/** What an entry is referenced by — the numbers the delete blocker names. */
export type CatalogUsage = {
  /** Centres that picked it (one `CenterCatalogSelection` each). */
  centres: number;
  classes: number;
  /** Student profiles whose grade it is (grades only). */
  students: number;
  /** One-time sessions that name it (grades and subjects). */
  sessions: number;
  /** Child entries: a system's grades, a grade's subjects. */
  children: number;
};

export type CatalogEntrySnapshot = {
  kind: Kind;
  nameAr: string;
  nameEn: string;
  parentId: string | null;
  /** Piastres — education systems only; null elsewhere. */
  defaultFixedCenterShare: number | null;
  active: boolean;
};

export type CatalogEntryInput = {
  nameAr: string;
  nameEn: string;
  /** A grade's education system / a subject's grade. Optional (null = none); ignored for an education system. */
  parentId?: string | null;
  /** Piastres. Education systems only; ignored elsewhere. */
  defaultFixedCenterShare?: number;
};

export type CatalogWriteResult =
  | { ok: true; id: string; before: CatalogEntrySnapshot | null; after: CatalogEntrySnapshot }
  | { ok: false; error: CatalogWriteError; usage?: CatalogUsage };

export type CatalogDeleteResult =
  | { ok: true; before: CatalogEntrySnapshot }
  | { ok: false; error: CatalogWriteError; usage?: CatalogUsage };

const AUDIT_ENTITY: Record<Kind, string> = {
  EDUCATION_SYSTEM: "CatalogEducationSystem",
  GRADE: "CatalogGrade",
  SUBJECT: "CatalogSubject",
};

/** The one authority check: the acting user, loaded fresh, must be a platform admin. */
export async function isPlatformAdminUser(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const user = await db.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
  return user?.isPlatformAdmin === true;
}

// ── Reading one entry as a snapshot ────────────────────────────────────────

async function loadEntry(
  tx: Prisma.TransactionClient,
  kind: Kind,
  id: string,
): Promise<CatalogEntrySnapshot | null> {
  if (kind === "EDUCATION_SYSTEM") {
    const row = await tx.catalogEducationSystem.findUnique({ where: { id } });
    return row
      ? {
          kind,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          parentId: null,
          defaultFixedCenterShare: row.defaultFixedCenterShare,
          active: row.active,
        }
      : null;
  }
  if (kind === "GRADE") {
    const row = await tx.catalogGrade.findUnique({ where: { id } });
    return row
      ? {
          kind,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          parentId: row.educationSystemId,
          defaultFixedCenterShare: null,
          active: row.active,
        }
      : null;
  }
  const row = await tx.catalogSubject.findUnique({ where: { id } });
  return row
    ? {
        kind,
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        parentId: row.gradeId,
        defaultFixedCenterShare: null,
        active: row.active,
      }
    : null;
}

/** How many things still point at one entry. Every number is read in the same transaction as the delete. */
export async function catalogEntryUsage(
  db: PrismaClient | Prisma.TransactionClient,
  kind: Kind,
  id: string,
): Promise<CatalogUsage> {
  if (kind === "EDUCATION_SYSTEM") {
    const [centres, classes, children] = await Promise.all([
      db.centerCatalogSelection.count({ where: { educationSystemId: id } }),
      db.classGroup.count({ where: { educationSystemId: id } }),
      db.catalogGrade.count({ where: { educationSystemId: id } }),
    ]);
    return { centres, classes, students: 0, sessions: 0, children };
  }
  if (kind === "GRADE") {
    const [centres, classes, students, sessions, children] = await Promise.all([
      db.centerCatalogSelection.count({ where: { gradeId: id } }),
      db.classGroup.count({ where: { gradeId: id } }),
      db.studentProfile.count({ where: { gradeId: id } }),
      db.session.count({ where: { gradeId: id } }),
      db.catalogSubject.count({ where: { gradeId: id } }),
    ]);
    return { centres, classes, students, sessions, children };
  }
  const [centres, classes, sessions] = await Promise.all([
    db.centerCatalogSelection.count({ where: { subjectId: id } }),
    db.classGroup.count({ where: { subjectId: id } }),
    db.session.count({ where: { subjectId: id } }),
  ]);
  return { centres, classes, students: 0, sessions, children: 0 };
}

function isUnused(usage: CatalogUsage): boolean {
  return (
    usage.centres + usage.classes + usage.students + usage.sessions + usage.children === 0
  );
}

// ── Validation shared by create and update ─────────────────────────────────

type CheckedInput = {
  nameAr: string;
  nameEn: string;
  parentId: string | null;
  defaultFixedCenterShare: number | null;
};

async function checkInput(
  tx: Prisma.TransactionClient,
  kind: Kind,
  input: CatalogEntryInput,
  selfId: string | null,
): Promise<{ ok: true; value: CheckedInput } | { ok: false; error: CatalogWriteError }> {
  const nameAr = normalizeCatalogName(input.nameAr);
  const nameEn = normalizeCatalogName(input.nameEn);
  if (nameAr === null) return { ok: false, error: "nameArRequired" };
  if (nameEn === null) return { ok: false, error: "nameEnRequired" };
  if (nameAr.length > CATALOG_NAME_MAX) return { ok: false, error: "nameArTooLong" };
  if (nameEn.length > CATALOG_NAME_MAX) return { ok: false, error: "nameEnTooLong" };

  let parentId: string | null = null;
  if (kind !== "EDUCATION_SYSTEM" && input.parentId) {
    const parent =
      kind === "GRADE"
        ? await tx.catalogEducationSystem.findUnique({ where: { id: input.parentId }, select: { id: true } })
        : await tx.catalogGrade.findUnique({ where: { id: input.parentId }, select: { id: true } });
    if (!parent) return { ok: false, error: "parentNotFound" };
    parentId = parent.id;
  }

  let share: number | null = null;
  if (kind === "EDUCATION_SYSTEM") {
    share = input.defaultFixedCenterShare ?? 0;
    if (!Number.isInteger(share) || share < 0 || share > MAX_PRICE_PIASTRES) {
      return { ok: false, error: "invalidShare" };
    }
  }

  // Duplicate refusal — among this parent's entries (deactivated ones too),
  // compared through the one name normalizer, English and Arabic each.
  const siblings: { id: string; nameAr: string; nameEn: string }[] =
    kind === "EDUCATION_SYSTEM"
      ? await tx.catalogEducationSystem.findMany({ select: { id: true, nameAr: true, nameEn: true } })
      : kind === "GRADE"
        ? await tx.catalogGrade.findMany({
            where: { educationSystemId: parentId },
            select: { id: true, nameAr: true, nameEn: true },
          })
        : await tx.catalogSubject.findMany({
            where: { gradeId: parentId },
            select: { id: true, nameAr: true, nameEn: true },
          });
  const others = siblings.filter((row) => row.id !== selfId);
  if (others.some((row) => catalogNameKey(row.nameEn) === catalogNameKey(nameEn))) {
    return { ok: false, error: "duplicateNameEn" };
  }
  if (others.some((row) => catalogNameKey(row.nameAr) === catalogNameKey(nameAr))) {
    return { ok: false, error: "duplicateNameAr" };
  }

  return { ok: true, value: { nameAr, nameEn, parentId, defaultFixedCenterShare: share } };
}

async function audit(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  action: "create" | "update" | "deactivate" | "reactivate" | "delete",
  kind: Kind,
  entityId: string,
  before: CatalogEntrySnapshot | null,
  after: CatalogEntrySnapshot | null,
) {
  await writeAuditRow(tx, {
    centerId: null,
    actorUserId,
    action: `platform.catalog.${action}`,
    entityType: AUDIT_ENTITY[kind],
    entityId,
    before: before ?? undefined,
    after: after ?? undefined,
  });
}

// ── The writes ─────────────────────────────────────────────────────────────

export async function createCatalogEntry(
  db: PrismaClient,
  actorUserId: string,
  kind: Kind,
  input: CatalogEntryInput,
): Promise<CatalogWriteResult> {
  if (!(await isPlatformAdminUser(db, actorUserId))) return { ok: false, error: "forbidden" };

  return db.$transaction(async (tx): Promise<CatalogWriteResult> => {
    const checked = await checkInput(tx, kind, input, null);
    if (!checked.ok) return checked;
    const { nameAr, nameEn, parentId, defaultFixedCenterShare } = checked.value;

    let id: string;
    if (kind === "EDUCATION_SYSTEM") {
      id = (
        await tx.catalogEducationSystem.create({
          data: { nameAr, nameEn, defaultFixedCenterShare: defaultFixedCenterShare ?? 0 },
        })
      ).id;
    } else if (kind === "GRADE") {
      id = (await tx.catalogGrade.create({ data: { nameAr, nameEn, educationSystemId: parentId } })).id;
    } else {
      id = (await tx.catalogSubject.create({ data: { nameAr, nameEn, gradeId: parentId } })).id;
    }

    const after = (await loadEntry(tx, kind, id))!;
    await audit(tx, actorUserId, "create", kind, id, null, after);
    return { ok: true, id, before: null, after };
  });
}

export async function updateCatalogEntry(
  db: PrismaClient,
  actorUserId: string,
  kind: Kind,
  id: string,
  input: CatalogEntryInput,
): Promise<CatalogWriteResult> {
  if (!(await isPlatformAdminUser(db, actorUserId))) return { ok: false, error: "forbidden" };

  return db.$transaction(async (tx): Promise<CatalogWriteResult> => {
    const before = await loadEntry(tx, kind, id);
    if (!before) return { ok: false, error: "notFound" };

    const checked = await checkInput(tx, kind, input, id);
    if (!checked.ok) return checked;
    const { nameAr, nameEn, parentId, defaultFixedCenterShare } = checked.value;

    if (kind === "EDUCATION_SYSTEM") {
      await tx.catalogEducationSystem.update({
        where: { id },
        data: { nameAr, nameEn, defaultFixedCenterShare: defaultFixedCenterShare ?? 0 },
      });
    } else if (kind === "GRADE") {
      await tx.catalogGrade.update({ where: { id }, data: { nameAr, nameEn, educationSystemId: parentId } });
    } else {
      await tx.catalogSubject.update({ where: { id }, data: { nameAr, nameEn, gradeId: parentId } });
    }

    const after = (await loadEntry(tx, kind, id))!;
    await audit(tx, actorUserId, "update", kind, id, before, after);
    return { ok: true, id, before, after };
  });
}

/** Deactivate / reactivate. Never touches names or references — history keeps resolving. */
export async function setCatalogEntryActive(
  db: PrismaClient,
  actorUserId: string,
  kind: Kind,
  id: string,
  active: boolean,
): Promise<CatalogWriteResult> {
  if (!(await isPlatformAdminUser(db, actorUserId))) return { ok: false, error: "forbidden" };

  return db.$transaction(async (tx): Promise<CatalogWriteResult> => {
    const before = await loadEntry(tx, kind, id);
    if (!before) return { ok: false, error: "notFound" };
    if (before.active === active) return { ok: false, error: "alreadyInState" };

    if (kind === "EDUCATION_SYSTEM") {
      await tx.catalogEducationSystem.update({ where: { id }, data: { active } });
    } else if (kind === "GRADE") {
      await tx.catalogGrade.update({ where: { id }, data: { active } });
    } else {
      await tx.catalogSubject.update({ where: { id }, data: { active } });
    }

    const after = (await loadEntry(tx, kind, id))!;
    await audit(tx, actorUserId, active ? "reactivate" : "deactivate", kind, id, before, after);
    return { ok: true, id, before, after };
  });
}

/**
 * Hard delete — only when nothing references the row. A referenced entry is
 * refused with `inUse` and its usage counts; the caller offers Deactivate.
 * (Prisma's default for these optional relations is SET NULL, which would
 * silently orphan a class's subject — so the references are counted here,
 * not left to the database.)
 */
export async function deleteCatalogEntry(
  db: PrismaClient,
  actorUserId: string,
  kind: Kind,
  id: string,
): Promise<CatalogDeleteResult> {
  if (!(await isPlatformAdminUser(db, actorUserId))) return { ok: false, error: "forbidden" };

  return db.$transaction(async (tx): Promise<CatalogDeleteResult> => {
    const before = await loadEntry(tx, kind, id);
    if (!before) return { ok: false, error: "notFound" };

    const usage = await catalogEntryUsage(tx, kind, id);
    if (!isUnused(usage)) return { ok: false, error: "inUse", usage };

    if (kind === "EDUCATION_SYSTEM") await tx.catalogEducationSystem.delete({ where: { id } });
    else if (kind === "GRADE") await tx.catalogGrade.delete({ where: { id } });
    else await tx.catalogSubject.delete({ where: { id } });

    await audit(tx, actorUserId, "delete", kind, id, before, null);
    return { ok: true, before };
  });
}

// ── The management list (/admin/catalog) ───────────────────────────────────

export type CatalogAdminRow = {
  id: string;
  kind: Kind;
  nameAr: string;
  nameEn: string;
  active: boolean;
  parentId: string | null;
  parentNameAr: string | null;
  parentNameEn: string | null;
  /** Piastres; education systems only. */
  defaultFixedCenterShare: number | null;
  usage: CatalogUsage;
};

const NO_USAGE: CatalogUsage = { centres: 0, classes: 0, students: 0, sessions: 0, children: 0 };

/**
 * Every entry of one kind, deactivated ones included, with its parent's names
 * and its usage counts (relation `_count`s — one query per kind, not one per
 * row). A platform-wide read by design: global rows have no `centerId`.
 */
export async function listCatalogAdminRows(
  db: PrismaClient,
  kind: Kind,
): Promise<CatalogAdminRow[]> {
  if (kind === "EDUCATION_SYSTEM") {
    const rows = await db.catalogEducationSystem.findMany({
      include: { _count: { select: { selections: true, classGroups: true, grades: true } } },
      orderBy: [{ active: "desc" }, { nameEn: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      kind,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      active: row.active,
      parentId: null,
      parentNameAr: null,
      parentNameEn: null,
      defaultFixedCenterShare: row.defaultFixedCenterShare,
      usage: {
        ...NO_USAGE,
        centres: row._count.selections,
        classes: row._count.classGroups,
        children: row._count.grades,
      },
    }));
  }
  if (kind === "GRADE") {
    const rows = await db.catalogGrade.findMany({
      include: {
        educationSystem: { select: { nameAr: true, nameEn: true } },
        _count: {
          select: { selections: true, classGroups: true, studentProfiles: true, sessions: true, subjects: true },
        },
      },
      orderBy: [{ active: "desc" }, { nameEn: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      kind,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      active: row.active,
      parentId: row.educationSystemId,
      parentNameAr: row.educationSystem?.nameAr ?? null,
      parentNameEn: row.educationSystem?.nameEn ?? null,
      defaultFixedCenterShare: null,
      usage: {
        centres: row._count.selections,
        classes: row._count.classGroups,
        students: row._count.studentProfiles,
        sessions: row._count.sessions,
        children: row._count.subjects,
      },
    }));
  }
  const rows = await db.catalogSubject.findMany({
    include: {
      grade: { select: { nameAr: true, nameEn: true } },
      _count: { select: { selections: true, classGroups: true, sessions: true } },
    },
    orderBy: [{ active: "desc" }, { nameEn: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    kind,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    active: row.active,
    parentId: row.gradeId,
    parentNameAr: row.grade?.nameAr ?? null,
    parentNameEn: row.grade?.nameEn ?? null,
    defaultFixedCenterShare: null,
    usage: {
      ...NO_USAGE,
      centres: row._count.selections,
      classes: row._count.classGroups,
      sessions: row._count.sessions,
    },
  }));
}
