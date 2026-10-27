-- F3: family links — parent onboarding with a one-time code (OD-6 decided;
-- docs/00-master-product-spec.md §5.1 "Parent role & portal").
-- Additive only: two tables, four enums, constraints, and a backfill. Nothing
-- is dropped — ParentLink stays in place, deprecated, until after the pilot.
-- (Generated with the read-only `prisma migrate diff --from-url ... --script`;
-- the RLS lines, the CHECKs, the partial unique index and the backfill at the
-- end are hand-written.)

-- CreateEnum
CREATE TYPE "FamilyLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "FamilyLinkSource" AS ENUM ('STUDENT_INVITE', 'CENTER_CODE', 'LEGACY_VERIFIED');

-- CreateEnum
CREATE TYPE "FamilyInvitationSource" AS ENUM ('STUDENT_INVITE', 'CENTER_CODE');

-- CreateEnum
CREATE TYPE "FamilyInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- CreateTable
CREATE TABLE "FamilyLink" (
    "id" TEXT NOT NULL,
    "parentUserId" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "status" "FamilyLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "FamilyLinkSource" NOT NULL,
    "invitationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,

    CONSTRAINT "FamilyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyInvitation" (
    "id" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "source" "FamilyInvitationSource" NOT NULL,
    "issuingCenterId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declaredParentFirstName" TEXT,
    "declaredParentLastName" TEXT,
    "declaredParentPhone" TEXT,
    "status" "FamilyInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "FamilyInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FamilyLink_invitationId_key" ON "FamilyLink"("invitationId");

-- CreateIndex
CREATE INDEX "FamilyLink_parentUserId_status_idx" ON "FamilyLink"("parentUserId", "status");

-- CreateIndex
CREATE INDEX "FamilyLink_studentUserId_status_idx" ON "FamilyLink"("studentUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyLink_parentUserId_studentUserId_key" ON "FamilyLink"("parentUserId", "studentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyInvitation_codeHash_key" ON "FamilyInvitation"("codeHash");

-- CreateIndex
CREATE INDEX "FamilyInvitation_studentUserId_status_idx" ON "FamilyInvitation"("studentUserId", "status");

-- CreateIndex
CREATE INDEX "FamilyInvitation_issuingCenterId_idx" ON "FamilyInvitation"("issuingCenterId");

-- AddForeignKey
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_studentUserId_fkey" FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "FamilyInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyInvitation" ADD CONSTRAINT "FamilyInvitation_studentUserId_fkey" FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyInvitation" ADD CONSTRAINT "FamilyInvitation_issuingCenterId_fkey" FOREIGN KEY ("issuingCenterId") REFERENCES "Center"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- New tables carry RLS from birth (SEC-2a lockdown rule; check:rls asserts it).
ALTER TABLE "FamilyLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FamilyInvitation" ENABLE ROW LEVEL SECURITY;

-- ── Integrity ──────────────────────────────────────────────────────────────

-- A code is stored as its sha256 only: a 64-hex digest is the one shape this
-- column accepts, so a plaintext code (8 characters) can never land in it.
ALTER TABLE "FamilyInvitation" ADD CONSTRAINT "FamilyInvitation_codeHash_sha256"
  CHECK ("codeHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "FamilyInvitation" ADD CONSTRAINT "FamilyInvitation_codeHint_length"
  CHECK (char_length("codeHint") = 2);

-- Nobody is their own parent.
ALTER TABLE "FamilyLink" ADD CONSTRAINT "FamilyLink_not_self"
  CHECK ("parentUserId" <> "studentUserId");

-- One live branch code per (student, branch): regenerating revokes the
-- previous one in the same transaction, and a race cannot leave two.
CREATE UNIQUE INDEX "FamilyInvitation_one_pending_branch_code"
  ON "FamilyInvitation"("studentUserId", "issuingCenterId")
  WHERE "status" = 'PENDING' AND "source" = 'CENTER_CODE';

-- ── Backfill: ParentLink → FamilyLink ─────────────────────────────────────
-- Every VERIFIED ParentLink becomes one ACTIVE FamilyLink between the parent
-- and the child's global User (source LEGACY_VERIFIED), deduplicated: a parent
-- verified at two of the same child's branches gets one link. PENDING (and
-- REVOKED) ParentLinks are not migrated — a phone match never granted access
-- and grants nothing now. The earliest verification is kept as the link date.
INSERT INTO "FamilyLink" ("id", "parentUserId", "studentUserId", "status", "source", "createdAt")
SELECT
  gen_random_uuid()::text,
  pl."parentUserId",
  sp."userId",
  'ACTIVE'::"FamilyLinkStatus",
  'LEGACY_VERIFIED'::"FamilyLinkSource",
  MIN(COALESCE(pl."verifiedAt", pl."createdAt"))
FROM "ParentLink" AS pl
JOIN "StudentProfile" AS sp ON sp."id" = pl."studentProfileId"
WHERE pl."status" = 'VERIFIED'
  AND pl."parentUserId" <> sp."userId"
GROUP BY pl."parentUserId", sp."userId"
ON CONFLICT ("parentUserId", "studentUserId") DO NOTHING;
