-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "photoUrl" TEXT;

-- CreateIndex
CREATE INDEX "StudentBlock_centerId_scope_refId_idx" ON "StudentBlock"("centerId", "scope", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentBlock_centerId_scope_refId_blockedUserId_key" ON "StudentBlock"("centerId", "scope", "refId", "blockedUserId");

