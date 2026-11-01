-- U8 — a student can leave a class. The row is ended exactly as a staff removal
-- ends it (status REMOVED); this nullable timestamp is set only when the
-- STUDENT did it, so staff can read "Left <class> on <date>, by the student".
-- Additive; every existing row stays NULL.

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "leftByStudentAt" TIMESTAMP(3);
