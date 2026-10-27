-- T5: voiding or refunding a payment on a live session resets the student to
-- not checked in; they can be checked in and pay again (docs/03 T5,
-- docs/00 §5 "Void vs. refund").
--
-- 1. SessionAttendanceChange.refundedPaymentId — the refunded payment that
--    caused a reset, so the change log reads as a refund and not as a void.
--    Additive, nullable, SET NULL like voidedPaymentId.
-- 2. Payment_one_active_per_attendee: the "one active payment" slot is now
--    "not voided AND not refunded" — a refund frees it, exactly as a void
--    already did. The invariant is unchanged in kind: at most one payment per
--    attendee that is neither voided nor refunded. The new index is created
--    under a temporary name first, then the old one is dropped and the new one
--    renamed, so there is no moment without the guarantee. It cannot fail on
--    existing data: the old predicate was strictly stronger.
--    `recordPayment`'s ON CONFLICT predicate (lib/db/payments.ts) matches it
--    exactly; check:security asserts that statically against this file.
--
-- Payment_not_voided_and_refunded (the CHECK) is kept. No data changes.

-- ── 1. The refund cause on a change row ───────────────────────────────────

-- AlterTable
ALTER TABLE "SessionAttendanceChange" ADD COLUMN     "refundedPaymentId" TEXT;

-- AddForeignKey
ALTER TABLE "SessionAttendanceChange" ADD CONSTRAINT "SessionAttendanceChange_refundedPaymentId_fkey" FOREIGN KEY ("refundedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. The active-payment slot: not voided AND not refunded ───────────────

CREATE UNIQUE INDEX "Payment_one_active_per_attendee_t5"
  ON "Payment"("sessionAttendeeId") WHERE "voided" = false AND "refunded" = false;

DROP INDEX "Payment_one_active_per_attendee";

ALTER INDEX "Payment_one_active_per_attendee_t5" RENAME TO "Payment_one_active_per_attendee";
