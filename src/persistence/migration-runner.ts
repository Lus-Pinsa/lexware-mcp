import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type MigrationDatabase,
  type MigrationDefinition,
  type MigrationRecord,
  type StaticMigrationExecutor,
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

const LOCK_MIGRATION_TABLE_SQL = "LOCK TABLE schema_migrations IN EXCLUSIVE MODE";
const SQL_LIST_MIGRATIONS =
  "SELECT version::int AS version, name, checksum FROM schema_migrations ORDER BY version ASC";
const SQL_INSERT_MIGRATION =
  "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)";

const DESTRUCTIVE_STATEMENT =
  /(?:^|;)\s*(?:DROP\s+(?:TABLE|SCHEMA)\b|TRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"])/i;
const DESTRUCTIVE_ALTER =
  /\bALTER\s+TABLE\b[^;]{0,500}\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function assertSafeMigrationSql(sql: string): string {
  if (sql.length < 1 || sql.length > 1024 * 1024) {
    throw new PersistenceValidationError("Invalid migration file size.");
  }
  const scanned = stripSqlComments(sql);
  if (DESTRUCTIVE_STATEMENT.test(scanned) || DESTRUCTIVE_ALTER.test(scanned)) {
    throw new PersistenceValidationError("Destructive migration requires a separate approved path.");
  }
  return sql;
}

function migrationPath(file: string): string {
  return fileURLToPath(new URL("./migrations/" + file, import.meta.url));
}

function loadMigration(version: number, name: string, file: string): MigrationDefinition {
  const sql = assertSafeMigrationSql(readFileSync(migrationPath(file), "utf8"));
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
    loadMigration(2, "webhook_event_date", "002_webhook_event_date.sql"),
    loadMigration(3, "audit_retention_anchor", "003_audit_retention_anchor.sql"),
  ]);
}

export function validateAppliedMigrations(
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

async function listApplied(tx: StaticMigrationExecutor): Promise<readonly MigrationRecord[]> {
  const result = await tx.query<{
    version: number;
    name: string;
    checksum: string;
  }>({ text: SQL_LIST_MIGRATIONS, values: [] });

  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        version: assertMigrationVersion(row.version),
        name: row.name,
        checksum: assertSha256Hex(row.checksum, "applied migration checksum"),
      }),
    ),
  );
}

async function ensureMigrationLedger(db: MigrationDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.executeStatic(MIGRATION_TABLE_SQL);
  });
}

export function assertMigrationStateCurrent(
  applied: readonly MigrationRecord[],
): void {
  const known = loadKnownMigrations();
  validateAppliedMigrations(applied, known);
  if (applied.length !== known.length) {
    throw new PersistenceVersionError("Persistence database has pending migrations.");
  }
}

export async function inspectMigrationState(
  db: MigrationDatabase,
): Promise<{
  readonly applied: readonly MigrationRecord[];
  readonly pending: readonly MigrationDefinition[];
}> {
  const known = loadKnownMigrations();
  await ensureMigrationLedger(db);
  const applied = await db.transaction((tx) => listApplied(tx));

  validateAppliedMigrations(applied, known);
  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = known.filter((item) => !appliedVersions.has(item.version));
  return Object.freeze({ applied, pending: Object.freeze(pending) });
}

export async function applyPendingMigrations(
  db: MigrationDatabase,
): Promise<{ readonly appliedVersions: readonly number[] }> {
  const known = loadKnownMigrations();
  await ensureMigrationLedger(db);

  return db.transaction(async (tx) => {
    // Serialize migrators before reading the ledger. The lock and every migration
    // share this transaction, so a crash/failure rolls the whole batch back.
    await tx.executeStatic(LOCK_MIGRATION_TABLE_SQL);
    const applied = await listApplied(tx);
    validateAppliedMigrations(applied, known);

    const appliedVersions = new Set(applied.map((row) => row.version));
    const pending = known.filter((item) => !appliedVersions.has(item.version));
    const newlyApplied: number[] = [];

    for (const migration of pending) {
      await tx.executeStatic(migration.sql);
      const recorded = await tx.query({
        text: SQL_INSERT_MIGRATION,
        values: [migration.version, migration.name, migration.checksum],
      });
      if (recorded.rowCount !== 1) {
        throw new PersistenceVersionError("Persistence migration ledger write failed.");
      }
      newlyApplied.push(migration.version);
    }

    return Object.freeze({ appliedVersions: Object.freeze(newlyApplied) });
  });
}
