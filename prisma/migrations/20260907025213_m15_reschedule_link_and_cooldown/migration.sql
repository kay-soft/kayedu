-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "rescheduledToId" TEXT;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "rejectedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Session_rescheduledToId_key" ON "Session"("rescheduledToId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_rescheduledToId_fkey" FOREIGN KEY ("rescheduledToId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
