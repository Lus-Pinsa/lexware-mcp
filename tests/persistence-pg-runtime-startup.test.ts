/**
 * Runtime start-up gates and cross-tenant attacks on REAL PostgreSQL (synthetic data, ephemeral cluster).
 *
 * The server start sequence (src/server.ts) is: migration ledger current → least-privilege runtime role → tenant
 * binding. Each gate is exercised here with the production functions against a real database; every failure must stop
 * the start (throw), there is no RAM fallback.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertMigrationStateCurrent } from "../src/persistence/migration-runner.js";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import {
  appendAuditEvent,
  inspectRuntimePrivileges,
  listAppliedSchemaMigrations,
  listPendingWebhookEvents,
  withTenantTransaction,
  type PersistenceDatabase,
} from "../src/persistence/repository.js";
import { assertLeastPrivilegeRuntimeRole } from "../src/persistence/runtime-privileges.js";
import type { EnabledPersistenceRuntimeConfig } from "../src/persistence/runtime-config.js";
import { runPersistenceStartupGates } from "../src/persistence/startup-gates.js";
import { verifySchemaSafety, verifySessionSettings } from "../src/persistence/schema-safety-repository.js";
import { createPostgresDatabase } from "../src/persistence/postgres-driver.js";
import postgres from "postgres";
import { PersistenceValidationError, parseTenantId, type TenantId } from "../src/persistence/types.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, ORG_A, ORG_B, RUNTIME_GRANTS, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const READ_ONLY = { drafts: false, finalize: false } as const;

/** The production start-up gate sequence (shared with src/server.ts, see src/persistence/startup-gates.ts). */
const startupGates = (db: PersistenceDatabase, config: EnabledPersistenceRuntimeConfig, capabilities: { drafts: boolean; finalize: boolean } = READ_ONLY) =>
  runPersistenceStartupGates(db, config, capabilities);

const configFor = (tenantId: TenantId, organizationIdHash: string, expectedRuntimeRole = "lus_runtime") =>
  ({ enabled: true, tenantId, organizationIdHash, expectedRuntimeRole, tlsMode: "require" }) as unknown as EnabledPersistenceRuntimeConfig;

