import { createHash } from "node:crypto";

export interface MigrationDescriptor {
  version: number;
  file: string;
}

/**
 * Ordered, forward-only migration manifest. Adding or changing a migration
 * requires review; existing migration versions must never be silently reused.
 */
export const MIGRATIONS: readonly MigrationDescriptor[] = Object.freeze([
  { version: 1, file: "001_initial.sql" },
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Fail closed if the database is from a future application version or has an
 * invalid schema marker. Version 0 represents an empty database before the
 * first migration.
 */
export function assertSupportedSchemaVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("Invalid persistence schema version.");
  }
  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error("Persistence schema is newer than this application.");
  }
}
