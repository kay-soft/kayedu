-- U3 — a subject exists once and links to the grades that teach it
-- (docs/00-master-product-spec.md §5.1 R8 rules, docs/01-data-model.md
-- "Academic catalog layer", docs/03-build-order.md U3).
--
-- Before U3 a CatalogSubject had one parent grade, so "Mathematics" existed
-- once per grade (14 rows on dev) and every subject picker and filter repeated
-- it. Now:
--   * CatalogSubject is grade-independent; its names are unique across the
--     whole catalog (case-insensitive, English and Arabic each — enforced by
--     lib/db/catalog-admin.ts, the only writer);
--   * CatalogSubjectGrade(subjectId, gradeId) links a subject to the grades
--     that teach it, in any education system;
--   * CatalogSubject.gradeId is EXPAND-ONLY: kept, nullable, unread, with its
--     FK and index dropped so the code deployed before U3 keeps working until
--     the new code ships. Backlog: "Drop CatalogSubject.gradeId".
--
-- Data (hand-written, below the generated DDL):
--   1. Subjects are grouped by their normalized (English, Arabic) names — the
--      same key the app compares names by (lib/catalog.ts catalogNameKey:
--      trim, collapse inner whitespace, lower-case). Each group keeps its
--      OLDEST row (createdAt, then id) as canonical.
--   2. Every member's old gradeId becomes a link on the canonical row.
--   3. Every reference to a duplicate is repointed onto the canonical id:
--      ClassGroup.subjectId, Session.subjectId, CenterCatalogSelection.subjectId
--      and the subjectId inside ChangeRequest.payload. (AuditLog before/after is
--      append-only by trigger and keeps the ids it was written with.)
--   4. A centre's duplicate selections merge into one row: active if any was
--      active; each display name = the most recently updated non-empty value
--      in that language.
--   5. The duplicate rows are deleted.
--
-- Fails loudly, before anything changes, if two canonical subjects would still
-- share an English or an Arabic name (fix them in /admin/catalog, rerun). The
-- whole file runs as one implicit transaction (Prisma sends it as one batch),
-- so nothing half-applies. Every existing class keeps its (grade, subject):
-- the pre-check on dev and staging found every class's pair linked after the
-- merge; a pair that is not is reported (NOTICE), never invented.

-- ── 0. Guard: refuse before any change ───────────────────────────────────

DO $$
DECLARE
  clash text;
BEGIN
  WITH s AS (
    SELECT id, "nameEn", "nameAr", "createdAt",
           lower(regexp_replace(btrim("nameEn"), '\s+', ' ', 'g')) AS ken,
           lower(regexp_replace(btrim("nameAr"), '\s+', ' ', 'g')) AS kar
    FROM "CatalogSubject"
  ), canon AS (
    SELECT DISTINCT ON (ken, kar) id, "nameEn", "nameAr", ken, kar
    FROM s ORDER BY ken, kar, "createdAt", id
  )
  SELECT string_agg(format('"%s / %s" and "%s / %s" (%s)', a."nameEn", a."nameAr", b."nameEn", b."nameAr",
                           CASE WHEN a.ken = b.ken THEN 'same English name' ELSE 'same Arabic name' END), '; ')
    INTO clash
  FROM canon a JOIN canon b ON a.id < b.id AND (a.ken = b.ken OR a.kar = b.kar);

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'U3: subjects would still share a name after the merge — rename them in /admin/catalog and rerun: %', clash;
  END IF;
END $$;

-- ── Generated (prisma migrate diff, read-only against dev) ───────────────

-- DropForeignKey
ALTER TABLE "CatalogSubject" DROP CONSTRAINT "CatalogSubject_gradeId_fkey";

-- DropIndex
DROP INDEX "CatalogSubject_gradeId_idx";

-- CreateTable
CREATE TABLE "CatalogSubjectGrade" (
    "subjectId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogSubjectGrade_pkey" PRIMARY KEY ("subjectId","gradeId")
);

-- CreateIndex
CREATE INDEX "CatalogSubjectGrade_gradeId_idx" ON "CatalogSubjectGrade"("gradeId");

-- AddForeignKey
ALTER TABLE "CatalogSubjectGrade" ADD CONSTRAINT "CatalogSubjectGrade_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "CatalogSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSubjectGrade" ADD CONSTRAINT "CatalogSubjectGrade_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New tables carry RLS from birth (SEC-2a lockdown rule; check:rls asserts it).
ALTER TABLE "CatalogSubjectGrade" ENABLE ROW LEVEL SECURITY;

-- ── Hand-written: merge duplicate subjects ───────────────────────────────

DO $$
DECLARE
  moved_classes int;
  moved_sessions int;
  moved_requests int;
  removed_selections int;
  removed_subjects int;
  left_over int;
  report text;