describe.skipIf(!postgresAvailable())("runtime start-up gates on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
  }, 120_000);
  afterAll(async () => {
    await fx?.close();
    await pg?.stop();
  });
  beforeEach(async () => {
    await fx?.close();
    fx = await createPgFixture(pg);
    // A production runtime role is bound to exactly its configured tenant (migration 010).
    await fx.unbindRuntime(fx.tenantB);
  }, 60_000);

  const ownerAs = (tenant: TenantId, sql: string, values: unknown[] = []) =>
    fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      await tx.query({ text: sql, values });
    });

  it("a correctly provisioned database passes every gate", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).resolves.toBeUndefined();
  });

  it("refuses to start when the runtime role is not bound to any tenant (C-01)", async () => {
    await fx.unbindRuntime(fx.tenantA);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/not bound to exactly the configured tenant/);
  });

  it("refuses to start when the runtime role is bound to a second tenant as well (C-01)", async () => {
    await fx.bindRuntime(fx.tenantB);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/not bound to exactly the configured tenant/);
  });

  it("refuses to start when the runtime role is bound only to a different tenant (C-01)", async () => {
    await fx.unbindRuntime(fx.tenantA);
    await fx.bindRuntime(fx.tenantB);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/not bound to exactly the configured tenant/);
  });

  it.each([
    ["INSERT", "GRANT INSERT ON tenant_runtime_bindings TO lus_runtime", "TENANT_BINDING_MUTATION"],
    ["DELETE", "GRANT DELETE ON tenant_runtime_bindings TO lus_runtime", "TENANT_BINDING_MUTATION"],
    ["column UPDATE", "GRANT UPDATE (tenant_id) ON tenant_runtime_bindings TO lus_runtime", "TENANT_BINDING_MUTATION"],
    ["no SELECT", "REVOKE SELECT ON tenant_runtime_bindings FROM lus_runtime", "TENANT_BINDING_READ_MISSING"],
  ])("refuses to start when the runtime role has %s on the binding table (C-01)", async (_label, sql, code) => {
    await fx.admin(sql);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(new RegExp(`privilege verification failed: .*${code}`));
  });

  it("refuses to start with a pending migration (ledger behind the code)", async () => {
    await fx.admin("DELETE FROM schema_migrations WHERE version = 10");
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/pending migrations/);
  });

  it("refuses to start with a tampered migration checksum", async () => {
    await fx.admin(`UPDATE schema_migrations SET checksum = '${"0".repeat(64)}' WHERE version = 3`);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses to start with an unknown newer schema version", async () => {
    await fx.admin(`INSERT INTO schema_migrations (version, name, checksum) VALUES (11, 'future', '${"f".repeat(64)}')`);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/newer or unknown/);
  });

  it.each([
    ["the append guard trigger dropped", "DROP TRIGGER audit_events_append_guard ON audit_events", "APPEND_GUARD"],
    ["the append guard disabled", "ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_guard", "APPEND_GUARD"],
    ["the append guard not ALWAYS (skipped in replica mode)", "ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_guard", "APPEND_GUARD"],
    ["the guard function made SECURITY DEFINER", "ALTER FUNCTION public.audit_events_append_guard() SECURITY DEFINER", "APPEND_GUARD"],
    ["row-level security not forced on webhook_events", "ALTER TABLE webhook_events NO FORCE ROW LEVEL SECURITY", "RLS_NOT_FORCED"],
    ["row-level security disabled on tenants", "ALTER TABLE tenants DISABLE ROW LEVEL SECURITY", "RLS_NOT_FORCED"],
    ["an additional permissive policy", "CREATE POLICY open_read ON audit_events FOR SELECT USING (true)", "RLS_POLICY"],
    ["a policy replaced by USING (true)", "DROP POLICY tenant_isolation_webhook_events ON webhook_events; CREATE POLICY tenant_isolation_webhook_events ON webhook_events USING (true) WITH CHECK (true)", "RLS_POLICY"],
    ["the position index dropped", "DROP INDEX audit_events_tenant_chain_seq_uniq", "SEQ_INDEX"],
    ["the guard body replaced by RETURN NEW", "CREATE OR REPLACE FUNCTION public.audit_events_append_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$BEGIN RETURN NEW; END$$", "APPEND_GUARD"],
    ["the guard re-created as BEFORE UPDATE", "DROP TRIGGER audit_events_append_guard ON audit_events; CREATE TRIGGER audit_events_append_guard BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_guard(); ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_guard", "APPEND_GUARD"],
    ["the guard with a WHEN clause", "DROP TRIGGER audit_events_append_guard ON audit_events; CREATE TRIGGER audit_events_append_guard BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.item_count < 0) EXECUTE FUNCTION public.audit_events_append_guard(); ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_guard", "APPEND_GUARD"],
    ["a second BEFORE INSERT trigger that runs after the guard", "CREATE FUNCTION public.zz_shift() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.chain_seq := NEW.chain_seq + 10; RETURN NEW; END$$; CREATE TRIGGER zz_shift BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.zz_shift()", "EXTRA_TRIGGER"],
    ["an INSTEAD rule on audit_events", "CREATE RULE swallow AS ON INSERT TO audit_events DO INSTEAD NOTHING", "RULE"],
    ["an UPDATE rule on webhook_events", "CREATE RULE no_ack AS ON UPDATE TO webhook_events DO INSTEAD NOTHING", "RULE"],
    ["an inheritance child of audit_events", "CREATE TABLE audit_child () INHERITS (audit_events); GRANT INSERT, SELECT ON audit_child TO lus_runtime", "INHERITANCE"],
    ["audit_retention_anchors set UNLOGGED", "ALTER TABLE audit_retention_anchors SET UNLOGGED", "NOT_PERMANENT"],
    ["the runtime-binding policy dropped (C-01)", "DROP POLICY tenant_runtime_binding_audit_events ON audit_events", "BINDING_POLICY"],
    ["the runtime-binding policy made permissive (C-01)", "DROP POLICY tenant_runtime_binding_tenants ON tenants; CREATE POLICY tenant_runtime_binding_tenants ON tenants USING (public.tenant_runtime_allowed(tenant_id)) WITH CHECK (public.tenant_runtime_allowed(tenant_id))", "BINDING_POLICY"],
    ["the runtime-binding policy replaced by USING (true) (C-01)", "DROP POLICY tenant_runtime_binding_webhook_events ON webhook_events; CREATE POLICY tenant_runtime_binding_webhook_events ON webhook_events AS RESTRICTIVE USING (true) WITH CHECK (true)", "BINDING_POLICY"],
    ["the binding function body replaced by SELECT true (C-01)", "CREATE OR REPLACE FUNCTION public.tenant_runtime_allowed(p_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$SELECT true$$", "BINDING_FUNCTION"],
    ["the binding function made SECURITY DEFINER (C-01)", "ALTER FUNCTION public.tenant_runtime_allowed(uuid) SECURITY DEFINER", "BINDING_FUNCTION"],
    ["a shadowing overload of the binding function (C-01)", "CREATE FUNCTION public.tenant_runtime_allowed(p text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$", "BINDING_FUNCTION"],
    ["row-level security disabled on the binding table (C-01)", "ALTER TABLE tenant_runtime_bindings DISABLE ROW LEVEL SECURITY", "BINDING_TABLE"],
    ["an additional permissive policy on the binding table (C-01)", "CREATE POLICY see_all ON tenant_runtime_bindings FOR SELECT USING (true)", "BINDING_TABLE"],
    ["FORCE row-level security on the binding table (owner could no longer bind) (C-01)", "ALTER TABLE tenant_runtime_bindings FORCE ROW LEVEL SECURITY", "BINDING_TABLE"],
    ["the binding table's tenant foreign key dropped (stale bindings) (C-01)", "ALTER TABLE tenant_runtime_bindings DROP CONSTRAINT tenant_runtime_bindings_tenant_id_fkey", "BINDING_TABLE"],
    ["the binding table's foreign key without ON DELETE CASCADE (C-01)", "ALTER TABLE tenant_runtime_bindings DROP CONSTRAINT tenant_runtime_bindings_tenant_id_fkey; ALTER TABLE tenant_runtime_bindings ADD CONSTRAINT tenant_runtime_bindings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id)", "BINDING_TABLE"],
    ["the binding table's primary key dropped (C-01)", "ALTER TABLE tenant_runtime_bindings DROP CONSTRAINT tenant_runtime_bindings_pkey", "BINDING_TABLE"],
    ["an extra column on the binding table (C-01)", "ALTER TABLE tenant_runtime_bindings ADD COLUMN wildcard boolean NOT NULL DEFAULT false", "BINDING_TABLE"],
    ["a trigger on the binding table (C-01)", "CREATE FUNCTION public.zz_bind() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER zz_bind BEFORE INSERT ON tenant_runtime_bindings FOR EACH ROW EXECUTE FUNCTION public.zz_bind()", "BINDING_TABLE"],
    ["the predecessor index replaced without NULLS NOT DISTINCT", "DROP INDEX audit_events_tenant_previous_hash_uniq; CREATE UNIQUE INDEX audit_events_tenant_previous_hash_uniq ON audit_events (tenant_id, previous_hash)", "PREDECESSOR_INDEX"],
  ])("refuses to start with %s although the ledger is current", async (_label, sql, code) => {
    await fx.admin(sql);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(new RegExp(`schema safety verification failed: .*${code}`));
  });

  it("role defaults for DateStyle and bytea_output do not change what the runtime reads", async () => {
    await fx.admin(
      `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET datestyle = 'SQL, DMY'; ` +
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET bytea_output = 'escape'; ` +
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET intervalstyle = 'sql_standard'; ` +
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET synchronous_commit = off; ` +
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET standard_conforming_strings = off; ` +
        `ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET row_security = off`,
    );
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).resolves.toBeUndefined();
    const read = await fx.runtime().transaction(async (tx) => (await tx.query<{ t: Date; b: Uint8Array }>({
      text: "SELECT '2026-01-12T00:00:00Z'::timestamptz AS t, '\\x0102'::bytea AS b",
      values: [],
    })).rows[0]!);
    expect(read.t.toISOString()).toBe("2026-01-12T00:00:00.000Z");
    expect([...read.b]).toEqual([1, 2]);
    const settings = await fx.runtime().transaction(async (tx) => (await tx.query<Record<string, string>>({
      text: "SELECT current_setting('synchronous_commit') AS sc, current_setting('standard_conforming_strings') AS scs, current_setting('row_security') AS rs",
      values: [],
    })).rows[0]!);
    expect(settings).toEqual({ sc: "on", scs: "on", rs: "on" });
  });

  it("refuses to start when a superuser set session_replication_role = replica for the runtime role", async () => {
    await fx.admin(`ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET session_replication_role = replica`);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/session settings verification failed/);
  });

  it("refuses to start when the pinned session settings are not in effect (e.g. a proxy dropped them)", async () => {
    await fx.admin(`ALTER ROLE lus_runtime IN DATABASE ${fx.database} SET datestyle = 'SQL, DMY'`);
    // A factory that drops the DateStyle startup parameter, as a connection pooler might.
    const dropping = ((url: string, options: Record<string, unknown>) => {
      const connection = { ...(options.connection as Record<string, string>) };
      delete connection.DateStyle;
      return postgres(url, { ...options, connection } as never);
    }) as never;
    const db = createPostgresDatabase({ connectionString: pg.url(fx.database, "lus_runtime"), tlsMode: "require", maxConnections: 1 }, dropping);
    try {
      await expect(startupGates(db, configFor(fx.tenantA, ORG_A))).rejects.toThrow(/session settings verification failed/);
    } finally {
      await db.close();
    }
  });

  it("refuses to start as the table owner instead of the runtime role", async () => {
    await expect(startupGates(fx.runtimeMaintenance(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/privilege verification failed/);
  });

  it("refuses to start when the connected role is not the expected one", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A, "lus_runtime_other"))).rejects.toThrow(/ROLE_MISMATCH/);
  });

  it("refuses to start for a tenant that does not exist (no binding can reference it)", async () => {
    // The binding table references tenants, so an unknown tenant can never be bound: start-up stops at the binding gate.
    await expect(startupGates(fx.runtime(), configFor(parseTenantId(randomUUID()), ORG_A))).rejects.toThrow(/not bound to exactly the configured tenant/);
  });

  it("refuses to start when the tenant belongs to another organization", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_B))).rejects.toThrow(/organization mismatch/);
  });

  it("refuses to start for a disabled tenant", async () => {
    await ownerAs(fx.tenantA, "UPDATE tenants SET status = 'disabled' WHERE tenant_id = $1", [fx.tenantA]);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/disabled/);
  });

  it("refuses to start when runtime write capabilities exceed the tenant tier (read_only)", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A), { drafts: true, finalize: false })).rejects.toThrow(/exceeds tenant policy/);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A), { drafts: true, finalize: true })).rejects.toThrow(/exceeds tenant policy/);
  });
});

