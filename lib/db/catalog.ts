import type {
  CatalogEntryKind,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import {
  CATALOG_OVERRIDE_SELECT,
  normalizeCatalogName,
  type CatalogNameOverride,
  type CatalogWithSelection,
} from "../catalog.ts";

/**
 * The global academic catalog, as a *centre* sees it (M13, docs/01-data-model.md
 * "Academic catalog layer"). `CatalogEducationSystem`/`CatalogGrade`/
 * `CatalogSubject` carry no `centerId` — they are platform-owned reference
 * data, and since R8 **nothing in this file writes one**: a centre's own view
 * of them lives entirely on `CenterCatalogSelection` (its pick, plus its own
 * per-language display names and price). The only code that writes a global
 * row is `lib/db/catalog-admin.ts`, and every function there re-checks that the
 * acting user is a platform admin.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const KIND: Record<"EDUCATION_SYSTEM" | "GRADE" | "SUBJECT", CatalogEntryKind> = {
  EDUCATION_SYSTEM: "EDUCATION_SYSTEM",
  GRADE: "GRADE",
  SUBJECT: "SUBJECT",
};

// ── Platform-wide catalog reads (no centerId — genuinely global rows) ──────
// `activeOnly` (the default) is what every picker, Discover filter and the
// centre's "add" list use: a deactivated entry never appears there. Anything
// that must still *resolve* a deactivated entry (history, a class that already
// uses it) reads through the centre's own selection views below instead.

export function listCatalogEducationSystems(db: Db, activeOnly = true) {
  return db.catalogEducationSystem.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ active: "desc" }, { nameEn: "asc" }],
  });
}

export function listCatalogGrades(
  db: Db,
  educationSystemId?: string,
  activeOnly = true,
) {
  return db.catalogGrade.findMany({
    where: {
      ...(activeOnly ? { active: true } : {}),
      ...(educationSystemId ? { educationSystemId } : {}),
    },
    include: { educationSystem: true },
    orderBy: [{ active: "desc" }, { nameEn: "asc" }],
  });
}

export function listCatalogSubjects(
  db: Db,
  gradeId?: string,
  activeOnly = true,
) {
  return db.catalogSubject.findMany({
    where: {
      ...(activeOnly ? { active: true } : {}),
      ...(gradeId ? { gradeId } : {}),
    },
    include: { grade: true },
    orderBy: [{ active: "desc" }, { nameEn: "asc" }],
  });
}

// ── A centre's own selections, joined with the catalog entry ──────────────

/** The part of a view every kind shares. `active` is the centre's pick; `catalogActive` is the platform's flag on the entry itself. */
type CenterEntryBase = CatalogNameOverride & {
  selectionId: string;
  nameAr: string;
  nameEn: string;
  /** The centre switched this pick off (its own `CenterCatalogSelection.active`). */
  active: boolean;
  /** The platform has not deactivated the underlying entry. A deactivated one still resolves for history but is never offered in a picker. */
  catalogActive: boolean;
};

export type CenterEducationSystemView = CenterEntryBase & {
  id: string; // the CatalogEducationSystem id — what ClassGroup.educationSystemId stores
  basePrice: number;
  defaultFixedCenterShare: number;
};

/** The parent shown beside a grade/subject, with this centre's own rename already joined in. */
const PARENT_WITH_OVERRIDE = (centerId: string) =>
  ({
    include: {
      selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
    },
  }) as const;

function systemView(
  row: Prisma.CenterCatalogSelectionGetPayload<{ include: { educationSystem: true } }>,
): CenterEducationSystemView {
  return {
    selectionId: row.id,
    id: row.educationSystem!.id,
    nameAr: row.educationSystem!.nameAr,
    nameEn: row.educationSystem!.nameEn,
    displayNameAr: row.displayNameAr,
    displayNameEn: row.displayNameEn,
    basePrice: row.basePrice ?? 0,
    defaultFixedCenterShare: row.educationSystem!.defaultFixedCenterShare,
    active: row.active,
    catalogActive: row.educationSystem!.active,
  };
}

export async function centerEducationSystems(
  db: Db,
  centerId: string,
): Promise<CenterEducationSystemView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.EDUCATION_SYSTEM },
    include: { educationSystem: true },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows.filter((row) => row.educationSystem).map(systemView);
}

