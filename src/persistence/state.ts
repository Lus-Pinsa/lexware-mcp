export type PersistenceUnavailableReason =
  | "DISABLED"
  | "CONFIG_INVALID"
  | "DATABASE_UNREACHABLE"
  | "SCHEMA_UNSUPPORTED"
  | "INTEGRITY_FAILURE"
  | "TENANT_BINDING_MISMATCH"
  | "KEY_UNAVAILABLE";

export type PersistenceState =
  | { status: "AVAILABLE"; checkedAt: string }
  | { status: "UNAVAILABLE"; checkedAt: string; reason: PersistenceUnavailableReason };

/**
 * Persistence unavailability is explicit state, never an empty-data fallback.
 */
export function requirePersistenceAvailable(state: PersistenceState): void {
  if (state.status !== "AVAILABLE") {
    throw new Error(`Persistence unavailable: ${state.reason}`);
  }
}
