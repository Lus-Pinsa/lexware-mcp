-- LU'S persistence foundation v1
-- Forward-only migration. No production data is embedded in this file.
-- Runtime queries must also bind tenant_id explicitly; RLS is the second line of defense.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version bigint PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id uuid PRIMARY KEY,
  organization_id_hash char(64) NOT NULL UNIQUE
    CHECK (organization_id_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tenants ON tenants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS webhook_events (
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_key_hash char(64) NOT NULL
    CHECK (event_key_hash ~ '^[0-9a-f]{64}$'),
  event_type text NOT NULL CHECK (event_type = 'voucher.created'),
  resource_ciphertext bytea NOT NULL
    CHECK (octet_length(resource_ciphertext) BETWEEN 1 AND 512),
  resource_nonce bytea NOT NULL CHECK (octet_length(resource_nonce) = 12),
  resource_auth_tag bytea NOT NULL CHECK (octet_length(resource_auth_tag) = 16),
  key_id text NOT NULL
    CHECK (char_length(key_id) BETWEEN 1 AND 64 AND key_id ~ '^[A-Za-z0-9._-]+$'),
  received_at timestamptz NOT NULL,
  acknowledged_at timestamptz NULL,
  payload_checksum char(64) NOT NULL
    CHECK (payload_checksum ~ '^[0-9a-f]{64}$'),
  source text NOT NULL DEFAULT 'lexware_webhook'
    CHECK (source = 'lexware_webhook'),
  request_budget_status text NOT NULL DEFAULT 'NOT_APPLICABLE'
    CHECK (request_budget_status IN ('NOT_APPLICABLE', 'WITHIN_BUDGET', 'BUDGET_EXHAUSTED', 'UNKNOWN')),
  quality_status text NOT NULL DEFAULT 'STRUCTURED'
    CHECK (quality_status IN ('STRUCTURED', 'DERIVED', 'UNVERIFIED', 'PLACEHOLDER', 'CONFLICT', 'MISSING')),
  PRIMARY KEY (tenant_id, event_key_hash)
);

CREATE INDEX IF NOT EXISTS webhook_events_pending_idx
  ON webhook_events (tenant_id, received_at)
  WHERE acknowledged_at IS NULL;

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_webhook_events ON webhook_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  actor_hash char(64) NOT NULL CHECK (actor_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL
    CHECK (char_length(action) BETWEEN 1 AND 64 AND action ~ '^[a-z0-9_.-]+$'),
  result text NOT NULL
    CHECK (char_length(result) BETWEEN 1 AND 32 AND result ~ '^[A-Z0-9_]+$'),
  item_count integer NOT NULL CHECK (item_count >= 0),
  created_at timestamptz NOT NULL,
  previous_hash char(64) NULL CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$'),
  entry_hash char(64) NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS audit_events_chain_idx
  ON audit_events (tenant_id, created_at, audit_id);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_audit_events ON audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Runtime credentials are granted INSERT/SELECT only in deployment provisioning (P-30/P-31).
-- Keep PUBLIC from receiving mutation rights by accident; the migration/maintenance role
-- retains the ability to perform approved retention and tenant deletion.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;
