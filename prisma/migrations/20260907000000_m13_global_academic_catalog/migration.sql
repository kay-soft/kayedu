-- M13: Global academic catalog + bilingual names + centre-cut rework
-- (docs/00-master-product-spec.md §5.1 "Global academic catalog",
-- docs/01-data-model.md "Academic catalog layer").
--
-- EducationSystem/Grade/Subject stop being centre-authored rows and become
-- platform-owned global catalog entries a centre selects from
-- (CatalogEducationSystem/CatalogGrade/CatalogSubject). This is a real
-- production migration, not a fresh seed: every existing centre-scoped row
-- becomes exactly one new global catalog row — reusing the OLD row's own id,
-- the same "1:1 backfill needs no join" trick M11 used for
-- Center → Organization — plus exactly one CenterCatalogSelection row
-- preserving that centre's own name/price as the selection's override.
-- Reusing the id also means ClassGroup.subjectId/gradeId/educationSystemId
-- and StudentProfile.gradeId need no value changes at all: only their FK
-- *target* table changes, from the old centre-scoped table to the new
-- global one.
--
-- No two pre-existing centre rows are ever merged into one canonical entry,
-- even if two centres happened to name something identically — that would
-- require an exact-match rule this migration does not have grounds to
-- invent (docs/03-build-order.md M13 brief). Each pre-existing row gets its
-- own canonical catalog row.

-- ── 1. Enums ─────────────────────────────────────────────────────────────

CREATE TYPE "CatalogEntryKind" AS ENUM ('EDUCATION_SYSTEM', 'GRADE', 'SUBJECT');
CREATE TYPE "CatalogSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- ── 2. Global catalog tables ─────────────────────────────────────────────

CREATE TABLE "CatalogEducationSystem" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "defaultFixedCenterShare" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogEducationSystem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogGrade" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "educationSystemId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogGrade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogSubject" (
    "id" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "gradeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSubject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CenterCatalogSelection" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "kind" "CatalogEntryKind" NOT NULL,
    "educationSystemId" TEXT,
    "gradeId" TEXT,
    "subjectId" TEXT,
    "displayName" TEXT,
    "basePrice" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CenterCatalogSelection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogSuggestion" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "kind" "CatalogEntryKind" NOT NULL,
    "targetId" TEXT,
    "parentId" TEXT,
    "proposedNameAr" TEXT NOT NULL,
    "proposedNameEn" TEXT NOT NULL,
    "note" TEXT,
    "status" "CatalogSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogGrade_educationSystemId_idx" ON "CatalogGrade"("educationSystemId");
CREATE INDEX "CatalogSubject_gradeId_idx" ON "CatalogSubject"("gradeId");

CREATE UNIQUE INDEX "CenterCatalogSelection_centerId_kind_educationSystemId_key" ON "CenterCatalogSelection"("centerId", "kind", "educationSystemId");
CREATE UNIQUE INDEX "CenterCatalogSelection_centerId_kind_gradeId_key" ON "CenterCatalogSelection"("centerId", "kind", "gradeId");
CREATE UNIQUE INDEX "CenterCatalogSelection_centerId_kind_subjectId_key" ON "CenterCatalogSelection"("centerId", "kind", "subjectId");
CREATE INDEX "CenterCatalogSelection_centerId_idx" ON "CenterCatalogSelection"("centerId");
CREATE INDEX "CenterCatalogSelection_educationSystemId_idx" ON "CenterCatalogSelection"("educationSystemId");
CREATE INDEX "CenterCatalogSelection_gradeId_idx" ON "CenterCatalogSelection"("gradeId");
CREATE INDEX "CenterCatalogSelection_subjectId_idx" ON "CenterCatalogSelection"("subjectId");

CREATE INDEX "CatalogSuggestion_centerId_idx" ON "CatalogSuggestion"("centerId");
CREATE INDEX "CatalogSuggestion_status_idx" ON "CatalogSuggestion"("status");

