-- SEC-2a: identity & access fixes (docs/07-security-audit.md; decisions
-- D-01, D-02, D-04, D-25 in its §6).
--
-- 1. User.emailVerifiedAt — Supabase's email_confirmed_at, mirrored on every
--    sync, so an email-based link can require it (REQUIRE_EMAIL_CONFIRMATION).
-- 2. AccountClaim — a sign-up whose email equals a staff-created, never-
--    signed-in person opens a PENDING claim that staff approve in person; it
--    never links on its own (D-01, SEC-01).
-- 3. ParentLinkStatus.REVOKED + ParentLink.revokedAt/revokedReason — a
--    parent-phone change revokes the links it no longer matches (D-04, SEC-04).
-- 4. Center.logoUrl (a free URL the server fetched — SEC-53) becomes
--    Center.logoPath, a key in the private `logos` bucket (D-25). An old URL is
--    not a storage key, so existing values are dropped: a platform admin
--    re-uploads the logo.
-- 5. RateLimitBucket — the shared store behind lib/rate-limit.ts, so a limit
--    holds across serverless instances (SEC-11, SEC-27, SEC-67).

-- CreateEnum
CREATE TYPE "AccountClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ParentLinkStatus" ADD VALUE 'REVOKED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Center" RENAME COLUMN "logoUrl" TO "logoPath";
UPDATE "Center" SET "logoPath" = NULL WHERE "logoPath" IS NOT NULL;

-- AlterTable
ALTER TABLE "ParentLink" ADD COLUMN "revokedAt" TIMESTAMP(3),
ADD COLUMN "revokedReason" TEXT;

-- CreateTable
CREATE TABLE "AccountClaim" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "status" "AccountClaimStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAtCenterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AccountClaim_targetUserId_status_idx" ON "AccountClaim"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "AccountClaim_authId_idx" ON "AccountClaim"("authId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountClaim_authId_targetUserId_key" ON "AccountClaim"("authId", "targetUserId");

-- CreateIndex
CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");

-- AddForeignKey
ALTER TABLE "AccountClaim" ADD CONSTRAINT "AccountClaim_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New tables carry RLS from birth (the lockdown migration below covers every
-- table that exists when it runs; this keeps the rule local and explicit).
ALTER TABLE "AccountClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitBucket" ENABLE ROW LEVEL SECURITY;
