BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  tenant_id uuid PRIMARY KEY,
  organization_hash text NOT NULL UNIQUE CHECK (organization_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_key_hash text NOT NULL CHECK (event_key_hash ~ '^[a-f0-9]{64}$'),
  organization_hash text NOT NULL CHECK (organization_hash ~ '^[a-f0-9]{64}$'),
  resource_id_ciphertext text NOT NULL,
  resource_id_nonce text NOT NULL,
  resource_id_auth_tag text NOT NULL,
  resource_id_key_id text NOT NULL CHECK (char_length(resource_id_key_id) BETWEEN 1 AND 64),
  event_type text NOT NULL CHECK (event_type = 'voucher.created'),
  received_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  source text NOT NULL CHECK (source = 'lexware-webhook'),
  quality text NOT NULL CHECK (quality IN ('STRUCTURED','DERIVED','UNVERIFIED','PLACEHOLDER','CONFLICT','MISSING')),
  request_budget_status text NOT NULL CHECK (request_budget_status IN ('OK','DEGRADED','EXHAUSTED')),
  PRIMARY KEY (tenant_id, event_key_hash)
);

CREATE TABLE audit_events (
  audit_id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_hash text NOT NULL CHECK (actor_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('SCHEMA_MIGRATION','RESTORE','RETENTION_DELETE','TENANT_CREATE','TENANT_DELETE','TENANT_MISMATCH','INTEGRITY_FAILURE')),
  result text NOT NULL CHECK (result IN ('SUCCESS','DENIED','FAILED')),
  count integer NOT NULL CHECK (count >= 0),
  previous_hash text CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[a-f0-9]{64}$')
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_events_tenant_isolation ON webhook_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
