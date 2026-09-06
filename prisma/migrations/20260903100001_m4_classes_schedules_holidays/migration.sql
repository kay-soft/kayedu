-- CreateEnum
CREATE TYPE "ConflictPolicy" AS ENUM ('WARN', 'DENY');

-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "scheduleConflictPolicy" "ConflictPolicy" NOT NULL DEFAULT 'WARN';

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Holiday_centerId_idx" ON "Holiday"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_centerId_date_key" ON "Holiday"("centerId", "date");

-- CreateIndex
CREATE INDEX "Session_centerId_roomId_date_idx" ON "Session"("centerId", "roomId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Session_classGroupId_date_startTime_key" ON "Session"("classGroupId", "date", "startTime");

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

