-- U9 — only teachers have photos, and a class can have a cover image.
-- Both columns hold a storage KEY (a path in a private bucket under the
-- centre's own folder), never a URL. Additive; every existing row stays NULL.
-- "User"."avatarUrl" is left in place, unused (deprecated; dropped after the pilot).

-- AlterTable
ALTER TABLE "ClassGroup" ADD COLUMN     "coverKey" TEXT;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "photoKey" TEXT;