export async function centerEducationSystemById(
  db: Db,
  centerId: string,
  catalogId: string,
): Promise<CenterEducationSystemView | null> {
  const row = await db.centerCatalogSelection.findFirst({
    where: { centerId, kind: KIND.EDUCATION_SYSTEM, educationSystemId: catalogId },
    include: { educationSystem: true },
  });
  return row?.educationSystem ? systemView(row) : null;
}

export type CenterGradeView = CenterEntryBase & {
  id: string; // CatalogGrade id
  educationSystemId: string | null;
  /** The parent system, resolvable with `catalogLabelWithSelection` (this centre's rename of it included). */
  educationSystem: CatalogWithSelection | null;
};

type GradeRow = Prisma.CenterCatalogSelectionGetPayload<{
  include: { grade: { include: { educationSystem: { include: { selections: { select: typeof CATALOG_OVERRIDE_SELECT } } } } } };
}>;

function gradeView(row: GradeRow): CenterGradeView {
  return {
    selectionId: row.id,
    id: row.grade!.id,
    nameAr: row.grade!.nameAr,
    nameEn: row.grade!.nameEn,
    displayNameAr: row.displayNameAr,
    displayNameEn: row.displayNameEn,
    educationSystemId: row.grade!.educationSystemId,
    educationSystem: row.grade!.educationSystem,
    active: row.active,
    catalogActive: row.grade!.active,
  };
}

export async function centerGrades(
  db: Db,
  centerId: string,
): Promise<CenterGradeView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.GRADE },
    include: { grade: { include: { educationSystem: PARENT_WITH_OVERRIDE(centerId) } } },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows.filter((row) => row.grade).map((row) => gradeView(row as GradeRow));
}

export async function centerGradeById(
  db: Db,
  centerId: string,
  catalogId: string,
): Promise<CenterGradeView | null> {
  const row = await db.centerCatalogSelection.findFirst({
    where: { centerId, kind: KIND.GRADE, gradeId: catalogId },
    include: { grade: { include: { educationSystem: PARENT_WITH_OVERRIDE(centerId) } } },
  });
  return row?.grade ? gradeView(row as GradeRow) : null;
}

export type CenterSubjectView = CenterEntryBase & {
  id: string; // CatalogSubject id
  gradeId: string | null;
  /** The parent grade, resolvable with `catalogLabelWithSelection` (this centre's rename of it included). */
  grade: CatalogWithSelection | null;
};

type SubjectRow = Prisma.CenterCatalogSelectionGetPayload<{
  include: { subject: { include: { grade: { include: { selections: { select: typeof CATALOG_OVERRIDE_SELECT } } } } } };
}>;

function subjectView(row: SubjectRow): CenterSubjectView {
  return {
    selectionId: row.id,
    id: row.subject!.id,
    nameAr: row.subject!.nameAr,
    nameEn: row.subject!.nameEn,
    displayNameAr: row.displayNameAr,
    displayNameEn: row.displayNameEn,
    gradeId: row.subject!.gradeId,
    grade: row.subject!.grade,
    active: row.active,
    catalogActive: row.subject!.active,
  };
}

export async function centerSubjects(
  db: Db,
  centerId: string,
): Promise<CenterSubjectView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.SUBJECT },
    include: { subject: { include: { grade: PARENT_WITH_OVERRIDE(centerId) } } },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows.filter((row) => row.subject).map((row) => subjectView(row as SubjectRow));
}

export async function centerSubjectById(
  db: Db,
  centerId: string,
  catalogId: string,
): Promise<CenterSubjectView | null> {
  const row = await db.centerCatalogSelection.findFirst({
    where: { centerId, kind: KIND.SUBJECT, subjectId: catalogId },
    include: { subject: { include: { grade: PARENT_WITH_OVERRIDE(centerId) } } },
  });
  return row?.subject ? subjectView(row as SubjectRow) : null;
}

// ── Selecting / renaming / deselecting a catalog entry ────────────────────