describe.skipIf(!postgresAvailable())("cross-tenant attacks against the runtime role on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
    fx = await createPgFixture(pg);
  }, 120_000);
  afterAll(async () => {
    await fx?.close();
    await pg?.stop();
  });

  /** Runtime connection bound to `bound`, running attacker-chosen SQL. */
  const asRuntime = <T>(bound: TenantId | null, work: (q: (text: string, values?: unknown[]) => Promise<readonly Record<string, unknown>[]>) => Promise<T>) =>
    fx.runtime().transaction(async (tx) => {
      if (bound !== null) await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [bound] });
      return work(async (text, values = []) => (await tx.query({ text, values })).rows);
    });

  it("bound to tenant A, explicit reads of tenant B return nothing (tenants, audit, anchors, webhooks)", async () => {
    const out = await asRuntime(fx.tenantA, async (q) => ({
      tenants: await q("SELECT tenant_id FROM tenants WHERE tenant_id = $1", [fx.tenantB]),
      audit: await q("SELECT audit_id FROM audit_events WHERE tenant_id = $1", [fx.tenantB]),
      anchors: await q("SELECT tenant_id FROM audit_retention_anchors WHERE tenant_id = $1", [fx.tenantB]),
      webhooks: await q("SELECT event_key_hash FROM webhook_events WHERE tenant_id = $1", [fx.tenantB]),
      all: await q("SELECT DISTINCT tenant_id::text AS t FROM audit_events"),
    }));
    expect(out.tenants).toEqual([]);
    expect(out.audit).toEqual([]);
    expect(out.anchors).toEqual([]);
    expect(out.webhooks).toEqual([]);
    expect(out.all).toEqual([{ t: fx.tenantA }]);
  });

  it("without a tenant binding the runtime sees no rows at all", async () => {
    const rows = await asRuntime(null, (q) => q("SELECT count(*)::int AS c FROM audit_events"));
    expect(rows).toEqual([{ c: 0 }]);
  });

  it("bound to tenant A, writing a row for tenant B is rejected by the row-level security check", async () => {
    const auditInsert = (q: (text: string, values?: unknown[]) => Promise<unknown>, target: TenantId) =>
      q(
        // The next entry as the append guard (v8) expects it: head + 1, linked to the head hash visible to the binding.
        "INSERT INTO audit_events (audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash, chain_seq, chain_version) " +
          "SELECT $1, $2, $3, 'x', 'SUCCESS', 0, now(), " +
          "(SELECT entry_hash FROM audit_events WHERE tenant_id = $2 ORDER BY chain_seq DESC LIMIT 1), $4, " +
          "COALESCE((SELECT max(chain_seq) FROM audit_events WHERE tenant_id = $2), 0) + 1, 2",
        [randomUUID(), target, ACTOR, "e".repeat(64)],
      );
    const webhookInsert = (q: (text: string, values?: unknown[]) => Promise<unknown>, target: TenantId) =>
      q(
        "INSERT INTO webhook_events (tenant_id, event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, event_date, received_at, payload_checksum, source, request_budget_status, quality_status) " +
          "VALUES ($1,$2,'voucher.created','\\x00'::bytea,decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'k',now(),now(),$2,'lexware_webhook','NOT_APPLICABLE','STRUCTURED')",
        [target, "c".repeat(64)],
      );
    // Positive controls: the identical statements succeed for the bound tenant (then rolled back via a sentinel).
    const sentinel = new PersistenceValidationError("rollback-sentinel");
    await expect(asRuntime(fx.tenantB, async (q) => { await auditInsert(q, fx.tenantB); throw sentinel; })).rejects.toBe(sentinel);
    await expect(asRuntime(fx.tenantB, async (q) => { await webhookInsert(q, fx.tenantB); throw sentinel; })).rejects.toBe(sentinel);
    // Attacks: the same statements targeting tenant B from a tenant-A binding are rejected, by row-level security
    // (SQLSTATE 42501, asserted through a plain client because the production driver hides database errors).
    await expect(asRuntime(fx.tenantA, (q) => auditInsert(q, fx.tenantB))).rejects.toThrow();
    await expect(asRuntime(fx.tenantA, (q) => webhookInsert(q, fx.tenantB))).rejects.toThrow();
    const raw = postgres(pg.url(fx.database, "lus_runtime"), { ssl: "require", max: 1, onnotice: () => undefined });
    try {
      for (const insert of [auditInsert, webhookInsert]) {
        const error = await raw
          .begin(async (tx) => {
            await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [fx.tenantA]);
            await insert((text, values = []) => tx.unsafe(text, values as never[]), fx.tenantB);
          })
          .then(() => null, (e: { code?: string; message?: string }) => e);
        expect(error).toMatchObject({ code: "42501" });
        expect(error?.message).toMatch(/row-level security/);
      }
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("switching the binding mid-transaction to tenant B does not grant access to A's rows, and B's chain stays intact", async () => {
    const rows = await asRuntime(fx.tenantA, async (q) => {
      await q("SELECT set_config('app.tenant_id', $1, true)", [fx.tenantB]);
      return q("SELECT tenant_id::text AS t FROM audit_events WHERE tenant_id = $1", [fx.tenantA]);
    });
    expect(rows).toEqual([]);
    await expect(withTenantTransaction(fx.tenantB, fx.runtime(), (tx) => verifyAuditChainIntegrity(fx.tenantB, tx))).resolves.toMatchObject({ count: 1 });
  });

  it("the repository refuses an append for tenant B through a transaction bound to tenant A", async () => {
    await expect(
      withTenantTransaction(fx.tenantA, fx.runtime(), (tx) =>
        appendAuditEvent(fx.tenantB, tx, { auditId: randomUUID(), actorHash: ACTOR, action: "test.event", result: "SUCCESS", itemCount: 0, createdAt: "2026-05-01T00:00:00.000Z" }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(fx.tenantA, fx.runtime(), (tx) => listPendingWebhookEvents(fx.tenantB, tx)),
    ).resolves.toEqual([]);
    await expect(withTenantTransaction(fx.tenantB, fx.runtime(), (tx) => verifyAuditChainIntegrity(fx.tenantB, tx))).resolves.toMatchObject({ count: 1 });
  });

  it("C-01: a runtime role bound only to tenant A cannot reach tenant B by rebinding app.tenant_id (read, insert, update)", async () => {
    await fx.admin(
      "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lus_runtime_a') THEN CREATE ROLE lus_runtime_a LOGIN; END IF; END$$; " +
        RUNTIME_GRANTS.map((g) => g.replace(/lus_runtime\b/g, "lus_runtime_a")).join("; "),
    );
    await fx.bindRuntime(fx.tenantA, "lus_runtime_a");
    const raw = postgres(pg.url(fx.database, "lus_runtime_a"), { ssl: "require", max: 1, onnotice: () => undefined });
    try {
      const asA = <T>(tenant: TenantId, work: (q: (text: string, values?: unknown[]) => Promise<readonly Record<string, unknown>[]>) => Promise<T>) =>
        raw.begin(async (tx) => {
          await tx.unsafe("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
          return work(async (text, values = []) => [...(await tx.unsafe(text, values as never[]))] as Record<string, unknown>[]);
        });
      // Positive control: the role works for its own tenant.
      await expect(asA(fx.tenantA, (q) => q("SELECT count(*)::int AS c FROM tenants WHERE tenant_id = $1", [fx.tenantA]))).resolves.toEqual([{ c: 1 }]);
      // Attack: rebind the transaction to tenant B and read B's rows directly.
      const read = await asA(fx.tenantB, async (q) => ({
        tenants: await q("SELECT tenant_id FROM tenants WHERE tenant_id = $1", [fx.tenantB]),
        audit: await q("SELECT audit_id FROM audit_events WHERE tenant_id = $1", [fx.tenantB]),
        anchors: await q("SELECT tenant_id FROM audit_retention_anchors WHERE tenant_id = $1", [fx.tenantB]),
        webhooks: await q("SELECT event_key_hash FROM webhook_events WHERE tenant_id = $1", [fx.tenantB]),
        bindings: await q("SELECT role_name, tenant_id FROM tenant_runtime_bindings"),
      }));
      expect(read).toEqual({ tenants: [], audit: [], anchors: [], webhooks: [], bindings: [{ role_name: "lus_runtime_a", tenant_id: fx.tenantA }] });
      // Attack: write for tenant B after rebinding -> row-level security (restrictive binding policy) rejects it.
      const insertError = await asA(fx.tenantB, (q) =>
        q(
          "INSERT INTO webhook_events (tenant_id, event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, event_date, received_at, payload_checksum, source, request_budget_status, quality_status) " +
            "VALUES ($1,$2,'voucher.created','\\x00'::bytea,decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'k',now(),now(),$2,'lexware_webhook','NOT_APPLICABLE','STRUCTURED')",
          [fx.tenantB, "b".repeat(64)],
        ),
      ).then(() => null, (e: { code?: string; message?: string }) => e);
      expect(insertError).toMatchObject({ code: "42501" });
      expect(insertError?.message).toMatch(/row-level security/);
      // Attack: update (acknowledge) tenant B's events after rebinding -> no row is visible, nothing changes.
      const updated = await asA(fx.tenantB, (q) => q("UPDATE webhook_events SET acknowledged_at = now() WHERE tenant_id = $1 RETURNING event_key_hash", [fx.tenantB]));
      expect(updated).toEqual([]);
      // Attack: the role cannot bind itself to tenant B.
      const bindError = await raw
        .unsafe("INSERT INTO tenant_runtime_bindings (role_name, tenant_id) VALUES ('lus_runtime_a', $1)", [fx.tenantB])
        .then(() => null, (e: { code?: string }) => e);
      expect(bindError).toMatchObject({ code: "42501" });
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("the runtime cannot disable row-level security, change its own binding policy, or escalate", async () => {
    for (const sql of [
      "ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY",
      "DROP POLICY tenant_isolation_audit_events ON audit_events",
      "DROP POLICY tenant_runtime_binding_audit_events ON audit_events",
      "CREATE OR REPLACE FUNCTION public.tenant_runtime_allowed(p_tenant_id uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$",
      "DELETE FROM tenant_runtime_bindings",
      "SET ROLE lus_owner",
      "CREATE TABLE public.attacker (x int)",
    ]) {
      await expect(asRuntime(fx.tenantA, (q) => q(sql)), sql).rejects.toThrow();
    }
  });
});
