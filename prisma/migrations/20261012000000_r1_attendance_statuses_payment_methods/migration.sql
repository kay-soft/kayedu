-- R1: attendance statuses + configurable payment methods
-- (docs/00-master-product-spec.md §5.1 "Excused removed" / "Payment methods
-- configurable per centre", docs/03-build-order.md "R1").
--
-- No production data exists when this migration runs: every database it
-- targets holds seed/demo data only. The conversions below still run in full
-- so demo history survives intact rather than being dropped.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. EXCUSED is removed. Any EXCUSED attendee becomes ABSENT *before* the
--    enum shrinks, so the cast below can never meet a value it lacks. ABSENT
--    is the only honest mapping: an excused student did not attend, and
--    nothing was payable for them (spec §5 "No debt").
-- ─────────────────────────────────────────────────────────────────────────

UPDATE "SessionAttendee" SET "attendanceStatus" = 'ABSENT' WHERE "attendanceStatus" = 'EXCUSED';

CREATE TYPE "AttendanceStatus_new" AS ENUM ('PRESENT', 'LATE', 'ABSENT');
ALTER TABLE "SessionAttendee" ALTER COLUMN "attendanceStatus" DROP DEFAULT;
ALTER TABLE "SessionAttendee" ALTER COLUMN "attendanceStatus" TYPE "AttendanceStatus_new" USING ("attendanceStatus"::text::"AttendanceStatus_new");
ALTER TYPE "AttendanceStatus" RENAME TO "AttendanceStatus_old";
ALTER TYPE "AttendanceStatus_new" RENAME TO "AttendanceStatus";
DROP TYPE "AttendanceStatus_old";
ALTER TABLE "SessionAttendee" ALTER COLUMN "attendanceStatus" SET DEFAULT 'PRESENT';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ClassGroup.allowExcused (the M10 per-class toggle EXCUSED no longer
--    needs) and ClassGroup.attendanceRequired (stored and displayed, never
--    read by any behaviour) are dropped. Old ChangeRequest payloads may still
--    carry an "attendanceRequired" key; that JSON is left as written and the
--    readers simply ignore the key.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ClassGroup" DROP COLUMN "allowExcused",
DROP COLUMN "attendanceRequired";

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Payment methods become per-centre rows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "CenterPaymentMethod" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CenterPaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CenterPaymentMethod_centerId_idx" ON "CenterPaymentMethod"("centerId");

ALTER TABLE "CenterPaymentMethod" ADD CONSTRAINT "CenterPaymentMethod_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3a. One row per old enum value for every existing centre — all four, so
--     every historical payment has a row to point at. The enum's order is
--     kept through createdAt (pickers list oldest first, so Cash leads).
--     Centres created after this migration get Cash / InstaPay / Vodafone
--     Cash instead (lib/db/payment-methods.ts DEFAULT_PAYMENT_METHOD_NAMES).
INSERT INTO "CenterPaymentMethod" ("id", "centerId", "name", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", m."name", true,
       CURRENT_TIMESTAMP + (m."ord" * INTERVAL '1 millisecond'),
       CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES (0, 'Cash'), (1, 'InstaPay'), (2, 'Wallet'), (3, 'Visa')) AS m("ord", "name");

-- 3b. Backfill each payment from its old enum value: the matching row of its
--     own centre, and that row's name as the frozen label.
ALTER TABLE "Payment" ADD COLUMN "paymentMethodId" TEXT,
ADD COLUMN "methodLabelSnapshot" TEXT;

UPDATE "Payment" p
SET "paymentMethodId" = cpm."id",
    "methodLabelSnapshot" = cpm."name"
FROM "CenterPaymentMethod" cpm
WHERE cpm."centerId" = p."centerId"
  AND cpm."name" = CASE p."method"::text
    WHEN 'CASH' THEN 'Cash'
    WHEN 'INSTAPAY' THEN 'InstaPay'
    WHEN 'WALLET' THEN 'Wallet'
    WHEN 'VISA' THEN 'Visa'
  END;

-- 3c. Every payment now has both values — enforce it (this fails loudly if
--     the backfill missed a row, rather than silently orphaning one).
ALTER TABLE "Payment" ALTER COLUMN "paymentMethodId" SET NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "methodLabelSnapshot" SET NOT NULL;

CREATE INDEX "Payment_paymentMethodId_idx" ON "Payment"("paymentMethodId");

-- RESTRICT: a method a payment references is deactivated, never deleted.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "CenterPaymentMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3d. Only now does the old column (and its enum) go.
ALTER TABLE "Payment" DROP COLUMN "method";
DROP TYPE "PaymentMethod";
