-- CreateEnum
CREATE TYPE "AssistantPreset" AS ENUM ('GRADER', 'CO_TEACHER', 'FULL');

-- CreateTable
CREATE TABLE "AssistantInvite" (
    "id" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "preset" "AssistantPreset" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherAssistant" (
    "id" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "assistantUserId" TEXT NOT NULL,
    "preset" "AssistantPreset" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TeacherAssistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantPermissionGrant" (
    "assistantId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "AssistantPermissionGrant_pkey" PRIMARY KEY ("assistantId","permission")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantInvite_codeHash_key" ON "AssistantInvite"("codeHash");

-- CreateIndex
CREATE INDEX "AssistantInvite_teacherUserId_idx" ON "AssistantInvite"("teacherUserId");

-- CreateIndex
CREATE INDEX "TeacherAssistant_teacherUserId_idx" ON "TeacherAssistant"("teacherUserId");

-- CreateIndex
CREATE INDEX "TeacherAssistant_assistantUserId_idx" ON "TeacherAssistant"("assistantUserId");

-- AddForeignKey
ALTER TABLE "AssistantInvite" ADD CONSTRAINT "AssistantInvite_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantInvite" ADD CONSTRAINT "AssistantInvite_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAssistant" ADD CONSTRAINT "TeacherAssistant_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherAssistant" ADD CONSTRAINT "TeacherAssistant_assistantUserId_fkey" FOREIGN KEY ("assistantUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantPermissionGrant" ADD CONSTRAINT "AssistantPermissionGrant_assistantId_fkey" FOREIGN KEY ("assistantId") REFERENCES "TeacherAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── Hand-written (W7a, D-W36) ─────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "AssistantInvite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeacherAssistant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssistantPermissionGrant" ENABLE ROW LEVEL SECURITY;

-- A code is stored as its sha256 only: a 64-hex digest is the one shape this
-- column accepts, so a plaintext code (12 characters) can never land in it
-- (the F3 FamilyInvitation rule).
ALTER TABLE "AssistantInvite" ADD CONSTRAINT "AssistantInvite_codeHash_sha256"
  CHECK ("codeHash" ~ '^[0-9a-f]{64}$');

-- No self-assist (D-W16): a teacher is never their own assistant.
ALTER TABLE "TeacherAssistant" ADD CONSTRAINT "TeacherAssistant_not_self"
  CHECK ("teacherUserId" <> "assistantUserId");

-- One live link per (teacher, assistant): a removed or left link (revokedAt
-- set) frees the pair for a new invite. Prisma cannot express a partial
-- index, so a generated `prisma migrate diff` shows it as a DROP INDEX —
-- delete that line from any future migration (CLAUDE.md rule 7);
-- `check:assistants` fails if the index is gone.
CREATE UNIQUE INDEX "TeacherAssistant_pair_live_key"
  ON "TeacherAssistant" ("teacherUserId", "assistantUserId")
  WHERE "revokedAt" IS NULL;
