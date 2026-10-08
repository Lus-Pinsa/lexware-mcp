import { PersistenceValidationError, type PersistenceState } from "./types.js";

export const CURRENT_SCHEMA_VERSION = 2;

export class PersistenceVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceVersionError";
  }
}

export function assessSchemaVersion(version: number | null): PersistenceState {
  if (version === null) return "UNAVAILABLE";
  if (!Number.isSafeInteger(version) || version < 1) return "INTEGRITY_FAILED";
  if (version !== CURRENT_SCHEMA_VERSION) return "VERSION_MISMATCH";
  return "AVAILABLE";
}

export function requireKnownSchemaVersion(version: number | null): void {
  const state = assessSchemaVersion(version);
  if (state !== "AVAILABLE") {
    throw new PersistenceVersionError(`Persistence schema is not usable: ${state}.`);
  }
}

export function assertMigrationVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PersistenceValidationError("Invalid migration version.");
  }
  return version;
}
