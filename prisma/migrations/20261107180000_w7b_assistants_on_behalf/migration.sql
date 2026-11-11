-- W7b (D-W18, D-W19, D-W37): assistants act on the teacher's behalf.
-- Additive only: two nullable id columns and one boolean defaulting to true
-- (every existing branch allows assistants). Generated with the read-only
-- `prisma migrate diff --from-url <DIRECT_URL> --to-schema-datamodel`; no
-- DROP INDEX was generated. The three tables already carry the RLS lockdown
-- (SEC-2a), so no hand-written SQL is needed.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "onBehalfOfUserId" TEXT;

-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "allowTeacherAssistants" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "viaAssistantUserId" TEXT;