BEGIN
  CREATE TEMP TABLE u3_subject_map ON COMMIT DROP AS
  WITH s AS (
    SELECT id, "gradeId", "createdAt",
           lower(regexp_replace(btrim("nameEn"), '\s+', ' ', 'g')) AS ken,
           lower(regexp_replace(btrim("nameAr"), '\s+', ' ', 'g')) AS kar
    FROM "CatalogSubject"
  )
  SELECT id,
         first_value(id) OVER (PARTITION BY ken, kar ORDER BY "createdAt", id) AS canonical,
         "gradeId"
  FROM s;

  -- 2. Links: every member's old grade, on the canonical row.
  INSERT INTO "CatalogSubjectGrade" ("subjectId", "gradeId")
  SELECT DISTINCT canonical, "gradeId" FROM u3_subject_map WHERE "gradeId" IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- 3. Repoint classes, sessions and request payloads.
  UPDATE "ClassGroup" c SET "subjectId" = m.canonical
  FROM u3_subject_map m WHERE c."subjectId" = m.id AND m.id <> m.canonical;
  GET DIAGNOSTICS moved_classes = ROW_COUNT;

  UPDATE "Session" se SET "subjectId" = m.canonical
  FROM u3_subject_map m WHERE se."subjectId" = m.id AND m.id <> m.canonical;
  GET DIAGNOSTICS moved_sessions = ROW_COUNT;

  UPDATE "ChangeRequest" cr SET payload = jsonb_set(cr.payload, '{subjectId}', to_jsonb(m.canonical))
  FROM u3_subject_map m
  WHERE jsonb_typeof(cr.payload) = 'object' AND cr.payload->>'subjectId' = m.id AND m.id <> m.canonical;
  GET DIAGNOSTICS moved_requests = ROW_COUNT;

  -- 4. Selections: one per (centre, canonical subject). The keeper is the row
  -- already on the canonical id if there is one, else the oldest.
  CREATE TEMP TABLE u3_selection_merge ON COMMIT DROP AS
  SELECT sel.id, sel."centerId", m.canonical,
         row_number() OVER (PARTITION BY sel."centerId", m.canonical
                            ORDER BY (sel."subjectId" = m.canonical) DESC, sel."createdAt", sel.id) AS rank
  FROM "CenterCatalogSelection" sel JOIN u3_subject_map m ON m.id = sel."subjectId"
  WHERE sel.kind = 'SUBJECT';

  SELECT string_agg(label, '; ') INTO report FROM (
    SELECT format('%s: %s', ctr.name, sub."nameEn") AS label
    FROM u3_selection_merge g
    JOIN "CenterCatalogSelection" sel ON sel.id = g.id
    JOIN "Center" ctr ON ctr.id = g."centerId"
    JOIN "CatalogSubject" sub ON sub.id = g.canonical
    GROUP BY g."centerId", g.canonical, ctr.name, sub."nameEn"
    HAVING count(DISTINCT nullif(btrim(sel."displayNameEn"), '')) > 1
        OR count(DISTINCT nullif(btrim(sel."displayNameAr"), '')) > 1
  ) disagreements;
  IF report IS NOT NULL THEN
    RAISE NOTICE 'U3: centres whose merged subject renames disagreed (the newest won): %', report;
  END IF;

  UPDATE "CenterCatalogSelection" keep SET
    active = agg.any_active,
    "displayNameEn" = agg.name_en,
    "displayNameAr" = agg.name_ar
  FROM (
    SELECT g."centerId", g.canonical,
           bool_or(sel.active) AS any_active,
           (array_agg(btrim(sel."displayNameEn") ORDER BY sel."updatedAt" DESC, sel.id)
              FILTER (WHERE nullif(btrim(sel."displayNameEn"), '') IS NOT NULL))[1] AS name_en,
           (array_agg(btrim(sel."displayNameAr") ORDER BY sel."updatedAt" DESC, sel.id)
              FILTER (WHERE nullif(btrim(sel."displayNameAr"), '') IS NOT NULL))[1] AS name_ar
    FROM u3_selection_merge g JOIN "CenterCatalogSelection" sel ON sel.id = g.id
    GROUP BY g."centerId", g.canonical
    HAVING count(*) > 1
  ) agg
  JOIN u3_selection_merge k ON k."centerId" = agg."centerId" AND k.canonical = agg.canonical AND k.rank = 1
  WHERE keep.id = k.id;

  DELETE FROM "CenterCatalogSelection" sel USING u3_selection_merge g
  WHERE sel.id = g.id AND g.rank > 1;
  GET DIAGNOSTICS removed_selections = ROW_COUNT;

  UPDATE "CenterCatalogSelection" sel SET "subjectId" = g.canonical
  FROM u3_selection_merge g WHERE sel.id = g.id AND g.rank = 1 AND sel."subjectId" <> g.canonical;

  -- 5. The duplicates themselves.
  DELETE FROM "CatalogSubject" sub USING u3_subject_map m
  WHERE sub.id = m.id AND m.id <> m.canonical;
  GET DIAGNOSTICS removed_subjects = ROW_COUNT;

  -- Nothing may still point at a deleted id (the FKs cover the tables; the
  -- JSON payload is checked by hand).
  SELECT count(*) INTO left_over FROM "ChangeRequest" cr
  WHERE jsonb_typeof(cr.payload) = 'object' AND cr.payload->>'subjectId' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "CatalogSubject" sub WHERE sub.id = cr.payload->>'subjectId')
    AND EXISTS (SELECT 1 FROM u3_subject_map m WHERE m.id = cr.payload->>'subjectId');
  IF left_over > 0 THEN
    RAISE EXCEPTION 'U3: % change request(s) still name a deleted subject', left_over;
  END IF;

  -- Every class keeps its (grade, subject); a pair the merge did not link is
  -- reported, never invented.
  SELECT string_agg(format('class %s (%s)', c.id, ctr.name), '; ') INTO report
  FROM "ClassGroup" c JOIN "Center" ctr ON ctr.id = c."centerId"
  WHERE c."subjectId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "CatalogSubjectGrade" l
                    WHERE l."subjectId" = c."subjectId" AND l."gradeId" = c."gradeId");
  IF report IS NOT NULL THEN
    RAISE NOTICE 'U3: classes whose (grade, subject) pair is not linked: %', report;
  END IF;

  RAISE NOTICE 'U3: % duplicate subjects removed; % classes, % sessions, % change requests repointed; % duplicate selections merged away',
    removed_subjects, moved_classes, moved_sessions, moved_requests, removed_selections;
END $$;
