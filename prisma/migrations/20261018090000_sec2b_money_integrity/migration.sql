-- SEC-2b: money integrity, concurrency, anti-fraud (docs/07-security-audit.md;
-- decisions D-05, D-07, D-14, D-16, D-20, D-24 in its §6).
--
-- 1. Payment: at most ONE non-voided payment per roster row, enforced by the
--    database (partial unique index) — the app's row-locked check alone was
--    raced by two desks (SEC-05). A CHECK keeps void and refund exclusive on a
--    row (SEC-12). Existing data was checked first: 0 duplicates, 0 rows both
--    voided and refunded.
-- 2. SettlementClaim — a settlement claims each payment's teacher share; a
--    payment belongs to at most one live (not released) claim (D-05 (c),
--    SEC-06, closes OD-8). Existing settlements are backfilled with the
--    payments their totals counted (0 payments were counted twice).
-- 3. Settlement: CANCELLED (a DRAFT only), with who/when (D-16).
-- 4. Session.timezone — the centre's timezone frozen at creation (D-14,
--    SEC-21): filled on insert by a trigger, never changed afterwards.
-- 5. Expense: voided, never deleted (D-24).
-- 6. AuditLog is append-only (SEC-60): no UPDATE except the foreign keys'
--    own ON DELETE SET NULL, no DELETE outside an explicit maintenance
--    transaction. Existing rows are kept as they are (D-20).
--
-- Like the SEC-2a lockdown, written to run on plain Postgres too.

-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voided" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedBy" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT;

-- CreateTable
CREATE TABLE "SettlementClaim" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "teacherShare" INTEGER NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementClaim_centerId_idx" ON "SettlementClaim"("centerId");

-- CreateIndex
CREATE INDEX "SettlementClaim_settlementId_idx" ON "SettlementClaim"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementClaim_paymentId_idx" ON "SettlementClaim"("paymentId");

-- AddForeignKey
ALTER TABLE "SettlementClaim" ADD CONSTRAINT "SettlementClaim_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementClaim" ADD CONSTRAINT "SettlementClaim_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementClaim" ADD CONSTRAINT "SettlementClaim_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New tables carry RLS from birth (SEC-2a lockdown rule; check:rls asserts it).
ALTER TABLE "SettlementClaim" ENABLE ROW LEVEL SECURITY;

-- ── 1. Payment invariants ──────────────────────────────────────────────────

CREATE UNIQUE INDEX "Payment_one_active_per_attendee"
  ON "Payment"("sessionAttendeeId") WHERE "voided" = false;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_not_voided_and_refunded"
  CHECK (NOT ("voided" AND "refunded"));

-- ── 2. One live claim per payment, and the backfill ───────────────────────

CREATE UNIQUE INDEX "SettlementClaim_one_live_per_payment"
  ON "SettlementClaim"("paymentId") WHERE "releasedAt" IS NULL;

-- Every existing settlement claims exactly the payments its stored total
-- counted under the pre-SEC-2b rule (lib/db/settlements.ts at d786273): its
-- session, or its teacher's sessions in its period; not voided, not refunded;
-- recorded before the settlement; and — for an R2 settlement — on a session
-- already closed when it was created. Earliest settlement first, so the
-- (nonexistent today) double-counted payment would stay with the first.
INSERT INTO "SettlementClaim" ("id", "centerId", "settlementId", "paymentId", "teacherShare", "createdAt")
SELECT gen_random_uuid()::text, st."centerId", st."id", p."id", p."teacherShareSnapshot", st."createdAt"
FROM "Settlement" st
JOIN "Payment" p ON p."centerId" = st."centerId" AND p."teacherId" = st."teacherId"
JOIN "Session" s ON s."id" = p."sessionId"
WHERE NOT p."voided" AND NOT p."refunded"
  AND p."recordedAt" <= st."createdAt"
  AND (st."sessionId" = p."sessionId"
       OR (st."periodFrom" IS NOT NULL AND st."periodFrom" <= s."date" AND st."periodTo" >= s."date"))
  AND (NOT st."closedSessionsOnly" OR (s."closedAt" IS NOT NULL AND s."closedAt" <= st."createdAt"))
ORDER BY st."createdAt" ASC
ON CONFLICT ("paymentId") WHERE "releasedAt" IS NULL DO NOTHING;

-- ── 4. A session's timezone is frozen at creation ─────────────────────────

UPDATE "Session" s
SET "timezone" = COALESCE(
  (SELECT cs."timezone" FROM "CenterSettings" cs WHERE cs."centerId" = s."centerId"),
  'Africa/Cairo'
)
WHERE s."timezone" IS NULL;

CREATE FUNCTION public.kayedu_session_freeze_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."timezone" IS NULL THEN
      SELECT cs."timezone" INTO NEW."timezone"
      FROM "CenterSettings" cs WHERE cs."centerId" = NEW."centerId";
      NEW."timezone" := COALESCE(NEW."timezone", 'Africa/Cairo');
    END IF;
  ELSE
    -- A session's timezone never changes after creation (D-14).
    NEW."timezone" := OLD."timezone";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Session_freeze_timezone"
  BEFORE INSERT OR UPDATE ON "Session"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_session_freeze_timezone();

-- ── 6. AuditLog is append-only ─────────────────────────────────────────────

CREATE FUNCTION public.kayedu_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Test cleanup only (scripts/lib/audit-maintenance.ts), inside one
    -- transaction that opts in explicitly. Nothing in the app deletes audit.
    IF current_setting('kayedu.audit_maintenance', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'AuditLog is append-only: DELETE refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The only UPDATE allowed is a foreign key's ON DELETE SET NULL: centerId
  -- and/or actorUserId going to NULL, every other column unchanged.
  IF NEW."id" IS NOT DISTINCT FROM OLD."id"
     AND NEW."action" IS NOT DISTINCT FROM OLD."action"
     AND NEW."entityType" IS NOT DISTINCT FROM OLD."entityType"
     AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId"
     AND NEW."before"::text IS NOT DISTINCT FROM OLD."before"::text
     AND NEW."after"::text IS NOT DISTINCT FROM OLD."after"::text
     AND NEW."createdAt" IS NOT DISTINCT FROM OLD."createdAt"
     AND (NEW."centerId" IS NOT DISTINCT FROM OLD."centerId" OR NEW."centerId" IS NULL)
     AND (NEW."actorUserId" IS NOT DISTINCT FROM OLD."actorUserId" OR NEW."actorUserId" IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: UPDATE refused' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_audit_log_append_only();

-- The two trigger functions are executable by nobody but their owner (the
-- SEC-2a default privileges already say so; this keeps it explicit).
DO $$
DECLARE
  api_role text;
BEGIN
  REVOKE ALL ON FUNCTION public.kayedu_session_freeze_timezone() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.kayedu_audit_log_append_only() FROM PUBLIC;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_session_freeze_timezone() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_audit_log_append_only() FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
