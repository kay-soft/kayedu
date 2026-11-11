-- CreateEnum
CREATE TYPE "AssessmentType" AS ENUM ('EXAM', 'HOMEWORK');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "sessionId" TEXT,
    "teacherMembershipId" TEXT NOT NULL,
    "type" "AssessmentType" NOT NULL,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "oneSitting" BOOLEAN NOT NULL DEFAULT false,
    "shuffle" BOOLEAN NOT NULL DEFAULT false,
    "showScore" BOOLEAN NOT NULL DEFAULT false,
    "showCorrectAnswers" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentQuestion" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssessmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentOption" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AssessmentOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Assessment_centerId_idx" ON "Assessment"("centerId");

-- CreateIndex
CREATE INDEX "Assessment_centerId_teacherMembershipId_idx" ON "Assessment"("centerId", "teacherMembershipId");

-- CreateIndex
CREATE INDEX "Assessment_centerId_classGroupId_idx" ON "Assessment"("centerId", "classGroupId");

-- CreateIndex
CREATE INDEX "Assessment_centerId_sessionId_idx" ON "Assessment"("centerId", "sessionId");

-- CreateIndex
CREATE INDEX "AssessmentQuestion_centerId_idx" ON "AssessmentQuestion"("centerId");

-- CreateIndex
CREATE INDEX "AssessmentQuestion_assessmentId_position_idx" ON "AssessmentQuestion"("assessmentId", "position");

-- CreateIndex
CREATE INDEX "AssessmentOption_centerId_idx" ON "AssessmentOption"("centerId");

-- CreateIndex
CREATE INDEX "AssessmentOption_questionId_position_idx" ON "AssessmentOption"("questionId", "position");

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_classGroupId_fkey" FOREIGN KEY ("classGroupId") REFERENCES "ClassGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_teacherMembershipId_fkey" FOREIGN KEY ("teacherMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentQuestion" ADD CONSTRAINT "AssessmentQuestion_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentQuestion" ADD CONSTRAINT "AssessmentQuestion_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentOption" ADD CONSTRAINT "AssessmentOption_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentOption" ADD CONSTRAINT "AssessmentOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;




-- ── Hand-written (W2) ─────────────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "Assessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentOption" ENABLE ROW LEVEL SECURITY;

-- The type says which fields apply (the Settlement style, docs/01). A draft
-- EXAM may have no window yet ("Ready to publish" asks for it, D-W30); it
-- never has a deadline. A HOMEWORK always has its session and a deadline
-- (D-W03 defaults one) and never a window. One sitting is EXAM-only (D-W02).
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_type_fields_check"
  CHECK (
    ("type" = 'EXAM' AND "deadline" IS NULL)
    OR ("type" = 'HOMEWORK' AND "sessionId" IS NOT NULL AND "deadline" IS NOT NULL
        AND "windowStart" IS NULL AND "windowEnd" IS NULL AND "oneSitting" = false)
  );
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_window_order_check"
  CHECK ("windowStart" IS NULL OR "windowEnd" IS NULL OR "windowEnd" > "windowStart");
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_duration_range_check"
  CHECK ("durationMinutes" IS NULL OR "durationMinutes" BETWEEN 1 AND 600);

-- Points are integers 1–100 (D-W04); text lengths match the writer's limits.
ALTER TABLE "AssessmentQuestion" ADD CONSTRAINT "AssessmentQuestion_points_range_check"
  CHECK ("points" BETWEEN 1 AND 100);
ALTER TABLE "AssessmentQuestion" ADD CONSTRAINT "AssessmentQuestion_text_length_check"
  CHECK (char_length("text") <= 2000);
ALTER TABLE "AssessmentOption" ADD CONSTRAINT "AssessmentOption_text_length_check"
  CHECK (char_length("text") <= 500);

-- At most one correct option per question (D-W04; "exactly one" is the
-- publish rule, W3). Prisma 6 cannot express a partial index, so every future
-- `prisma migrate diff` emits a DROP INDEX for this one — delete that line
-- from the generated migration (CLAUDE.md rule 7, docs/02 §11);
-- `check:assessments` fails if the index is gone.
CREATE UNIQUE INDEX "AssessmentOption_one_correct_per_question"
  ON "AssessmentOption"("questionId") WHERE "isCorrect";

-- assessment.manage.own (D-W30) — TEACHER's provisioning baseline gains it
-- (lib/auth/permissions.ts DEFAULT_ROLE_GRANTS), so every existing centre
-- gets the same row a new one would: every centre today is a branch (W8 adds
-- `Center.kind`). ON CONFLICT keeps a centre's own explicit row, so running
-- this twice — or after an Owner switched it off — changes nothing.
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", 'TEACHER'::"Role", 'assessment.manage.own', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
ON CONFLICT ("centerId", "role", "action") DO NOTHING;
