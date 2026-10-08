import type { TenantId } from "./types.js";

export type PersistenceErrorClass =
  | "CONFIG_INVALID"
  | "CONNECTION_FAILED"
  | "VERSION_MISMATCH"
  | "INTEGRITY_FAILED"
  | "QUERY_FAILED"
  | "TRANSACTION_FAILED"
  | "CLOSE_FAILED"
  | "CRYPTO_FAILED"
  | "UNKNOWN";

export interface SafePersistenceLogEvent {
  readonly event: string;
  readonly tenantId: TenantId;
  readonly count: number;
  readonly errorClass?: PersistenceErrorClass;
}

export function redactPersistenceError(error: unknown): PersistenceErrorClass {
  if (!(error instanceof Error)) return "UNKNOWN";
  switch (error.name) {
    case "PersistenceValidationError":
      return "CONFIG_INVALID";
    case "PersistenceCryptoError":
      return "CRYPTO_FAILED";
    case "PersistenceVersionError":
      return "VERSION_MISMATCH";
    case "PersistenceDatabaseError": {
      const kind = (error as Error & { kind?: unknown }).kind;
      if (kind === "QUERY_FAILED" || kind === "TRANSACTION_FAILED" || kind === "CLOSE_FAILED") {
        return kind;
      }
      return "UNKNOWN";
    }
    default:
      return "UNKNOWN";
  }
}

export function buildSafePersistenceLogEvent(
  tenantId: TenantId,
  event: string,
  count: number,
  error?: unknown,
): SafePersistenceLogEvent {
  if (!/^[a-z0-9_.-]{1,64}$/.test(event)) {
    throw new Error("Invalid persistence log event.");
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid persistence log count.");
  }
  return Object.freeze({
    event,
    tenantId,
    count,
    ...(error === undefined ? {} : { errorClass: redactPersistenceError(error) }),
  });
}
