-- Audit append guard (schema v8). Migration 007's unique indexes stop a second entry at an occupied position and a
-- fork (two successors of one predecessor). They do not stop a writer that bypasses the application from inserting at
-- a gap (head + 10) or a new root after the original root was pruned; either would leave the tenant's chain
-- permanently unverifiable. This trigger makes the database itself accept an audit event only at the exact next
-- position, linked to the exact predecessor hash (or the retention anchor when the chain is empty).
--
-- The function runs with the inserting role's rights (SECURITY INVOKER) and therefore under the same tenant
-- row-level security as the INSERT itself. It is owned by the migration owner; the runtime role has no TRIGGER
-- privilege (verified at start-up), so it cannot drop or replace it. Hash correctness stays the verifier's job.
CREATE FUNCTION public.audit_events_append_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head_seq bigint;
  head_hash text;
BEGIN
  SELECT e.chain_seq, e.entry_hash INTO head_seq, head_hash
    FROM public.audit_events e
    WHERE e.tenant_id = NEW.tenant_id
    ORDER BY e.chain_seq DESC
    LIMIT 1;
  IF NOT FOUND THEN
    SELECT a.last_pruned_seq, a.previous_hash INTO head_seq, head_hash
      FROM public.audit_retention_anchors a
      WHERE a.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      head_seq := 0;
      head_hash := NULL;
    END IF;
  END IF;
  IF NEW.chain_seq IS DISTINCT FROM head_seq + 1 OR NEW.previous_hash IS DISTINCT FROM head_hash THEN
    RAISE EXCEPTION 'audit event is not the next chain entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_append_guard
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_guard();

-- Migration 007 used CREATE UNIQUE INDEX IF NOT EXISTS: a pre-existing relation with the same name would have been
-- kept silently. Assert that both guard indexes exist exactly as designed, or fail (and roll back) this migration.
DO $$
DECLARE
  t oid := 'public.audit_events'::regclass;
  tenant_col int2 := (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'tenant_id');
  seq_col int2 := (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'chain_seq');
  prev_col int2 := (SELECT attnum FROM pg_attribute WHERE attrelid = t AND attname = 'previous_hash');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = t AND c.relname = 'audit_events_tenant_chain_seq_uniq'
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnatts = 2 AND i.indkey[0] = tenant_col AND i.indkey[1] = seq_col
  ) THEN
    RAISE EXCEPTION 'audit chain position index is missing or altered';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = t AND c.relname = 'audit_events_tenant_previous_hash_uniq'
      AND i.indisunique AND i.indisvalid AND i.indnullsnotdistinct AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnatts = 2 AND i.indkey[0] = tenant_col AND i.indkey[1] = prev_col
  ) THEN
    RAISE EXCEPTION 'audit chain predecessor index is missing or altered';
  END IF;
END;
$$;
