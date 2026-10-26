-- F2: the person's own self-declared contact phone (Account settings).
-- Additive only. NOT unique, never an identity key (D-02 (a)).
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "contactPhone" TEXT;

