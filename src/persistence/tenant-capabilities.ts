import { PersistenceValidationError } from "./types.js";

export type TenantCapabilityTier = "read_only" | "drafts" | "finalize";

export interface EffectiveWriteCapabilities {
  readonly drafts: boolean;
  readonly finalize: boolean;
}

export function assertTenantCapabilityTier(value: string): TenantCapabilityTier {
  if (value !== "read_only" && value !== "drafts" && value !== "finalize") {
    throw new PersistenceValidationError("Invalid tenant capability tier.");
  }
  return value;
}

/**
 * The persisted tenant tier is a ceiling, never an enable switch.
 * Runtime configuration may always be more restrictive than the tenant policy.
 */
export function assertTenantCapabilityBoundary(
  tenantTierInput: string,
  effective: EffectiveWriteCapabilities,
): void {
  const tenantTier = assertTenantCapabilityTier(tenantTierInput);

  if (effective.finalize && tenantTier !== "finalize") {
    throw new PersistenceValidationError(
      "Runtime finalize capability exceeds tenant policy.",
    );
  }

  if (
    effective.drafts &&
    tenantTier === "read_only"
  ) {
    throw new PersistenceValidationError(
      "Runtime draft capability exceeds tenant policy.",
    );
  }

  if (effective.finalize && !effective.drafts) {
    throw new PersistenceValidationError(
      "Invalid runtime capability combination.",
    );
  }
}
