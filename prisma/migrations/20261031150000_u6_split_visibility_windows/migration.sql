-- U6: three separate history limits (docs/00 §5.1 "Data visibility window").
-- Additive. `dataVisibilityDays` stays, deprecated and unread by the new code,
-- so the live site keeps working until U6 deploys (backlog: drop after the pilot).

-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "centerDataVisibilityDays" INTEGER NOT NULL DEFAULT 365,
ADD COLUMN     "teacherDataVisibilityDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "teacherHistoryDays" INTEGER NOT NULL DEFAULT 0;

-- Backfill (hand-written): every existing branch keeps the window it has
-- today, clamped to each field's cap — centre 1–365, teacher 1–30. Branches
-- created after this migration take the column defaults (365 / 30).
UPDATE "CenterSettings"
SET "centerDataVisibilityDays"  = LEAST(GREATEST("dataVisibilityDays", 1), 365),
    "teacherDataVisibilityDays" = LEAST(GREATEST("dataVisibilityDays", 1), 30);
