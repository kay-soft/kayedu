-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "receptionistCanCorrectAttendance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receptionistCanViewProfit" BOOLEAN NOT NULL DEFAULT false;
