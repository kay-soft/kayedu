-- R8: platform-admin-managed catalog, bilingual centre renames, suggestion
-- queue removed (docs/00-master-product-spec.md §4.4 / §5.1,
-- docs/01-data-model.md "Academic catalog layer").
--
-- 1. CenterCatalogSelection.displayName (one free-text name) becomes two
--    optional per-language names, displayNameAr + displayNameEn.
-- 2. The M13 suggestion queue (CatalogSuggestion + CatalogSuggestionStatus)
--    is dropped entirely — a centre that needs an entry contacts the platform
--    and a platform admin adds it directly.
--
-- No production data exists (the product has not launched; the shared dev
-- database held 0 suggestions and 0 renamed selections when this was written),
-- so the backfill below is a faithful rule rather than a data rescue — but it
-- is written to be correct if renamed rows did exist.
--
-- Backfill rule: a non-blank displayName that contains an Arabic-script
-- character goes into displayNameAr, anything else into displayNameEn. The
-- character class is the same one lib/catalog.ts's containsArabicScript()
-- uses (and `npm run check:catalog` asserts the two agree): Arabic
-- U+0600–06FF, Supplement U+0750–077F, Extended-A U+08A0–08FF, Presentation
-- Forms-A U+FB50–FDFF and -B U+FE70–FEFF.
--
-- CatalogEntryKind is kept: CenterCatalogSelection.kind still uses it.

-- ── 1. Two per-language names ────────────────────────────────────────────

ALTER TABLE "CenterCatalogSelection"
  ADD COLUMN "displayNameAr" TEXT,
  ADD COLUMN "displayNameEn" TEXT;

UPDATE "CenterCatalogSelection"
SET "displayNameAr" = btrim("displayName")
WHERE "displayName" IS NOT NULL
  AND btrim("displayName") <> ''
  AND "displayName" ~ '[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]';

UPDATE "CenterCatalogSelection"
SET "displayNameEn" = btrim("displayName")
WHERE "displayName" IS NOT NULL
  AND btrim("displayName") <> ''
  AND "displayNameAr" IS NULL;

ALTER TABLE "CenterCatalogSelection" DROP COLUMN "displayName";

-- ── 2. The suggestion queue ──────────────────────────────────────────────

DROP TABLE "CatalogSuggestion";
DROP TYPE "CatalogSuggestionStatus";
