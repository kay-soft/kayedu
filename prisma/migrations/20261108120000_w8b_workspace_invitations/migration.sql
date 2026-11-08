-- CreateEnum
CREATE TYPE "WorkspaceInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'WORKSPACE_INVITATION';

-- CreateTable
CREATE TABLE "WorkspaceInvitation" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "status" "WorkspaceInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_centerId_idx" ON "WorkspaceInvitation"("centerId");

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_studentProfileId_idx" ON "WorkspaceInvitation"("studentProfileId");

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_targetUserId_status_idx" ON "WorkspaceInvitation"("targetUserId", "status");

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── Hand-written (W8b, D-W39) ─────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "WorkspaceInvitation" ENABLE ROW LEVEL SECURITY;

-- At most one PENDING invitation per workspace profile (D-W39 item 5):
-- "Invite again" cancels the older one in the same transaction before it
-- writes a new one. Prisma cannot express a partial index, so a generated
-- `prisma migrate diff` shows it as a DROP INDEX — delete that line from any
-- future migration (CLAUDE.md rule 7); `check:workspaces` fails if the index
-- is gone.
CREATE UNIQUE INDEX "WorkspaceInvitation_one_pending_per_profile"
  ON "WorkspaceInvitation" ("studentProfileId")
  WHERE "status" = 'PENDING';
