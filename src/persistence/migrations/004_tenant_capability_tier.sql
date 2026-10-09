-- Per-tenant capability ceiling. The default is read-only and future
-- multi-tenant runtime configuration must never exceed this persisted policy.

ALTER TABLE tenants
  ADD COLUMN capability_tier text NOT NULL DEFAULT 'read_only'
  CHECK (capability_tier IN ('read_only', 'drafts', 'finalize'));
