-- Explicit per-tenant storage ceilings. They are safety limits, not quotas for
-- billing. Snapshot persistence is intentionally absent in v1 (effective max 0).

ALTER TABLE tenants
  ADD COLUMN max_webhook_events integer NOT NULL DEFAULT 10000
    CHECK (max_webhook_events BETWEEN 1 AND 100000),
  ADD COLUMN max_audit_events integer NOT NULL DEFAULT 100000
    CHECK (max_audit_events BETWEEN 1 AND 1000000),
  ADD COLUMN max_persistence_bytes bigint NOT NULL DEFAULT 67108864
    CHECK (max_persistence_bytes BETWEEN 1048576 AND 1073741824);

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_resource_ciphertext_size
  CHECK (octet_length(resource_ciphertext) BETWEEN 1 AND 512);
