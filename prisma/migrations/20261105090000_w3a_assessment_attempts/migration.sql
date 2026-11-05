-- CreateEnum
CREATE TYPE "AssessmentFinalisedBy" AS ENUM ('STUDENT', 'DEADLINE', 'ONE_SITTING_GAP');

-- CreateTable
CREATE TABLE "AssessmentAttempt" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "finalisedBy" "AssessmentFinalisedBy",
    "score" INTEGER,
    "maxScore" INTEGER,

    CONSTRAINT "AssessmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentAnswer" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "optionId" TEXT,
    "isCorrect" BOOLEAN,
    "pointsAwarded" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentAttempt_centerId_idx" ON "AssessmentAttempt"("centerId");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_centerId_studentProfileId_idx" ON "AssessmentAttempt"("centerId", "studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAttempt_assessmentId_studentProfileId_key" ON "AssessmentAttempt"("assessmentId", "studentProfileId");

-- CreateIndex
CREATE INDEX "AssessmentAnswer_centerId_idx" ON "AssessmentAnswer"("centerId");

-- CreateIndex
CREATE INDEX "AssessmentAnswer_questionId_idx" ON "AssessmentAnswer"("questionId");

-- CreateIndex
CREATE INDEX "AssessmentAnswer_optionId_idx" ON "AssessmentAnswer"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAnswer_attemptId_questionId_key" ON "AssessmentAnswer"("attemptId", "questionId");

-- AddForeignKey
ALTER TABLE "AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentAnswer" ADD CONSTRAINT "AssessmentAnswer_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "AssessmentOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;





-- ── Hand-written (W3a) ────────────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "AssessmentAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssessmentAnswer" ENABLE ROW LEVEL SECURITY;

-- Final means both: when it ended and how. `finaliseIfDue` and the student's
-- submit write the two in one conditional update (D-W10, D-W31).
ALTER TABLE "AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_final_check"
  CHECK (("submittedAt" IS NULL) = ("finalisedBy" IS NULL));
