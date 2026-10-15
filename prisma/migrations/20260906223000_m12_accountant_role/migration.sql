-- M12: add ACCOUNTANT to the Role enum (docs/00-master-product-spec.md §3).
--
-- Split into its own migration on purpose: Postgres will not let a statement
-- in the *same* transaction that added an enum value actually use that value
-- ("unsafe use of new value of enum type"), and every migration.sql here runs
-- as one transaction. The permission-matrix backfill that references
-- 'ACCOUNTANT' lives in the next migration, after this one has committed.
ALTER TYPE "Role" ADD VALUE 'ACCOUNTANT';
