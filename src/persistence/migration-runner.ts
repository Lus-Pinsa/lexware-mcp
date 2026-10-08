import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type MigrationDatabase,
  type MigrationDefinition,
  type MigrationRecord,
} from "./migration-types.js";
import { PersistenceVersionError, assertMigrationVersion } from "./schema.js";
import { PersistenceValidationError, assertSha256Hex } from "./types.js";

const MIGRATION_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (" +
  "version bigint PRIMARY KEY," +
  "name text NOT NULL," +
  "applied_at timestamptz NOT NULL DEFAULT now()," +
  "checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$')" +
  ")";

const SQL_LIST_MIGRATIONS =
  "SELECT version::int AS version, name, checksum FROM schema_migrations ORDER BY version ASC";
const SQL_INSERT_MIGRATION =
  "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)";

const DESTRUCTIVE_SQL = /\b(?:DROP\s+(?:TABLE|SCHEMA|COLUMN)|TRUNCATE\b|ALTER\s+TABLE[\s\S]{0,200}\bDROP\b)\b/i;

function migrationPath(file: string): string {
  return fileURLToPath(new URL("./migrations/" + file, import.meta.url));
}

function loadMigration(version: number, name: string, file: string): MigrationDefinition {
  const sql = readFileSync(migrationPath(file), "utf8");
  if (sql.length < 1 || sql.length > 1024 * 1024) {
    throw new PersistenceValidationError("Invalid migration file size.");
  }
  if (DESTRUCTIVE_SQL.test(sql)) {
    throw new PersistenceValidationError("Destructive migration requires a separate approved path.");
  }
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  return Object.freeze({
    version: assertMigrationVersion(version),
    name,
    sql,
    checksum: assertSha256Hex(checksum, "migration checksum"),
  });
}

export function loadKnownMigrations(): readonly MigrationDefinition[] {
  return Object.freeze([
    loadMigration(1, "foundation", "001_foundation.sql"),
  ]);
}

function validateApplied(
  applied: readonly MigrationRecord[],
  known: readonly MigrationDefinition[],
): void {
  let expectedVersion = 1;
  for (const row of applied) {
    const version = assertMigrationVersion(row.version);
    if (version !== expectedVersion) {
      throw new PersistenceVersionError("Persistence migration history has a gap or unexpected version.");
    }
    const definition = known.find((item) => item.version === version);
    if (definition === undefined) {
      throw new PersistenceVersionError("Persistence database schema is newer or unknown.");
    }
    if (row.name !== definition.name) {
      throw new PersistenceVersionError("Persistence migration name mismatch.");
    }
    if (assertSha256Hex(row.checksum, "applied migration checksum") !== definition.checksum) {
      throw new PersistenceVersionError("Persistence migration checksum mismatch.");
    }
    expectedVersion += 1;
  }
}

export async function inspectMigrationState(
  db: MigrationDatabase,
): Promise<{
  readonly applied: readonly MigrationRecord[];
  readonly pending: readonly MigrationDefinition[];
}> {
  const known = loadKnownMigrations();

  await db.transaction(async (tx) => {
    await tx.executeStatic(MIGRATION_TABLE_SQL);
  });

  const applied = await db.transaction(async (tx) => {
    const result = await tx.query<{
      version: number;
      name: string;
      checksum: string;
    }>({ text: SQL_LIST_MIGRATIONS, values: [] });
    return result.rows.map((row) =>
      Object.freeze({
        version: assertMigrationVersion(row.version),
        name: row.name,
        checksum: assertSha256Hex(row.checksum, "applied migration checksum"),
      }),
    );
  });

  validateApplied(applied, known);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = known.filter((item) => !appliedVersions.has(item.version));
  return Object.freeze({ applied: Object.freeze(applied), pending: Object.freeze(pending) });
}

export async function applyPendingMigrations(
  db: MigrationDatabase,
): Promise<{ readonly appliedVersions: readonly number[] }> {
  const state = await inspectMigrationState(db);
  const appliedVersions: number[] = [];

  for (const migration of state.pending) {
    await db.transaction(async (tx) => {
      await tx.executeStatic(migration.sql);
      const recorded = await tx.query({
        text: SQL_INSERT_MIGRATION,
        values: [migration.version, migration.name, migration.checksum],
      });
      if (recorded.rowCount !== 1) {
        throw new PersistenceVersionError("Persistence migration ledger write failed.");
      }
    });
    appliedVersions.push(migration.version);
  }

  return Object.freeze({ appliedVersions: Object.freeze(appliedVersions) });
}
