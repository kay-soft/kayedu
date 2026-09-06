-- DropIndex
DROP INDEX "Payment_sessionAttendeeId_key";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedBy" TEXT;

-- CreateIndex
CREATE INDEX "Payment_sessionAttendeeId_idx" ON "Payment"("sessionAttendeeId");
