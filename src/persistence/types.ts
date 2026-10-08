export type TenantId = string & { readonly __tenantIdBrand: unique symbol };

export const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type QualityStatus =
  | "STRUCTURED"
  | "DERIVED"
  | "UNVERIFIED"
  | "PLACEHOLDER"
  | "CONFLICT"
  | "MISSING";

export type RequestBudgetStatus =
  | "NOT_APPLICABLE"
  | "WITHIN_BUDGET"
  | "BUDGET_EXHAUSTED"
  | "UNKNOWN";

export type PersistenceState =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "VERSION_MISMATCH"
  | "INTEGRITY_FAILED"
  | "CONFIG_INVALID";

export interface EncryptedValue {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyId: string;
}

export class PersistenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceValidationError";
  }
}

export function parseTenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid tenant id.");
  }
  return value.toLowerCase() as TenantId;
}

export function assertSha256Hex(value: string, field = "hash"): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new PersistenceValidationError(`Invalid ${field}.`);
  }
  return value;
}
