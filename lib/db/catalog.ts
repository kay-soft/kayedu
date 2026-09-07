import type {
  CatalogEntryKind,
  Prisma,
  PrismaClient,
} from "@prisma/client";

/**
 * The global academic catalog (M13, docs/01-data-model.md "Academic catalog
 * layer"). `CatalogEducationSystem`/`CatalogGrade`/`CatalogSubject` carry no
 * `centerId` — they are platform-owned reference data. A centre's own view of
 * them lives entirely on `CenterCatalogSelection` (its pick, plus its own
 * display name and price) and `CatalogSuggestion` (its proposed additions or
 * corrections). Nothing here writes to a canonical catalog row except
 * `approveCatalogSuggestion`, which only a platform admin may call
 * (`requirePlatformAdmin()` in the caller, docs/02 §6).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const KIND: Record<"EDUCATION_SYSTEM" | "GRADE" | "SUBJECT", CatalogEntryKind> = {
  EDUCATION_SYSTEM: "EDUCATION_SYSTEM",
  GRADE: "GRADE",
  SUBJECT: "SUBJECT",
};

// ── Platform-wide catalog reads (no centerId — genuinely global rows) ──────

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

export type CenterEducationSystemView = {
  selectionId: string;
  id: string; // the CatalogEducationSystem id — what ClassGroup.educationSystemId stores
  nameAr: string;
  nameEn: string;
  displayName: string | null;
  basePrice: number;
  defaultFixedCenterShare: number;
  active: boolean;
};

export async function centerEducationSystems(
  db: Db,
  centerId: string,
): Promise<CenterEducationSystemView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.EDUCATION_SYSTEM },
    include: { educationSystem: true },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows
    .filter((row) => row.educationSystem)
    .map((row) => ({
      selectionId: row.id,
      id: row.educationSystem!.id,
      nameAr: row.educationSystem!.nameAr,
      nameEn: row.educationSystem!.nameEn,
      displayName: row.displayName,
      basePrice: row.basePrice ?? 0,
      defaultFixedCenterShare: row.educationSystem!.defaultFixedCenterShare,
      active: row.active,
    }));
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
  if (!row || !row.educationSystem) return null;
  return {
    selectionId: row.id,
    id: row.educationSystem.id,
    nameAr: row.educationSystem.nameAr,
    nameEn: row.educationSystem.nameEn,
    displayName: row.displayName,
    basePrice: row.basePrice ?? 0,
    defaultFixedCenterShare: row.educationSystem.defaultFixedCenterShare,
    active: row.active,
  };
}

export type CenterGradeView = {
  selectionId: string;
  id: string; // CatalogGrade id
  nameAr: string;
  nameEn: string;
  displayName: string | null;
  educationSystemId: string | null;
  educationSystemName: string | null; // the canonical bilingual-resolved-by-caller name is out of scope here; raw nameEn kept for a quick label
  active: boolean;
};

export async function centerGrades(
  db: Db,
  centerId: string,
): Promise<CenterGradeView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.GRADE },
    include: { grade: { include: { educationSystem: true } } },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows
    .filter((row) => row.grade)
    .map((row) => ({
      selectionId: row.id,
      id: row.grade!.id,
      nameAr: row.grade!.nameAr,
      nameEn: row.grade!.nameEn,
      displayName: row.displayName,
      educationSystemId: row.grade!.educationSystemId,
      educationSystemName: row.grade!.educationSystem?.nameEn ?? null,
      active: row.active,
    }));
}

export async function centerGradeById(
  db: Db,
  centerId: string,
  catalogId: string,
): Promise<CenterGradeView | null> {
  const row = await db.centerCatalogSelection.findFirst({
    where: { centerId, kind: KIND.GRADE, gradeId: catalogId },
    include: { grade: { include: { educationSystem: true } } },
  });
  if (!row || !row.grade) return null;
  return {
    selectionId: row.id,
    id: row.grade.id,
    nameAr: row.grade.nameAr,
    nameEn: row.grade.nameEn,
    displayName: row.displayName,
    educationSystemId: row.grade.educationSystemId,
    educationSystemName: row.grade.educationSystem?.nameEn ?? null,
    active: row.active,
  };
}

export type CenterSubjectView = {
  selectionId: string;
  id: string; // CatalogSubject id
  nameAr: string;
  nameEn: string;
  displayName: string | null;
  gradeId: string | null;
  gradeName: string | null;
  active: boolean;
};

export async function centerSubjects(
  db: Db,
  centerId: string,
): Promise<CenterSubjectView[]> {
  const rows = await db.centerCatalogSelection.findMany({
    where: { centerId, kind: KIND.SUBJECT },
    include: { subject: { include: { grade: true } } },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return rows
    .filter((row) => row.subject)
    .map((row) => ({
      selectionId: row.id,
      id: row.subject!.id,
      nameAr: row.subject!.nameAr,
      nameEn: row.subject!.nameEn,
      displayName: row.displayName,
      gradeId: row.subject!.gradeId,
      gradeName: row.subject!.grade?.nameEn ?? null,
      active: row.active,
    }));
}

export async function centerSubjectById(
  db: Db,
  centerId: string,
  catalogId: string,
): Promise<CenterSubjectView | null> {
  const row = await db.centerCatalogSelection.findFirst({
    where: { centerId, kind: KIND.SUBJECT, subjectId: catalogId },
    include: { subject: { include: { grade: true } } },
  });
  if (!row || !row.subject) return null;
  return {
    selectionId: row.id,
    id: row.subject.id,
    nameAr: row.subject.nameAr,
    nameEn: row.subject.nameEn,
    displayName: row.displayName,
    gradeId: row.subject.gradeId,
    gradeName: row.subject.grade?.nameEn ?? null,
    active: row.active,
  };
}

// ── Selecting / customizing / deselecting a catalog entry ─────────────────

export type SelectCatalogEntryResult =
  | { ok: true; selectionId: string }
  | { ok: false; error: "notFound" | "alreadySelected" };

/** A centre picks one global catalog entry — never writes to the canonical row. */
export async function selectCatalogEntry(
  db: Db,
  centerId: string,
  kind: "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT",
  catalogId: string,
  displayName: string | null,
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
      displayName,
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

export function updateCatalogSelection(
  db: Db,
  selectionId: string,
  data: { displayName: string | null; basePrice?: number | null },
) {
  return db.centerCatalogSelection.update({ where: { id: selectionId }, data });
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

// ── Suggestions (a centre proposes; a platform admin resolves) ────────────

export type CatalogSuggestionInput = {
  kind: "EDUCATION_SYSTEM" | "GRADE" | "SUBJECT";
  targetId: string | null;
  parentId: string | null;
  proposedNameAr: string;
  proposedNameEn: string;
  note: string | null;
};

export function createCatalogSuggestion(
  db: Db,
  centerId: string,
  createdBy: string,
  input: CatalogSuggestionInput,
) {
  return db.catalogSuggestion.create({
    data: {
      centerId,
      createdBy,
      kind: KIND[input.kind],
      targetId: input.targetId,
      parentId: input.parentId,
      proposedNameAr: input.proposedNameAr,
      proposedNameEn: input.proposedNameEn,
      note: input.note,
    },
  });
}

export function listCenterCatalogSuggestions(db: Db, centerId: string) {
  return db.catalogSuggestion.findMany({
    where: { centerId },
    orderBy: { createdAt: "desc" },
  });
}

/** The platform-admin review queue (`/admin/catalog`) — spans every centre by design. */
export function listPendingCatalogSuggestions(db: Db) {
  return db.catalogSuggestion.findMany({
    where: { status: "PENDING" },
    include: { center: { select: { id: true, name: true, nameEn: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export function findCatalogSuggestionById(db: Db, id: string) {
  return db.catalogSuggestion.findUnique({ where: { id } });
}

export type ResolveCatalogSuggestionResult =
  | { ok: true; catalogId: string | null }
  | { ok: false; error: "notFound" | "alreadyResolved" };

/**
 * Approving creates (targetId null) or corrects (targetId set) the canonical
 * catalog row — the only path in this codebase allowed to write one. Only
 * ever called after `requirePlatformAdmin()` in the caller.
 */
export async function approveCatalogSuggestion(
  db: Db,
  suggestionId: string,
  resolvedBy: string,
): Promise<ResolveCatalogSuggestionResult> {
  const suggestion = await db.catalogSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) return { ok: false, error: "notFound" };
  if (suggestion.status !== "PENDING") return { ok: false, error: "alreadyResolved" };

  let catalogId: string;
  if (suggestion.kind === "EDUCATION_SYSTEM") {
    const row = suggestion.targetId
      ? await db.catalogEducationSystem.update({
          where: { id: suggestion.targetId },
          data: { nameAr: suggestion.proposedNameAr, nameEn: suggestion.proposedNameEn },
        })
      : await db.catalogEducationSystem.create({
          data: { nameAr: suggestion.proposedNameAr, nameEn: suggestion.proposedNameEn },
        });
    catalogId = row.id;
  } else if (suggestion.kind === "GRADE") {
    const row = suggestion.targetId
      ? await db.catalogGrade.update({
          where: { id: suggestion.targetId },
          data: { nameAr: suggestion.proposedNameAr, nameEn: suggestion.proposedNameEn },
        })
      : await db.catalogGrade.create({
          data: {
            nameAr: suggestion.proposedNameAr,
            nameEn: suggestion.proposedNameEn,
            educationSystemId: suggestion.parentId,
          },
        });
    catalogId = row.id;
  } else {
    const row = suggestion.targetId
      ? await db.catalogSubject.update({
          where: { id: suggestion.targetId },
          data: { nameAr: suggestion.proposedNameAr, nameEn: suggestion.proposedNameEn },
        })
      : await db.catalogSubject.create({
          data: {
            nameAr: suggestion.proposedNameAr,
            nameEn: suggestion.proposedNameEn,
            gradeId: suggestion.parentId,
          },
        });
    catalogId = row.id;
  }

  await db.catalogSuggestion.update({
    where: { id: suggestionId },
    data: { status: "ACCEPTED", resolvedBy, resolvedAt: new Date() },
  });

  return { ok: true, catalogId };
}

export async function rejectCatalogSuggestion(
  db: Db,
  suggestionId: string,
  resolvedBy: string,
): Promise<ResolveCatalogSuggestionResult> {
  const suggestion = await db.catalogSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) return { ok: false, error: "notFound" };
  if (suggestion.status !== "PENDING") return { ok: false, error: "alreadyResolved" };

  await db.catalogSuggestion.update({
    where: { id: suggestionId },
    data: { status: "REJECTED", resolvedBy, resolvedAt: new Date() },
  });
  return { ok: true, catalogId: null };
}
