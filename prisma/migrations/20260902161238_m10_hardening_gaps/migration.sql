-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "teacherEditDeadlineHours" INTEGER;

-- AlterTable
ALTER TABLE "ClassGroup" ADD COLUMN     "allowExcused" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "isTrustedTeacher" BOOLEAN NOT NULL DEFAULT true;
