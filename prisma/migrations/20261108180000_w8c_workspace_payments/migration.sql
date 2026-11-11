-- W8c — workspace check-in and payments (D-W24, D-W40). Hand-written, additive:
-- no table, column or index changes (prisma/schema.prisma is unchanged), so
-- there is nothing for `prisma migrate diff` to generate. Two parts:
--   1. the hidden "Cash" payment method for every existing PERSONAL workspace
--      that has no method at all (idempotent — a re-run inserts nothing);
--   2. two triggers: a PERSONAL centre can hold no `Settlement` and no
--      `SettlementClaim`, and no claim may name a PERSONAL centre's payment.

-- ── 1. Backfill: one hidden Cash method per workspace (D-W40 item 2) ────────
-- New workspaces get theirs from `createPersonalWorkspace`
-- (lib/db/platform.ts, `WORKSPACE_PAYMENT_METHOD_NAME`).

INSERT INTO "CenterPaymentMethod" ("id", "centerId", "name", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", 'Cash', true, now(), now()
FROM "Center" c
WHERE c."kind" = 'PERSONAL'
  AND NOT EXISTS (SELECT 1 FROM "CenterPaymentMethod" m WHERE m."centerId" = c."id");

-- ── 2. A PERSONAL workspace is never settled (D-W24, CLAUDE.md rule 15) ─────
-- The code refuses first (`workspaceNotSettled`, the BRANCH-only
-- `claimablePayments`); these make it true for every path, a hand-written
-- statement included. A CHECK cannot read another table, hence triggers (the
-- W8a precedent).

CREATE FUNCTION public.kayedu_settlement_branch_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Center" c WHERE c."id" = NEW."centerId" AND c."kind" = 'PERSONAL') THEN
    RAISE EXCEPTION 'A PERSONAL workspace holds no settlement (D-W24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Settlement_branch_only"
  BEFORE INSERT OR UPDATE OF "centerId" ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_settlement_branch_only();

CREATE FUNCTION public.kayedu_settlement_claim_branch_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Center" c WHERE c."id" = NEW."centerId" AND c."kind" = 'PERSONAL')
     OR EXISTS (
       SELECT 1 FROM "Payment" p JOIN "Center" c ON c."id" = p."centerId"
       WHERE p."id" = NEW."paymentId" AND c."kind" = 'PERSONAL'
     ) THEN
    RAISE EXCEPTION 'A PERSONAL workspace payment is never claimed by a settlement (D-W24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "SettlementClaim_branch_only"
  BEFORE INSERT OR UPDATE OF "centerId", "paymentId" ON "SettlementClaim"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_settlement_claim_branch_only();

-- The trigger functions are executable by nobody but their owner (as W8a's).
DO $$
DECLARE
  api_role text;
BEGIN
  REVOKE ALL ON FUNCTION public.kayedu_settlement_branch_only() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.kayedu_settlement_claim_branch_only() FROM PUBLIC;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_settlement_branch_only() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_settlement_claim_branch_only() FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
