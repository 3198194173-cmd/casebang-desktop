DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'work_items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%origin_id%'
    AND pg_get_constraintdef(oid) LIKE '%assignee_id%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE work_items DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

COMMENT ON COLUMN work_items.assignee_id IS
  'Processing participant. May equal origin_id for single-account testing and self-managed workbooks.';
