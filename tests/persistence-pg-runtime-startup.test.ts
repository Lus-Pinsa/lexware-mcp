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
import { verifyConfiguredTenantBinding } from "../src/persistence/tenant-binding.js";
import { PersistenceValidationError, parseTenantId, type TenantId } from "../src/persistence/types.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, ORG_A, ORG_B, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const READ_ONLY = { drafts: false, finalize: false } as const;

/** Mirrors the start sequence in src/server.ts (persistence enabled branch). */
async function startupGates(db: PersistenceDatabase, config: EnabledPersistenceRuntimeConfig, capabilities = READ_ONLY) {
  assertMigrationStateCurrent(await db.transaction((tx) => listAppliedSchemaMigrations(tx)));
  assertLeastPrivilegeRuntimeRole(await db.transaction((tx) => inspectRuntimePrivileges(tx)), config.expectedRuntimeRole);
  await verifyConfiguredTenantBinding(config, db, capabilities);
}

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
  }, 60_000);

  const ownerAs = (tenant: TenantId, sql: string, values: unknown[] = []) =>
    fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      await tx.query({ text: sql, values });
    });

  it("a correctly provisioned database passes every gate", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).resolves.toBeUndefined();
  });

  it("refuses to start with a pending migration (ledger behind the code)", async () => {
    await fx.admin("DELETE FROM schema_migrations WHERE version = 8");
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/pending migrations/);
  });

  it("refuses to start with a tampered migration checksum", async () => {
    await fx.admin(`UPDATE schema_migrations SET checksum = '${"0".repeat(64)}' WHERE version = 3`);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses to start with an unknown newer schema version", async () => {
    await fx.admin(`INSERT INTO schema_migrations (version, name, checksum) VALUES (9, 'future', '${"f".repeat(64)}')`);
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/newer or unknown/);
  });

  it("refuses to start as the table owner instead of the runtime role", async () => {
    await expect(startupGates(fx.runtimeMaintenance(), configFor(fx.tenantA, ORG_A))).rejects.toThrow(/privilege verification failed/);
  });

  it("refuses to start when the connected role is not the expected one", async () => {
    await expect(startupGates(fx.runtime(), configFor(fx.tenantA, ORG_A, "lus_runtime_other"))).rejects.toThrow(/ROLE_MISMATCH/);
  });

  it("refuses to start for a tenant that does not exist", async () => {
    await expect(startupGates(fx.runtime(), configFor(parseTenantId(randomUUID()), ORG_A))).rejects.toThrow(/does not exist/);
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
    // Attacks: the same statements targeting tenant B from a tenant-A binding are rejected.
    await expect(asRuntime(fx.tenantA, (q) => auditInsert(q, fx.tenantB))).rejects.toThrow();
    await expect(asRuntime(fx.tenantA, (q) => webhookInsert(q, fx.tenantB))).rejects.toThrow();
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

  it("the runtime cannot disable row-level security, change its own binding policy, or escalate", async () => {
    for (const sql of [
      "ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY",
      "DROP POLICY tenant_isolation_audit_events ON audit_events",
      "SET ROLE lus_owner",
      "CREATE TABLE public.attacker (x int)",
    ]) {
      await expect(asRuntime(fx.tenantA, (q) => q(sql)), sql).rejects.toThrow();
    }
  });
});
