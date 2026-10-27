-- F4: sign-up intent, the account grade, and previewable/undoable bulk grade
-- promotion (docs/00-master-product-spec.md §4.1 item 4, §4.3, §5.1).
-- Additive only: one enum, two nullable User columns, two tables. Nothing is
-- dropped, backfilled or rewritten — every existing account keeps a null
-- signupIntent and gradeId. (Generated with the read-only
-- `prisma migrate diff --from-url ... --script`; the CHECK and the RLS lines
-- at the end are hand-written.)

-- CreateEnum
CREATE TYPE "SignupIntent" AS ENUM ('STUDENT', 'PARENT', 'TEACHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "gradeId" TEXT,
ADD COLUMN     "signupIntent" "SignupIntent";

-- CreateTable
CREATE TABLE "GradePromotionBatch" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "fromGradeId" TEXT NOT NULL,
    "toGradeId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,

    CONSTRAINT "GradePromotionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GradePromotionItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "previousGradeId" TEXT NOT NULL,

    CONSTRAINT "GradePromotionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GradePromotionBatch_centerId_createdAt_idx" ON "GradePromotionBatch"("centerId", "createdAt");

-- CreateIndex
CREATE INDEX "GradePromotionItem_studentProfileId_idx" ON "GradePromotionItem"("studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "GradePromotionItem_batchId_studentProfileId_key" ON "GradePromotionItem"("batchId", "studentProfileId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "CatalogGrade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradePromotionBatch" ADD CONSTRAINT "GradePromotionBatch_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradePromotionBatch" ADD CONSTRAINT "GradePromotionBatch_fromGradeId_fkey" FOREIGN KEY ("fromGradeId") REFERENCES "CatalogGrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradePromotionBatch" ADD CONSTRAINT "GradePromotionBatch_toGradeId_fkey" FOREIGN KEY ("toGradeId") REFERENCES "CatalogGrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradePromotionItem" ADD CONSTRAINT "GradePromotionItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GradePromotionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GradePromotionItem" ADD CONSTRAINT "GradePromotionItem_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An undo is stamped whole or not at all.
ALTER TABLE "GradePromotionBatch"
  ADD CONSTRAINT "GradePromotionBatch_undone_both_or_neither"
  CHECK (("undoneAt" IS NULL) = ("undoneBy" IS NULL));

-- A promotion moves a grade to a different grade.
ALTER TABLE "GradePromotionBatch"
  ADD CONSTRAINT "GradePromotionBatch_distinct_grades"
  CHECK ("fromGradeId" <> "toGradeId");

-- New tables carry RLS from birth (SEC-2a lockdown rule; check:rls asserts it).
ALTER TABLE "GradePromotionBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GradePromotionItem" ENABLE ROW LEVEL SECURITY;
