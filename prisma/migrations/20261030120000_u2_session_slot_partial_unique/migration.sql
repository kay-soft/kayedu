-- U2 — a rescheduled-away session no longer holds its slot.
--
-- The (classGroupId, date, startTime) uniqueness now applies only to sessions
-- that have NOT been rescheduled ("rescheduledToId" IS NULL). A CANCELLED
-- session still holds its slot; so does every other status. The class engine
-- keeps treating every key a class holds (any status, rescheduled included)
-- as taken, so a resync never recreates a moved or cancelled slot
-- (lib/db/class-sessions.ts).
--
-- Order: the new partial unique index is created FIRST (hand-written — Prisma 6
-- cannot express a partial index), then the old full unique index is dropped,
-- so there is no moment without a uniqueness backstop. The old full unique
-- guarantees no duplicates exist, so the partial index always builds.
--
-- Prisma's schema now declares a plain @@index on the same columns, so every
-- future `prisma migrate diff` will emit
--   DROP INDEX "Session_classGroupId_date_startTime_live_key";
-- DELETE that line from any generated migration (docs/02-architecture.md §11,
-- CLAUDE.md rule 7). check:session-lifecycle asserts the index exists.

-- Hand-written: the partial unique index.
CREATE UNIQUE INDEX "Session_classGroupId_date_startTime_live_key"
  ON "Session"("classGroupId", "date", "startTime")
  WHERE "rescheduledToId" IS NULL;

-- Generated (prisma migrate diff): the plain index the schema declares.
-- CreateIndex
CREATE INDEX "Session_classGroupId_date_startTime_idx" ON "Session"("classGroupId", "date", "startTime");

-- Generated (prisma migrate diff): the old full unique index, dropped last.
-- DropIndex
DROP INDEX "Session_classGroupId_date_startTime_key";
