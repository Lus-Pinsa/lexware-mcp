import type { PersistenceDatabase } from "./repository.js";
import { getTenantBinding, withTenantTransaction } from "./repository.js";
import type { PersistenceRuntimeConfig } from "./runtime-config.js";

export type TenantBindingVerification =
  | { readonly state: "DISABLED" }
  | { readonly state: "AVAILABLE" }
  | {
      readonly state: "UNAVAILABLE" | "BINDING_MISMATCH" | "TENANT_DISABLED";
      readonly reason: string;
    };

export async function verifyPersistenceTenantBinding(
  config: PersistenceRuntimeConfig,
  db: PersistenceDatabase,
): Promise<TenantBindingVerification> {
  if (!config.enabled) return Object.freeze({ state: "DISABLED" });

  const binding = await withTenantTransaction(config.tenantId, db, (tx) =>
    getTenantBinding(config.tenantId, tx),
  );

  if (binding === null) {
    return Object.freeze({
      state: "UNAVAILABLE",
      reason: "Configured persistence tenant does not exist.",
    });
  }
  if (binding.status !== "active") {
    return Object.freeze({
      state: "TENANT_DISABLED",
      reason: "Configured persistence tenant is disabled.",
    });
  }
  if (binding.organizationIdHash !== config.organizationIdHash) {
    return Object.freeze({
      state: "BINDING_MISMATCH",
      reason: "Configured Lexware organization does not match the persistence tenant.",
    });
  }

  return Object.freeze({ state: "AVAILABLE" });
}
