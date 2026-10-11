-- Additive ceiling: align an existing v5 per-tenant policy with the maximum
-- audit history that the v1 verifier can fully check. Do not rewrite migration
-- 005 (its checksum may already be recorded).
-- Existing tenants configured for more than 100000 audit entries cause this
-- migration to fail atomically; manual, separately approved remediation is
-- required. No tenant data, historical audit events, or retention anchors
-- are modified by this migration.
ALTER TABLE tenants
  ADD CONSTRAINT tenant_audit_integrity_ceiling
  CHECK (max_audit_events <= 100000);
