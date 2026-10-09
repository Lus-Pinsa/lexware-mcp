import { type PersistenceDatabase, getTenantBinding, withTenantTransaction } from "./repository.js";
import type { EnabledPersistenceRuntimeConfig } from "./runtime-config.js";
import { assertTenantCapabilityBoundary, type EffectiveWriteCapabilities } from "./tenant-capabilities.js";
import { PersistenceValidationError } from "./types.js";

export async function verifyConfiguredTenantBinding(
  config: EnabledPersistenceRuntimeConfig,
  db: PersistenceDatabase,
  effectiveCapabilities: EffectiveWriteCapabilities,
): Promise<void> {
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
