-- Audit append ordinal (schema v7). The chain order of a tenant's audit events is the serialized append order,
-- recorded as a gap-free per-tenant ordinal (chain_seq). Neither the caller-supplied event time (created_at, which
-- may repeat or run backwards) nor the UUID determines the order any more. Design: ai-company/persistence/audit-order-v7-adr.md.
--
-- Legacy history: existing rows have no authoritative append ordinal, and their order cannot be reconstructed from
-- time or UUID without guessing. Persistence has never been enabled in production. If any audit event or retention
-- anchor already exists, the NOT NULL columns below fail and the whole migration rolls back without changing data;
-- remediation is a separate, owner-approved decision. Requires PostgreSQL 15+ (NULLS NOT DISTINCT).
ALTER TABLE audit_events
  ADD COLUMN chain_seq bigint NOT NULL CHECK (chain_seq >= 1),
  ADD COLUMN chain_version smallint NOT NULL CHECK (chain_version = 2);

-- No two entries of a tenant at the same position.
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_tenant_chain_seq_uniq
  ON audit_events (tenant_id, chain_seq);

-- One successor per predecessor: a second entry pointing at the same hash (a fork) is rejected by the database,
-- including a second chain root (previous_hash NULL).
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_tenant_previous_hash_uniq
  ON audit_events (tenant_id, previous_hash) NULLS NOT DISTINCT;

-- The anchor remembers the position of the last pruned entry, so the first retained entry is checked by
-- position as well as by hash.
ALTER TABLE audit_retention_anchors
  ADD COLUMN last_pruned_seq bigint NOT NULL CHECK (last_pruned_seq >= 1);