ALTER TABLE "CatalogGrade" ADD CONSTRAINT "CatalogGrade_educationSystemId_fkey" FOREIGN KEY ("educationSystemId") REFERENCES "CatalogEducationSystem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CatalogSubject" ADD CONSTRAINT "CatalogSubject_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CenterCatalogSelection" ADD CONSTRAINT "CenterCatalogSelection_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CenterCatalogSelection" ADD CONSTRAINT "CenterCatalogSelection_educationSystemId_fkey" FOREIGN KEY ("educationSystemId") REFERENCES "CatalogEducationSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CenterCatalogSelection" ADD CONSTRAINT "CenterCatalogSelection_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CenterCatalogSelection" ADD CONSTRAINT "CenterCatalogSelection_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "CatalogSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogSuggestion" ADD CONSTRAINT "CatalogSuggestion_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Backfill: one canonical row + one selection per pre-existing row ──

INSERT INTO "CatalogEducationSystem" ("id", "nameAr", "nameEn", "defaultFixedCenterShare", "active", "createdAt", "updatedAt")
SELECT "id", "name", "name", 0, "active", "createdAt", "updatedAt" FROM "EducationSystem";

INSERT INTO "CenterCatalogSelection" ("id", "centerId", "kind", "educationSystemId", "displayName", "basePrice", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "centerId", 'EDUCATION_SYSTEM', "id", "name", "basePrice", "active", "createdAt", "updatedAt" FROM "EducationSystem";

INSERT INTO "CatalogGrade" ("id", "nameAr", "nameEn", "educationSystemId", "active", "createdAt", "updatedAt")
SELECT "id", "name", "name", "educationSystemId", "active", "createdAt", "updatedAt" FROM "Grade";

INSERT INTO "CenterCatalogSelection" ("id", "centerId", "kind", "gradeId", "displayName", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "centerId", 'GRADE', "id", "name", "active", "createdAt", "updatedAt" FROM "Grade";

INSERT INTO "CatalogSubject" ("id", "nameAr", "nameEn", "gradeId", "active", "createdAt", "updatedAt")
SELECT "id", "name", "name", "gradeId", "active", "createdAt", "updatedAt" FROM "Subject";

INSERT INTO "CenterCatalogSelection" ("id", "centerId", "kind", "subjectId", "displayName", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "centerId", 'SUBJECT', "id", "name", "active", "createdAt", "updatedAt" FROM "Subject";

-- ── 4. Retarget ClassGroup/StudentProfile FKs at the new global tables ───
-- Values are untouched (same ids, reused above) — only the FK's target
-- table changes, so no UPDATE is needed on ClassGroup or StudentProfile.

ALTER TABLE "ClassGroup" DROP CONSTRAINT "ClassGroup_subjectId_fkey";
ALTER TABLE "ClassGroup" DROP CONSTRAINT "ClassGroup_gradeId_fkey";
ALTER TABLE "ClassGroup" DROP CONSTRAINT "ClassGroup_educationSystemId_fkey";
ALTER TABLE "StudentProfile" DROP CONSTRAINT "StudentProfile_gradeId_fkey";

ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "CatalogSubject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_educationSystemId_fkey" FOREIGN KEY ("educationSystemId") REFERENCES "CatalogEducationSystem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 5. Drop the old centre-scoped tables ─────────────────────────────────
-- Their own FKs (to Center, and Grade→EducationSystem/Subject→Grade) drop
-- with the tables.

DROP TABLE "Subject";
DROP TABLE "Grade";
DROP TABLE "EducationSystem";

-- ── 6. Per-session centre-cut override (spec §5.1 "Center cut" —
-- "overridable per class and per session"). Null on both columns = inherit
-- the class's own centerShareType/centerShareValue, which is every
-- pre-existing and newly generated session's state until someone explicitly
-- overrides one. Purely additive — no existing row's behaviour changes.

ALTER TABLE "Session" ADD COLUMN "centerShareType" "ShareType";
ALTER TABLE "Session" ADD COLUMN "centerShareValue" INTEGER;
