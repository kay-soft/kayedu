-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "altPhone" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "altPhone" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "StudentCodeCounter" (
    "centerId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1001,

    CONSTRAINT "StudentCodeCounter_pkey" PRIMARY KEY ("centerId")
);

-- CreateIndex
CREATE INDEX "Membership_centerId_role_idx" ON "Membership"("centerId", "role");

-- CreateIndex
CREATE INDEX "StudentProfile_centerId_active_idx" ON "StudentProfile"("centerId", "active");

