-- R5: manual sessions — an extra session on a class, and a one-time session
-- that belongs to no class (docs/00-master-product-spec.md §5.1 "Manual and
-- one-time sessions", docs/03-build-order.md "R5").
--
-- No production data exists when this migration runs: every database it
-- targets holds seed/demo data only. Nothing here rewrites an existing row's
-- values — every existing session keeps its class and gets isManual = false.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Session.classGroupId becomes nullable. The FK and its ON DELETE CASCADE
--    stay exactly as they are. @@unique([classGroupId, date, startTime])
--    stays too: Postgres treats NULLs as distinct in a unique index, so any
--    number of one-time sessions may share a date and start time, while a
--    class still cannot hold two sessions in the same slot.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Session" ALTER COLUMN "classGroupId" DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. A one-time session's own name and optional catalog references (global
--    entries, SET NULL like ClassGroup's), and the manual flag. Application
--    invariant (lib/db/sessions.ts, asserted by check:one-off-sessions):
--    classGroupId NULL => title, teacherId, priceSnapshot, centerShareType
--    and centerShareValue are all set.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "Session" ADD COLUMN "title" TEXT,
ADD COLUMN "subjectId" TEXT,
ADD COLUMN "gradeId" TEXT,
ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Session" ADD CONSTRAINT "Session_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "CatalogSubject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Session" ADD CONSTRAINT "Session_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
