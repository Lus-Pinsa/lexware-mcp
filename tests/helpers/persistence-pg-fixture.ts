/**
 * Real-PostgreSQL fixture for persistence integration tests (synthetic data only).
 *
 * Roles (all NOLOGIN-free, trust auth on loopback, cluster destroyed after the run):
 * - `lus_owner`   database/schema owner; runs migrations and operator/maintenance paths
 * - `lus_runtime` least-privilege runtime role, provisioned exactly as the runtime check expects
 */
import { randomUUID } from "node:crypto";
import { applyPendingMigrations } from "../../src/persistence/migration-runner.js";
import { bootstrapTenant } from "../../src/persistence/operator-repository.js";
import {
  createPostgresDatabase,
  createPostgresMigrationDatabase,
  type ManagedMigrationDatabase,
  type ManagedPersistenceDatabase,
} from "../../src/persistence/postgres-driver.js";
import { type TenantId, parseTenantId } from "../../src/persistence/types.js";
import { type EphemeralPostgres, startEphemeralPostgres } from "./ephemeral-postgres.js";

export const ACTOR = "a".repeat(64);
export const ORG_A = "1".repeat(64);
export const ORG_B = "2".repeat(64);

/** Grants of a correctly provisioned runtime role (deployment provisioning, P-30/P-31). */
export const RUNTIME_GRANTS = [
  "GRANT USAGE ON SCHEMA public TO lus_runtime",
  "GRANT SELECT ON schema_migrations, tenants, audit_retention_anchors TO lus_runtime",
  "GRANT SELECT, INSERT, UPDATE ON webhook_events TO lus_runtime",
  "GRANT SELECT, INSERT ON audit_events TO lus_runtime",
];

export interface PgFixture {
  readonly pg: EphemeralPostgres;
  readonly database: string;
  readonly tenantA: TenantId;
  readonly tenantB: TenantId;
  owner(): ManagedMigrationDatabase;
  runtime(role?: string): ManagedPersistenceDatabase;
  /** Maintenance/retention connection: the table owner (RLS is FORCE-enabled, so it is still tenant-bound). */
  runtimeMaintenance(): ManagedPersistenceDatabase;
  /** Superuser SQL inside the test database (setup/tamper steps only). */
  admin(sql: string): Promise<void>;
  close(): Promise<void>;
}

let counter = 0;

export async function createPgFixture(pg: EphemeralPostgres, opts: { migrate?: boolean; tenants?: boolean } = {}): Promise<PgFixture> {
  const database = `lus_it_${process.pid}_${counter++}`;
  await pg.createDatabase(database);
  await pg.admin(
    "postgres",
    "DO $$ BEGIN " +
      "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lus_owner') THEN CREATE ROLE lus_owner LOGIN; END IF; " +
      "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lus_runtime') THEN CREATE ROLE lus_runtime LOGIN; END IF; " +
      "END $$;",
  );
  await pg.admin("postgres", `ALTER DATABASE ${database} OWNER TO lus_owner`);
  await pg.admin(database, "ALTER SCHEMA public OWNER TO lus_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC;");

  const opened: Array<{ close(): Promise<void> }> = [];
  const owner = () => {
    const db = createPostgresMigrationDatabase({ connectionString: pg.url(database, "lus_owner"), tlsMode: "require", maxConnections: 2 });
    opened.push(db);
    return db;
  };
  const runtime = (role = "lus_runtime") => {
    const db = createPostgresDatabase({ connectionString: pg.url(database, role), tlsMode: "require", maxConnections: 4 });
    opened.push(db);
    return db;
  };

  const tenantA = parseTenantId(randomUUID());
  const tenantB = parseTenantId(randomUUID());

  if (opts.migrate !== false) {
    await applyPendingMigrations(owner());
    // Grants are applied as the table owner, exactly like deployment provisioning would.
    const ownerSql = createPostgresMigrationDatabase({ connectionString: pg.url(database, "lus_owner"), tlsMode: "require", maxConnections: 1 });
    opened.push(ownerSql);
    await ownerSql.transaction(async (tx) => {
      for (const grant of RUNTIME_GRANTS) await tx.executeStatic(grant);
    });
    if (opts.tenants !== false) {
      for (const [tenantId, org] of [[tenantA, ORG_A], [tenantB, ORG_B]] as const) {
        await bootstrapTenant(owner(), { tenantId, organizationIdHash: org, auditId: randomUUID(), actorHash: ACTOR, createdAt: "2026-01-01T00:00:00.000Z" });
      }
    }
  }

  return {
    pg,
    database,
    tenantA,
    tenantB,
    owner,
    runtime,
    runtimeMaintenance: () => runtime("lus_owner"),
    admin: (sql) => pg.admin(database, sql),
    async close() {
      for (const db of opened.splice(0)) await db.close().catch(() => undefined);
    },
  };
}

export async function maybeStartPostgres(): Promise<EphemeralPostgres | null> {
  const pg = await startEphemeralPostgres();
  if (pg === null) {
    // Visible skip: the suite reports its tests as skipped; CI without PostgreSQL is not a pass.
    console.warn("[persistence-pg] PostgreSQL server binaries not found — real-PostgreSQL integration tests SKIPPED.");
  }
  return pg;
}
