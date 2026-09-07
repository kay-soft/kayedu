-- CreateEnum
CREATE TYPE "ParentLinkStatus" AS ENUM ('PENDING', 'VERIFIED');

-- CreateTable
CREATE TABLE "ParentLink" (
    "id" TEXT NOT NULL,
    "parentUserId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "status" "ParentLinkStatus" NOT NULL DEFAULT 'PENDING',
    "matchedPhone" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParentLink_parentUserId_idx" ON "ParentLink"("parentUserId");

-- CreateIndex
CREATE INDEX "ParentLink_studentProfileId_idx" ON "ParentLink"("studentProfileId");

-- CreateIndex
CREATE INDEX "ParentLink_centerId_idx" ON "ParentLink"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentLink_parentUserId_studentProfileId_key" ON "ParentLink"("parentUserId", "studentProfileId");

-- AddForeignKey
ALTER TABLE "ParentLink" ADD CONSTRAINT "ParentLink_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentLink" ADD CONSTRAINT "ParentLink_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentLink" ADD CONSTRAINT "ParentLink_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;
