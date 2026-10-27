-- F6: joining options + single-session booking (docs/00-master-product-spec.md
-- §4.3, §5.1 "Single-session booking"). Additive only: three enums, two
-- nullable/defaulted ClassGroup columns (every existing class stays OFF, so it
-- behaves exactly as before), one new table, and two CHECKs.
-- (Generated with the read-only `prisma migrate diff --from-url ... --script`;
-- the RLS line and the CHECKs at the end are hand-written.)

-- CreateEnum
CREATE TYPE "SessionBookingMode" AS ENUM ('OFF', 'INSTANT', 'APPROVAL');

-- CreateEnum
CREATE TYPE "SessionBookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SessionBookingCancelReason" AS ENUM ('STUDENT', 'SESSION_CANCELLED', 'SESSION_RESCHEDULED', 'STAFF');

-- AlterTable
ALTER TABLE "ClassGroup" ADD COLUMN     "maxBookingSeats" INTEGER,
ADD COLUMN     "sessionBookingMode" "SessionBookingMode" NOT NULL DEFAULT 'OFF';

-- CreateTable
CREATE TABLE "SessionBooking" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "SessionBookingStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" "SessionBookingCancelReason",
    "sessionAttendeeId" TEXT,

    CONSTRAINT "SessionBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionBooking_sessionAttendeeId_key" ON "SessionBooking"("sessionAttendeeId");

-- CreateIndex
CREATE INDEX "SessionBooking_centerId_idx" ON "SessionBooking"("centerId");

-- CreateIndex
CREATE INDEX "SessionBooking_studentId_idx" ON "SessionBooking"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionBooking_sessionId_studentId_key" ON "SessionBooking"("sessionId", "studentId");

-- AddForeignKey
ALTER TABLE "SessionBooking" ADD CONSTRAINT "SessionBooking_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionBooking" ADD CONSTRAINT "SessionBooking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionBooking" ADD CONSTRAINT "SessionBooking_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionBooking" ADD CONSTRAINT "SessionBooking_sessionAttendeeId_fkey" FOREIGN KEY ("sessionAttendeeId") REFERENCES "SessionAttendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Data API lockdown (SEC-2a, D-19 (a)) ───────────────────────────────────
-- RLS on, zero policies, like every other public table: the app reaches this
-- table only through Prisma on the server.
ALTER TABLE "SessionBooking" ENABLE ROW LEVEL SECURITY;

-- ── Integrity ──────────────────────────────────────────────────────────────

-- An extra cap of zero or less would make bookable sessions no one can book.
ALTER TABLE "ClassGroup" ADD CONSTRAINT "ClassGroup_maxBookingSeats_min"
  CHECK ("maxBookingSeats" IS NULL OR "maxBookingSeats" >= 1);

-- A cancel reason belongs to a CANCELLED booking and to nothing else.
ALTER TABLE "SessionBooking" ADD CONSTRAINT "SessionBooking_cancel_shape"
  CHECK (("status" = 'CANCELLED') = ("cancelReason" IS NOT NULL));
