-- CreateTable
CREATE TABLE "WorkspaceShareCode" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceShareCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceShareCode_codeHash_key" ON "WorkspaceShareCode"("codeHash");

-- CreateIndex
CREATE INDEX "WorkspaceShareCode_centerId_idx" ON "WorkspaceShareCode"("centerId");

-- CreateIndex
CREATE INDEX "WorkspaceShareCode_studentProfileId_idx" ON "WorkspaceShareCode"("studentProfileId");

-- AddForeignKey
ALTER TABLE "WorkspaceShareCode" ADD CONSTRAINT "WorkspaceShareCode_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceShareCode" ADD CONSTRAINT "WorkspaceShareCode_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceShareCode" ADD CONSTRAINT "WorkspaceShareCode_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceShareCode" ADD CONSTRAINT "WorkspaceShareCode_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;




-- ── Hand-written (W10, D-W43) ─────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "WorkspaceShareCode" ENABLE ROW LEVEL SECURITY;

-- At most one active share code per workspace profile (D-W43 item 1):
-- "Share code" revokes the older one in the same transaction before it
-- writes a new one. Prisma cannot express a partial index, so a generated
-- `prisma migrate diff` shows it as a DROP INDEX — delete that line from any
-- future migration (CLAUDE.md rule 7); `check:workspaces` fails if the index
-- is gone.
CREATE UNIQUE INDEX "WorkspaceShareCode_one_active_per_profile"
  ON "WorkspaceShareCode" ("studentProfileId")
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;
