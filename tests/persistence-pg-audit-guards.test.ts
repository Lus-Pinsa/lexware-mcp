/**
 * Database-level audit guards, migration v6 → v7 and capacity/retention edge cases on REAL PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import { applyPendingMigrations, loadKnownMigrations } from "../src/persistence/migration-runner.js";
import { createPostgresMigrationDatabase } from "../src/persistence/postgres-driver.js";
import { runTenantRetention } from "../src/persistence/retention.js";
import { appendAuditEvent, withTenantTransaction } from "../src/persistence/repository.js";
import { type TenantId, parseTenantId } from "../src/persistence/types.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, RUNTIME_GRANTS, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

describe.skipIf(!postgresAvailable())("audit guards on real PostgreSQL", () => {
  let pg: EphemeralPostgres;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  const append = (fx: PgFixture, tenant: TenantId, createdAt: string) =>
    withTenantTransaction(tenant, fx.runtime(), (tx) =>
      appendAuditEvent(tenant, tx, { auditId: randomUUID(), actorHash: ACTOR, action: "test.event", result: "SUCCESS", itemCount: 0, createdAt }),
    );
  const verify = (fx: PgFixture, tenant: TenantId) => withTenantTransaction(tenant, fx.runtime(), (tx) => verifyAuditChainIntegrity(tenant, tx));
  /**
   * Raw owner INSERT through a plain client (not the production driver, whose errors are deliberately opaque), so the
   * exact SQLSTATE and constraint can be asserted. Simulates a writer that bypasses the application.
   */
  const rawInsertError = async (fx: PgFixture, tenant: TenantId, seq: number, previous: string | null) => {
    const sql = postgres(pg.url(fx.database, "lus_owner"), { ssl: "require", max: 1, onnotice: () => undefined });
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        await tx.unsafe(
          "INSERT INTO audit_events (audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash, chain_seq, chain_version) VALUES ($1,$2,$3,'x','SUCCESS',0,'2026-05-02T00:00:00Z',$4,$5,$6,2)",
          [randomUUID(), tenant, ACTOR, previous, "e".repeat(64), seq],
        );
      });
      return null;
    } catch (error) {
      const e = error as { code?: string; constraint_name?: string; message?: string };
      return { code: e.code, constraint: e.constraint_name, message: e.message };
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  /** Owner-side raw SQL bound to a tenant (simulates a writer that bypasses the application). */
  const ownerSql = async (fx: PgFixture, tenant: TenantId, text: string, values: unknown[] = []) =>
    fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      return tx.query({ text, values });
    });

  it("the append guard (v8) rejects every insert that is not exactly the next entry, even outside the app", async () => {
    const fx = await createPgFixture(pg);
    try {
      const head = await append(fx, fx.tenantA, "2026-05-01T00:00:00.000Z");
      const guard = { code: "23514", message: "audit event is not the next chain entry" };
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq, head.entryHash)).toMatchObject(guard); // occupied position
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 1, head.previousHash)).toMatchObject(guard); // fork
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 1, null)).toMatchObject(guard); // second root
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 10, head.entryHash)).toMatchObject(guard); // gap
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 1, "f".repeat(64))).toMatchObject(guard); // wrong link
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 2, headSeq: 2 });
    } finally {
      await fx.close();
    }
  });

  it("after the root was pruned, a new root or a restart at position 1 is rejected", async () => {
    const fx = await createPgFixture(pg);
    try {
      await append(fx, fx.tenantA, "2026-01-02T00:00:00.000Z");
      await runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantA, actorHash: ACTOR, now: () => new Date("2027-06-01T00:00:00.000Z") });
      const state = await verify(fx, fx.tenantA);
      expect(state).toMatchObject({ count: 1, headSeq: 3 });
      const guard = { code: "23514", message: "audit event is not the next chain entry" };
      expect(await rawInsertError(fx, fx.tenantA, 1, null)).toMatchObject(guard);
      expect(await rawInsertError(fx, fx.tenantA, state.headSeq + 1, null)).toMatchObject(guard);
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 1, headSeq: 3 });
    } finally {
      await fx.close();
    }
  });

  it("the guard fires even in session_replication_role = replica (migration 009, ENABLE ALWAYS)", async () => {
    const fx = await createPgFixture(pg);
    try {
      const head = await append(fx, fx.tenantA, "2026-05-01T00:00:00.000Z");
      // A role that was (wrongly) granted SET on the parameter; start-up rejects such a role (PARAMETER_PRIVILEGE).
      await fx.admin("GRANT SET ON PARAMETER session_replication_role TO lus_runtime");
      const sql = postgres(pg.url(fx.database, "lus_runtime"), { ssl: "require", max: 1, onnotice: () => undefined });
      let failure: { code?: string } | null = null;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [fx.tenantA]);
          await tx.unsafe(
            "INSERT INTO audit_events (audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash, chain_seq, chain_version) VALUES ($1,$2,$3,'x','SUCCESS',0,'2026-05-02T00:00:00Z',$4,$5,$6,2)",
            [randomUUID(), fx.tenantA, ACTOR, "f".repeat(64), "e".repeat(64), head.chainSeq + 50],
          );
        });
      } catch (error) {
        failure = error as { code?: string };
      } finally {
        await sql.end({ timeout: 5 });
        await pg.admin("postgres", "REVOKE SET ON PARAMETER session_replication_role FROM lus_runtime");
      }
      expect(failure).toMatchObject({ code: "23514" });
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 2, headSeq: 2 });
    } finally {
      await fx.close();
    }
  });

  it("defence in depth: with the guard trigger disabled by a superuser, the unique indexes still reject position reuse, fork and second root", async () => {
    const fx = await createPgFixture(pg);
    try {
      const head = await append(fx, fx.tenantA, "2026-05-01T00:00:00.000Z");
      await fx.admin("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_guard");
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq, "f".repeat(64))).toMatchObject({ code: "23505", constraint: "audit_events_tenant_chain_seq_uniq" });
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 1, head.previousHash)).toMatchObject({ code: "23505", constraint: "audit_events_tenant_previous_hash_uniq" });
      expect(await rawInsertError(fx, fx.tenantA, head.chainSeq + 1, null)).toMatchObject({ code: "23505", constraint: "audit_events_tenant_previous_hash_uniq" });
      await fx.admin("ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_guard");
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 2, headSeq: 2 });
    } finally {
      await fx.close();
    }
  });

  it.each([
    ["position index", "ALTER TABLE audit_events ADD COLUMN chain_seq bigint; CREATE INDEX audit_events_tenant_chain_seq_uniq ON audit_events (tenant_id); ALTER TABLE audit_events DROP COLUMN chain_seq;"],
    // A plain unique index without NULLS NOT DISTINCT would allow several roots.
    ["predecessor index", "CREATE UNIQUE INDEX audit_events_tenant_previous_hash_uniq ON audit_events (tenant_id, previous_hash);"],
  ])("migration 008 fails closed when the %s was pre-empted by a different index of the same name", async (_label, preempt) => {
    const fx = await createPgFixture(pg, { migrate: false });
    try {
      const v7 = loadKnownMigrations().filter((m) => m.version <= 7);
      const ownerDb = createPostgresMigrationDatabase({ connectionString: pg.url(fx.database, "lus_owner"), tlsMode: "require", maxConnections: 1 });
      await ownerDb.transaction(async (tx) => {
        await tx.executeStatic("CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'))");
        for (const m of v7) {
          // Simulate the IF NOT EXISTS hazard of 007: a non-unique index with the guard's name already exists.
          if (m.version === 7) await tx.executeStatic(preempt);
          await tx.executeStatic(m.sql);
          await tx.query({ text: "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)", values: [m.version, m.name, m.checksum] });
        }
      });
      await expect(applyPendingMigrations(fx.owner())).rejects.toThrow();
      let ledger: unknown[] = [];
      await ownerDb.transaction(async (tx) => {
        ledger = [...(await tx.query({ text: "SELECT max(version)::int AS v FROM schema_migrations", values: [] })).rows];
      });
      expect(ledger).toEqual([{ v: 7 }]);
      await ownerDb.close();
    } finally {
      await fx.close();
    }
  });

  it("migration v6 → v7 fails closed on legacy audit history and changes no data", async () => {
    const fx = await createPgFixture(pg, { migrate: false });
    try {
      // Apply v1–v6 exactly as an existing installation would have them.
      const v6 = loadKnownMigrations().filter((m) => m.version <= 6);
      const ownerDb = createPostgresMigrationDatabase({ connectionString: pg.url(fx.database, "lus_owner"), tlsMode: "require", maxConnections: 1 });
      await ownerDb.transaction(async (tx) => {
        await tx.executeStatic("CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'))");
        for (const m of v6) {
          await tx.executeStatic(m.sql);
          await tx.query({ text: "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)", values: [m.version, m.name, m.checksum] });
        }
      });
      // One legacy (v1-hash) audit row.
      const tenant = parseTenantId(randomUUID());
      await ownerDb.transaction(async (tx) => {
        await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
        await tx.query({ text: "INSERT INTO tenants (tenant_id, organization_id_hash, status) VALUES ($1,$2,'active')", values: [tenant, "3".repeat(64)] });
        await tx.query({
          text: "INSERT INTO audit_events (audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash) VALUES ($1,$2,$3,'tenant.create','SUCCESS',1,'2026-01-01T00:00:00Z',NULL,$4)",
          values: [randomUUID(), tenant, ACTOR, "d".repeat(64)],
        });
      });
      await expect(applyPendingMigrations(fx.owner())).rejects.toThrow();
      // Nothing changed: ledger still at v6, legacy row intact, no chain_seq column.
      let ledger: unknown[] = [];
      let columns: unknown[] = [];
      let rows: unknown[] = [];
      await ownerDb.transaction(async (tx) => {
        ledger = [...(await tx.query({ text: "SELECT max(version)::int AS v FROM schema_migrations", values: [] })).rows];
        columns = [...(await tx.query({ text: "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'chain_seq'", values: [] })).rows];
        await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
        rows = [...(await tx.query({ text: "SELECT entry_hash FROM audit_events", values: [] })).rows];
      });
      expect(ledger).toEqual([{ v: 6 }]);
      expect(columns).toEqual([]);
      expect(rows).toEqual([{ entry_hash: "d".repeat(64) }]);
      await ownerDb.close();
    } finally {
      await fx.close();
    }
  });

  it("a fresh database migrates v0 → v9 and starts with an empty, verifiable chain", async () => {
    const fx = await createPgFixture(pg, { tenants: false });
    try {
      // createPgFixture applied all migrations through the production runner on an empty database.
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 0, headSeq: 0 });
    } finally {
      await fx.close();
    }
  });

  it("an existing v6 installation with a tenant but no audit history upgrades to v9 and the chain starts at position 1", async () => {
    const fx = await createPgFixture(pg, { migrate: false });
    try {
      const v6 = loadKnownMigrations().filter((m) => m.version <= 6);
      const ownerDb = createPostgresMigrationDatabase({ connectionString: pg.url(fx.database, "lus_owner"), tlsMode: "require", maxConnections: 1 });
      await ownerDb.transaction(async (tx) => {
        await tx.executeStatic("CREATE TABLE IF NOT EXISTS schema_migrations (version bigint PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'))");
        for (const m of v6) {
          await tx.executeStatic(m.sql);
          await tx.query({ text: "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)", values: [m.version, m.name, m.checksum] });
        }
        await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [fx.tenantA] });
        await tx.query({ text: "INSERT INTO tenants (tenant_id, organization_id_hash, status) VALUES ($1,$2,'active')", values: [fx.tenantA, "5".repeat(64)] });
      });
      await expect(applyPendingMigrations(fx.owner())).resolves.toEqual({ appliedVersions: [7, 8, 9] });
      await ownerDb.transaction(async (tx) => {
        for (const grant of RUNTIME_GRANTS) await tx.executeStatic(grant);
      });
      await ownerDb.close();
      const first = await append(fx, fx.tenantA, "2026-06-01T00:00:00.000Z");
      expect(first).toMatchObject({ chainSeq: 1, previousHash: null });
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 1, headSeq: 1 });
    } finally {
      await fx.close();
    }
  });

  it("role defaults (TimeZone, isolation, search_path) cannot change how the runtime reads or appends", async () => {
    const fx = await createPgFixture(pg);
    try {
      await fx.admin(
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET timezone = 'Europe/Berlin'; ` +
          `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET default_transaction_isolation = 'repeatable read'; ` +
          `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET search_path = '"$user", public';`,
      );
      const settings = await fx.runtime().transaction(async (tx) => (await tx.query<Record<string, string>>({
        text: "SELECT current_setting('TimeZone') AS tz, current_setting('transaction_isolation') AS iso, current_setting('search_path') AS sp",
        values: [],
      })).rows[0]);
      expect(settings).toEqual({ tz: "UTC", iso: "read committed", sp: "public, pg_temp" });
      // Under repeatable read, concurrent appends would fail with unique violations (security review L2).
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => append(fx, fx.tenantA, "1970-01-01T00:00:00.000Z")));
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 9, headSeq: 9 });
    } finally {
      await fx.close();
    }
  });

  it("capacity full and nothing expired: retention fails and rolls back completely (no deletion, no anchor, no record)", async () => {
    const fx = await createPgFixture(pg);
    try {
      await append(fx, fx.tenantA, "2026-06-01T00:00:00.000Z");
      // Two entries now (bootstrap + one); cap the tenant at exactly that.
      await ownerSql(fx, fx.tenantA, "UPDATE tenants SET max_audit_events = 2 WHERE tenant_id = $1", [fx.tenantA]);
      await expect(
        runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantA, actorHash: ACTOR, now: () => new Date("2026-07-01T00:00:00.000Z") }),
      ).rejects.toThrow();
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 2, anchorHash: null, headSeq: 2 });
    } finally {
      await fx.close();
    }
  });

  it("capacity full but an expired prefix exists: retention frees room and its own record fits", async () => {
    const fx = await createPgFixture(pg);
    try {
      await append(fx, fx.tenantA, "2026-06-01T00:00:00.000Z");
      await ownerSql(fx, fx.tenantA, "UPDATE tenants SET max_audit_events = 2 WHERE tenant_id = $1", [fx.tenantA]);
      const result = await runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantA, actorHash: ACTOR, now: () => new Date("2027-01-15T00:00:00.000Z") });
      expect(result.auditDeleted).toBe(1);
      await expect(verify(fx, fx.tenantA)).resolves.toMatchObject({ count: 2, headSeq: 3 });
    } finally {
      await fx.close();
    }
  });

  it("verifies exactly 100 000 entries and refuses 100 001 (truncated history is never 'verified')", async () => {
    const fx = await createPgFixture(pg, { tenants: false });
    try {
      const tenant = fx.tenantA;
      await fx.owner().transaction(async (tx) => {
        await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
        await tx.query({ text: "INSERT INTO tenants (tenant_id, organization_id_hash, status) VALUES ($1,$2,'active')", values: [tenant, "4".repeat(64)] });
      });
      // Build a valid 100 001-entry chain in memory and bulk-insert it as the owner (bypassing the capacity check).
      const ids: string[] = [];
      const prevs: Array<string | null> = [];
      const hashes: string[] = [];
      let previousHash: string | null = null;
      for (let seq = 1; seq <= 100_001; seq += 1) {
        const entry = { auditId: randomUUID(), tenantId: tenant, actorHash: ACTOR, action: "bulk", result: "SUCCESS", itemCount: 0, createdAt: "2026-01-01T00:00:00.000Z", previousHash, chainSeq: seq };
        const hash = computeAuditEntryHash(entry);
        ids.push(entry.auditId);
        prevs.push(previousHash);
        hashes.push(hash);
        previousHash = hash;
      }
      const insertRange = (from: number, to: number) =>
        fx.owner().transaction(async (tx) => {
          await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
          for (let start = from; start < to; start += 10_000) {
            const end = Math.min(start + 10_000, to);
            const batch = Array.from({ length: end - start }, (_, i) => ({ a: ids[start + i], p: prevs[start + i], h: hashes[start + i], s: start + i + 1 }));
            await tx.query({
              text:
                "INSERT INTO audit_events (audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash, chain_seq, chain_version) " +
                "SELECT t.a, $2::uuid, $3, 'bulk', 'SUCCESS', 0, '2026-01-01T00:00:00Z', t.p, t.h, t.s, 2 FROM jsonb_to_recordset($1::jsonb) AS t(a uuid, p text, h text, s bigint)",
              values: [batch, tenant, ACTOR],
            });
          }
        });
      await insertRange(0, 100_000);
      await expect(verify(fx, tenant)).resolves.toMatchObject({ count: 100_000, headSeq: 100_000 });
      await insertRange(100_000, 100_001);
      await expect(verify(fx, tenant)).rejects.toThrow(/exceeds the integrity verification limit/);
    } finally {
      await fx.close();
    }
  }, 180_000);
});
