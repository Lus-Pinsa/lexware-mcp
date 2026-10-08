export type TenantId = string & { readonly __tenantIdBrand: unique symbol };

export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TENANT_ID_PATTERN = UUID_V4_PATTERN;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const QUALITY_STATUSES = [
  "STRUCTURED",
  "DERIVED",
  "UNVERIFIED",
  "PLACEHOLDER",
  "CONFLICT",
  "MISSING",
] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export const REQUEST_BUDGET_STATUSES = [
  "NOT_APPLICABLE",
  "WITHIN_BUDGET",
  "BUDGET_EXHAUSTED",
  "UNKNOWN",
] as const;
export type RequestBudgetStatus = (typeof REQUEST_BUDGET_STATUSES)[number];

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

export function assertUuidV4(value: string, field = "id"): string {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return value.toLowerCase();
}

export function parseTenantId(value: string): TenantId {
  return assertUuidV4(value, "tenant id") as TenantId;
}

export function assertSha256Hex(value: string, field = "hash"): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return value;
}

export function assertQualityStatus(value: string): QualityStatus {
  if (!(QUALITY_STATUSES as readonly string[]).includes(value)) {
    throw new PersistenceValidationError("Invalid quality status.");
  }
  return value as QualityStatus;
}

export function assertRequestBudgetStatus(value: string): RequestBudgetStatus {
  if (!(REQUEST_BUDGET_STATUSES as readonly string[]).includes(value)) {
    throw new PersistenceValidationError("Invalid request budget status.");
  }
  return value as RequestBudgetStatus;
}
