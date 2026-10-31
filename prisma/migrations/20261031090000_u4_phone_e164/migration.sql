-- U4: every Egyptian mobile stored in one form — E.164 `+20XXXXXXXXXX`
-- (docs/01-data-model.md "Phone numbers", docs/03-build-order.md U4).
--
-- Structural part: none. `prisma migrate diff --from-url <dev> --to-schema-
-- datamodel prisma/schema.prisma --script` reported "This is an empty
-- migration." — the stored form changes, the columns do not.
--
-- Data part (hand-written). One DO block, so it is a single statement: any
-- RAISE rolls back everything, and nothing is half-converted.
--   1. Pre-check. Every non-null value, with spaces, dashes and one leading
--      `+` stripped, must be `01XXXXXXXXX` or `201XXXXXXXXX` (an E.164 value
--      passes too, so a re-run is a no-op). Anything else RAISEs, naming the
--      table, the column and the count. Before U4 the seed's teacher rows held
--      `012-7681-7691` / `+20 10 7325 3370` in Membership.phone (the seed
--      skipped the zod normalizer) — those strip cleanly and convert.
--   2. Collisions. Normalize first, then RAISE if two rows of a unique phone
--      column (only User.phone; no phone column is unique per centre) would
--      end up equal. The mapping is one-to-one, so this guards the case of a
--      value already in E.164 beside its old-form twin.
--   3. Convert: `+20` || the 10 digits left after dropping the leading 0 or 20.
--   4. Post-check: every non-null value matches ^\+201[0125][0-9]{8}$, or RAISE.
-- The patterns are lib/phone.ts's STORED_PHONE_PATTERN and
-- MIGRATABLE_PHONE_PATTERN; `npm run report:phones` runs the same test read-only.
DO $$
DECLARE
  col record;
  bad bigint;
  clashes bigint;
  strip constant text := 'regexp_replace(regexp_replace(%1$I, ''[[:space:]-]'', '''', ''g''), ''^\+'', '''')';
  migratable constant text := '^(0|20)1[0125][0-9]{8}$';
  stored constant text := '^\+201[0125][0-9]{8}$';
BEGIN
  CREATE TEMP TABLE u4_phone_columns (tbl text, colname text, is_unique boolean) ON COMMIT DROP;
  INSERT INTO u4_phone_columns VALUES
    ('User', 'phone', true),
    ('User', 'altPhone', false),
    ('User', 'contactPhone', false),
    ('Membership', 'phone', false),
    ('Membership', 'altPhone', false),
    ('StudentProfile', 'phone', false),
    ('StudentProfile', 'altPhone', false),
    ('StudentProfile', 'parentPhone', false),
    ('StudentProfile', 'parentAltPhone', false),
    ('FamilyInvitation', 'declaredParentPhone', false),
    ('ParentLink', 'matchedPhone', false);

  -- 1. Pre-check.
  FOR col IN SELECT * FROM u4_phone_columns LOOP
    EXECUTE format(
      'SELECT count(*) FROM %2$I WHERE %1$I IS NOT NULL AND ' || strip || ' !~ $1',
      col.colname, col.tbl)
      INTO bad USING migratable;
    IF bad > 0 THEN
      RAISE EXCEPTION 'U4 phone migration: %.% has % value(s) that are not an Egyptian mobile (010/011/012/015) — nothing was changed',
        col.tbl, col.colname, bad;
    END IF;
  END LOOP;

  -- 2. Collisions on the unique columns, after normalizing.
  FOR col IN SELECT * FROM u4_phone_columns WHERE is_unique LOOP
    EXECUTE format(
      'SELECT count(*) FROM (SELECT ''+20'' || regexp_replace(' || strip || ', ''^(0|20)'', '''') AS mapped
         FROM %2$I WHERE %1$I IS NOT NULL GROUP BY 1 HAVING count(*) > 1) AS dup',
      col.colname, col.tbl)
      INTO clashes;
    IF clashes > 0 THEN
      RAISE EXCEPTION 'U4 phone migration: %.% would hold % duplicated number(s) once normalized — nothing was changed',
        col.tbl, col.colname, clashes;
    END IF;
  END LOOP;

  -- 3. Convert.
  FOR col IN SELECT * FROM u4_phone_columns LOOP
    EXECUTE format(
      'UPDATE %2$I SET %1$I = ''+20'' || regexp_replace(' || strip || ', ''^(0|20)'', '''')
        WHERE %1$I IS NOT NULL AND %1$I !~ $1',
      col.colname, col.tbl)
      USING stored;
  END LOOP;

  -- 4. Post-check.
  FOR col IN SELECT * FROM u4_phone_columns LOOP
    EXECUTE format('SELECT count(*) FROM %2$I WHERE %1$I IS NOT NULL AND %1$I !~ $1', col.colname, col.tbl)
      INTO bad USING stored;
    IF bad > 0 THEN
      RAISE EXCEPTION 'U4 phone migration: %.% still has % value(s) not in E.164 after conversion — nothing was changed',
        col.tbl, col.colname, bad;
    END IF;
  END LOOP;
END $$;
