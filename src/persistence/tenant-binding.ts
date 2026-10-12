import { type PersistenceDatabase, getTenantBinding, listRuntimeTenantBindings, withTenantTransaction } from "./repository.js";
import type { EnabledPersistenceRuntimeConfig } from "./runtime-config.js";
import { assertTenantCapabilityBoundary, type EffectiveWriteCapabilities } from "./tenant-capabilities.js";
import { PersistenceValidationError } from "./types.js";

export async function verifyConfiguredTenantBinding(
  config: EnabledPersistenceRuntimeConfig,
  db: PersistenceDatabase,
  effectiveCapabilities: EffectiveWriteCapabilities,
): Promise<void> {
  // The database enforces the role-to-tenant binding (migration 010); start-up additionally requires the runtime role
  // to be bound to exactly the configured tenant, so a role provisioned for several tenants (where app.tenant_id
  // would again choose between them) or for none never serves traffic.
  const runtimeBindings = await db.transaction((tx) => listRuntimeTenantBindings(tx));
  if (runtimeBindings.length !== 1 || runtimeBindings[0] !== config.tenantId) {
    throw new PersistenceValidationError("Runtime database role is not bound to exactly the configured tenant.");
  }

  const binding = await withTenantTransaction(config.tenantId, db, (tx) =>
    getTenantBinding(config.tenantId, tx),
  );

  if (binding === null) {
    throw new PersistenceValidationError("Configured persistence tenant does not exist.");
  }
  if (binding.status !== "active") {
    throw new PersistenceValidationError("Configured persistence tenant is disabled.");
  }
  if (binding.organizationIdHash !== config.organizationIdHash) {
    throw new PersistenceValidationError("Configured persistence tenant organization mismatch.");
  }

  assertTenantCapabilityBoundary(binding.capabilityTier, effectiveCapabilities);
}