export type SelectCatalogEntryResult =
  | { ok: true; selectionId: string }
  | { ok: false; error: "notFound" | "alreadySelected" };

/** A blank name is "no override" — one normalizer, so `"  "` and `""` and `null` all store null. */
function overrideColumns(names: Partial<CatalogNameOverride> | null | undefined): CatalogNameOverride {
  return {
    displayNameAr: normalizeCatalogName(names?.displayNameAr),
    displayNameEn: normalizeCatalogName(names?.displayNameEn),
  };
}

/**
 * A centre picks one global catalog entry — never writes to the canonical
 * row, and only an *active* entry can be picked (a deactivated one is
 * `notFound`, exactly as if it were not in the add list).
 */
export async function selectCatalogEntry(
  db: Db,
  centerId: string,
  kind: "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT",
  catalogId: string,
  names: Partial<CatalogNameOverride> | null,
  basePrice: number | null,
): Promise<SelectCatalogEntryResult> {
  const exists =
    kind === "EDUCATION_SYSTEM"
      ? await db.catalogEducationSystem.findFirst({ where: { id: catalogId, active: true } })
      : kind === "GRADE"
        ? await db.catalogGrade.findFirst({ where: { id: catalogId, active: true } })
        : await db.catalogSubject.findFirst({ where: { id: catalogId, active: true } });
  if (!exists) return { ok: false, error: "notFound" };

  const already = await db.centerCatalogSelection.findFirst({
    where: {
      centerId,
      kind: KIND[kind],
      ...(kind === "EDUCATION_SYSTEM"
        ? { educationSystemId: catalogId }
        : kind === "GRADE"
          ? { gradeId: catalogId }
          : { subjectId: catalogId }),
    },
  });
  if (already) return { ok: false, error: "alreadySelected" };

  const created = await db.centerCatalogSelection.create({
    data: {
      centerId,
      kind: KIND[kind],
      ...overrideColumns(names),
      basePrice: kind === "EDUCATION_SYSTEM" ? (basePrice ?? 0) : null,
      ...(kind === "EDUCATION_SYSTEM"
        ? { educationSystemId: catalogId }
        : kind === "GRADE"
          ? { gradeId: catalogId }
          : { subjectId: catalogId }),
    },
  });
  return { ok: true, selectionId: created.id };
}

/** Re-resolves a selection id inside the active centre — the tenant boundary. */
export function findSelectionById(db: Db, centerId: string, selectionId: string) {
  return db.centerCatalogSelection.findFirst({ where: { id: selectionId, centerId } });
}

/** A centre edits only its own pick: the two optional names, and (for an education system) the price. */
export function updateCatalogSelection(
  db: Db,
  selectionId: string,
  data: Partial<CatalogNameOverride> & { basePrice?: number | null },
) {
  const { basePrice, ...names } = data;
  return db.centerCatalogSelection.update({
    where: { id: selectionId },
    data: { ...overrideColumns(names), ...(basePrice === undefined ? {} : { basePrice }) },
  });
}

export function removeCatalogSelection(db: Db, selectionId: string) {
  return db.centerCatalogSelection.delete({ where: { id: selectionId } });
}

/** Deactivating a pick (not deleting it) — docs/01-data-model.md §6. */
export function setCatalogSelectionActive(db: Db, selectionId: string, active: boolean) {
  return db.centerCatalogSelection.update({ where: { id: selectionId }, data: { active } });
}

/** Blocks deselecting an education system while the centre still has grade picks under it. */
export function countCenterGradeSelectionsUnderSystem(
  db: Db,
  centerId: string,
  educationSystemId: string,
) {
  return db.centerCatalogSelection.count({
    where: { centerId, kind: KIND.GRADE, grade: { educationSystemId } },
  });
}

/** Blocks deselecting a grade while the centre still has subject picks under it. */
export function countCenterSubjectSelectionsUnderGrade(
  db: Db,
  centerId: string,
  gradeId: string,
) {
  return db.centerCatalogSelection.count({
    where: { centerId, kind: KIND.SUBJECT, subject: { gradeId } },
  });
}
