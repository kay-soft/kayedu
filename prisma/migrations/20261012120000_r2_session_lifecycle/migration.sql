-- R2 — Session lifecycle: end/lock, auto-late, auto-absent, change log
-- (docs/00-master-product-spec.md §5.1 "Session lifecycle", docs/03-build-order.md R2).
--
-- Nothing here rewrites an existing session. A past session with no
-- closedAt is closed lazily — by the next read/write that touches it
-- (lib/db/session-lifecycle.ts) — never by this migration.

-- ── 1. Session close fields ─────────────────────────────────────────────────
CREATE TYPE "SessionCloseMode" AS ENUM ('MANUAL', 'AUTO');

ALTER TABLE "Session" ADD COLUMN "closeMode" "SessionCloseMode",
ADD COLUMN "closedAt" TIMESTAMP(3),
ADD COLUMN "closedBy" TEXT;

-- ── 2. Settlement: which counting rule produced the stored total ────────────
-- New rows (created under R2) count only payments of sessions already closed
-- at creation. Every row that exists right now predates that rule, so it is
-- backfilled false: its total counted every non-voided, non-refunded payment
-- in scope regardless of closure, and a later void/refund adjusts it on that
-- basis (lib/db/settlements.ts's adjustUnpaidSettlementsForReversal).
ALTER TABLE "Settlement" ADD COLUMN "closedSessionsOnly" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Settlement" SET "closedSessionsOnly" = false;

-- ── 3. SessionAttendanceChange ──────────────────────────────────────────────
CREATE TABLE "SessionAttendanceChange" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "fromStatus" "AttendanceStatus" NOT NULL,
    "toStatus" "AttendanceStatus" NOT NULL,
    "voidedPaymentId" TEXT,
    "reason" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionAttendanceChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SessionAttendanceChange_centerId_idx" ON "SessionAttendanceChange"("centerId");
CREATE INDEX "SessionAttendanceChange_centerId_sessionId_idx" ON "SessionAttendanceChange"("centerId", "sessionId");

ALTER TABLE "SessionAttendanceChange" ADD CONSTRAINT "SessionAttendanceChange_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionAttendanceChange" ADD CONSTRAINT "SessionAttendanceChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionAttendanceChange" ADD CONSTRAINT "SessionAttendanceChange_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionAttendanceChange" ADD CONSTRAINT "SessionAttendanceChange_voidedPaymentId_fkey" FOREIGN KEY ("voidedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. session.close — core loop, so backfilled onto every existing centre ──
-- Matches DEFAULT_ROLE_GRANTS (lib/auth/permissions.ts): OWNER, MANAGER and
-- RECEPTIONIST may end a session by default. Unlike M14's money actions this
-- one IS backfilled: without it no existing centre could close a session at
-- all, and the auto-close at end of day would be the only way one ever ends.
-- ON CONFLICT keeps a centre's own explicit row (e.g. one already set false).
INSERT INTO "PermissionGrant" ("id", "centerId", "role", "action", "allowed", "createdAt", "updatedAt")
SELECT gen_random_uuid(), c."id", r."role"::"Role", 'session.close', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Center" c
CROSS JOIN (VALUES ('OWNER'), ('MANAGER'), ('RECEPTIONIST')) AS r("role")
ON CONFLICT ("centerId", "role", "action") DO NOTHING;
