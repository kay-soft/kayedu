-- CreateTable
CREATE TABLE "SessionRating" (
    "id" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionRatingSkip" (
    "id" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionRatingSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionRating_teacherId_idx" ON "SessionRating"("teacherId");

-- CreateIndex
CREATE INDEX "SessionRating_sessionId_idx" ON "SessionRating"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionRating_studentUserId_sessionId_key" ON "SessionRating"("studentUserId", "sessionId");

-- CreateIndex
CREATE INDEX "SessionRatingSkip_studentUserId_idx" ON "SessionRatingSkip"("studentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionRatingSkip_studentUserId_sessionId_key" ON "SessionRatingSkip"("studentUserId", "sessionId");

-- AddForeignKey
ALTER TABLE "SessionRating" ADD CONSTRAINT "SessionRating_studentUserId_fkey" FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRating" ADD CONSTRAINT "SessionRating_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRatingSkip" ADD CONSTRAINT "SessionRatingSkip_studentUserId_fkey" FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRatingSkip" ADD CONSTRAINT "SessionRatingSkip_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
