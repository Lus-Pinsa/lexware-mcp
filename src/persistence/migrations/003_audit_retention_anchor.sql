-- Retention anchor for append-only audit verification after policy-driven pruning.
-- Runtime role may SELECT this table but must not mutate it.

CREATE TABLE IF NOT EXISTS audit_retention_anchors (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  previous_hash char(64) NOT NULL
    CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL
);

ALTER TABLE audit_retention_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_retention_anchors FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_retention_anchors ON audit_retention_anchors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_retention_anchors FROM PUBLIC;
