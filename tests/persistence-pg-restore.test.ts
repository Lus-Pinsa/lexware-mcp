/**
 * Backup/restore verification on REAL PostgreSQL: pg_dump (custom format) → pg_restore into a fresh database, then the
 * production restore manifest and audit integrity checks (synthetic data, ephemeral cluster, nothing production).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEncryptionKeyring } from "../src/persistence/crypto.js";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import { createDurablePendingVoucherEventStore } from "../src/persistence/pending-voucher-store.js";
import { createPostgresDatabase } from "../src/persistence/postgres-driver.js";
import { appendAuditEvent, withTenantTransaction, type PersistenceDatabase } from "../src/persistence/repository.js";
import {
  captureCompleteRestoreManifest,
  captureRestoreVerificationManifest,
  verifyRestoredDatabase,
  verifyRestoredDatabaseComplete,
} from "../src/persistence/restore-verification.js";
import { runTenantRetention } from "../src/persistence/retention.js";
import type { TenantId } from "../src/persistence/types.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const keyring = createEncryptionKeyring({ "test-k1": randomBytes(32) }, "test-k1");
const CHECKSUM = "b".repeat(64);
let restoreCounter = 0;

describe.skipIf(!postgresAvailable())("backup/restore verification on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;
  const opened: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
  }, 120_000);
  afterAll(async () => {
    for (const db of opened.splice(0)) await db.close().catch(() => undefined);
    await fx?.close();
    await pg?.stop();
  });

  const append = (db: PersistenceDatabase, tenant: TenantId, createdAt: string) =>
    withTenantTransaction(tenant, db, (tx) =>
      appendAuditEvent(tenant, tx, { auditId: randomUUID(), actorHash: ACTOR, action: "test.event", result: "SUCCESS", itemCount: 0, createdAt }),
    );
  const verify = (db: PersistenceDatabase, tenant: TenantId) => withTenantTransaction(tenant, db, (tx) => verifyAuditChainIntegrity(tenant, tx));

  /** Restores the current fixture database into a fresh database and returns a runtime connection to it. */
  const backupAndRestore = async () => {
    const name = `lus_restored_${process.pid}_${restoreCounter++}`;
    await pg.createDatabase(name);
    await pg.admin("postgres", `ALTER DATABASE ${name} OWNER TO lus_owner`);
    await pg.admin(name, "ALTER SCHEMA public OWNER TO lus_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
    pg.dumpRestore(fx.database, name);
    const runtime = createPostgresDatabase({ connectionString: pg.url(name, "lus_runtime"), tlsMode: "require", maxConnections: 2 });
    opened.push(runtime);
    return { name, runtime, admin: (sql: string) => pg.admin(name, sql) };
  };

  beforeEach(async () => {
    await fx?.close();
    fx = await createPgFixture(pg);
    // Source state: queue rows (one acknowledged), an audit chain that has been pruned once (anchor present).
    const store = createDurablePendingVoucherEventStore({ db: fx.runtime(), tenantId: fx.tenantA, keyring, now: () => new Date("2027-03-01T00:00:00.000Z") });
    await store.enqueue({ resourceId: "voucher-1", eventDate: "2027-03-01T00:00:00.000Z", payloadChecksum: CHECKSUM });
    await store.enqueue({ resourceId: "voucher-2", eventDate: "2027-03-01T00:00:00.000Z", payloadChecksum: CHECKSUM });
    await store.acknowledge("voucher-1");
    await append(fx.runtime(), fx.tenantA, "2026-02-01T00:00:00.000Z");
    await runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantA, actorHash: ACTOR, now: () => new Date("2027-03-01T00:00:00.000Z") });
    await append(fx.runtime(), fx.tenantA, "2027-03-02T00:00:00.000Z");
  }, 60_000);

  it("a faithful restore matches the source manifest, verifies, and keeps the retention anchor", async () => {
    const source = await captureRestoreVerificationManifest(fx.runtime(), fx.tenantA);
    expect(source.auditAnchorHash).not.toBeNull();
    expect(source.webhookCount).toBe(2);
    const restored = await backupAndRestore();
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).resolves.toEqual(source);
    await expect(verify(restored.runtime, fx.tenantA)).resolves.toMatchObject({ count: 2, anchorHash: source.auditAnchorHash, headHash: source.auditHeadHash });
    // The other tenant is restored too and stays independently verifiable.
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantB)).resolves.toMatchObject({ auditCount: 1 });
  });

  it("the restored chain continues at the next append position (no reuse of a position)", async () => {
    const before = await verify(fx.runtime(), fx.tenantA);
    const restored = await backupAndRestore();
    const next = await append(restored.runtime, fx.tenantA, "2027-03-03T00:00:00.000Z");
    expect(next.chainSeq).toBe(before.headSeq + 1);
    expect(next.previousHash).toBe(before.headHash);
    await expect(verify(restored.runtime, fx.tenantA)).resolves.toMatchObject({ count: 3 });
  });

  it("a stale backup (source changed after the dump) is detected", async () => {
    const restored = await backupAndRestore();
    await append(fx.runtime(), fx.tenantA, "2027-03-04T00:00:00.000Z");
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/Restore verification failed: .*auditCount/);
  });

  it("a restore that lost the newest audit entry is detected even though the shortened chain still verifies", async () => {
    const restored = await backupAndRestore();
    await restored.admin(`DELETE FROM audit_events WHERE tenant_id = '${fx.tenantA}' AND chain_seq = (SELECT max(chain_seq) FROM audit_events WHERE tenant_id = '${fx.tenantA}')`);
    await expect(verify(restored.runtime, fx.tenantA)).resolves.toMatchObject({ count: 1 });
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/auditCount.*auditHeadHash|auditHeadHash/);
  });

  it("a restore with a reverted acknowledgement is detected", async () => {
    const restored = await backupAndRestore();
    await restored.admin(`UPDATE webhook_events SET acknowledged_at = NULL WHERE tenant_id = '${fx.tenantA}'`);
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/Restore verification failed: webhookDigest\./);
  });

  it("a restore with a modified audit entry fails the integrity check", async () => {
    const restored = await backupAndRestore();
    await restored.admin(`UPDATE audit_events SET item_count = item_count + 1 WHERE tenant_id = '${fx.tenantA}' AND chain_seq = (SELECT max(chain_seq) FROM audit_events WHERE tenant_id = '${fx.tenantA}')`);
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/integrity/i);
  });

  it("a restore without the retention anchor fails the integrity check", async () => {
    const restored = await backupAndRestore();
    await restored.admin(`DELETE FROM audit_retention_anchors WHERE tenant_id = '${fx.tenantA}'`);
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/integrity/i);
    await expect(verify(restored.runtime, fx.tenantA)).rejects.toThrow(/integrity/i);
  });

  it.each([
    ["raised tenant storage limits", (t: string) => `UPDATE tenants SET max_webhook_events = 100000, max_persistence_bytes = 1073741824 WHERE tenant_id = '${t}'`, /tenantBindingDigest/],
    ["a moved webhook event date", (t: string) => `UPDATE webhook_events SET event_date = event_date + interval '400 days' WHERE tenant_id = '${t}'`, /webhookDigest/],
    ["a zeroed ciphertext auth tag", (t: string) => `UPDATE webhook_events SET resource_auth_tag = decode(repeat('00', 16), 'hex') WHERE tenant_id = '${t}'`, /webhookDigest/],
    ["a changed quality status", (t: string) => `UPDATE webhook_events SET quality_status = 'UNVERIFIED' WHERE tenant_id = '${t}'`, /webhookDigest/],
    ["a dropped append guard", () => "DROP TRIGGER audit_events_append_guard ON audit_events", /schema safety verification failed: .*APPEND_GUARD/],
    ["row-level security disabled", () => "ALTER TABLE webhook_events DISABLE ROW LEVEL SECURITY", /schema safety verification failed: RLS_NOT_FORCED/],
    ["a policy replaced by USING (true)", () => "DROP POLICY tenant_isolation_audit_events ON audit_events; CREATE POLICY tenant_isolation_audit_events ON audit_events USING (true) WITH CHECK (true)", /schema safety verification failed: RLS_POLICY/],
    ["dropped guard indexes", () => "DROP INDEX audit_events_tenant_chain_seq_uniq; DROP INDEX audit_events_tenant_previous_hash_uniq", /SEQ_INDEX,PREDECESSOR_INDEX/],
    ["a replaced guard body", () => "CREATE OR REPLACE FUNCTION public.audit_events_append_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$BEGIN RETURN NEW; END$$", /APPEND_GUARD/],
    ["an extra trigger", () => "CREATE FUNCTION public.zz_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER zz_noop BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.zz_noop()", /EXTRA_TRIGGER/],
    ["a rule", () => "CREATE RULE swallow AS ON INSERT TO audit_events DO INSTEAD NOTHING", /RULE/],
    ["an UNLOGGED table", () => "ALTER TABLE audit_events SET UNLOGGED", /NOT_PERMANENT/],
    ["received_at shifted by 400 microseconds", (t: string) => `UPDATE webhook_events SET received_at = received_at + interval '400 microseconds' WHERE tenant_id = '${t}'`, /webhookDigest/],
    ["acknowledged_at shifted by 400 microseconds", (t: string) => `UPDATE webhook_events SET acknowledged_at = acknowledged_at + interval '400 microseconds' WHERE tenant_id = '${t}' AND acknowledged_at IS NOT NULL`, /webhookDigest/],
    ["an audit created_at shifted by 400 microseconds", (t: string) => `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_guard; UPDATE audit_events SET created_at = created_at + interval '400 microseconds' WHERE tenant_id = '${t}'; ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_guard`, /auditDigest/],
  ])("a restore with %s is detected", async (_label, tamper, expected) => {
    const restored = await backupAndRestore();
    await restored.admin(tamper(fx.tenantA));
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(expected);
  });

  it("a moved anchor position is detected", async () => {
    const restored = await backupAndRestore();
    await restored.admin(`UPDATE audit_retention_anchors SET last_pruned_seq = last_pruned_seq + 1000 WHERE tenant_id = '${fx.tenantA}'`);
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/integrity/i);
  });

  it("a restore with an incomplete migration ledger is refused", async () => {
    const restored = await backupAndRestore();
    await restored.admin("DELETE FROM schema_migrations WHERE version = 10");
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).rejects.toThrow(/pending migrations/);
  });
  /**
   * C-03: database-wide verification through a dedicated read-only verifier role that bypasses row-level security
   * (provisioned like an operator would: LOGIN, BYPASSRLS, SELECT only, no ownership).
   */
  const verifierFor = async (database: string) => {
    await pg.admin(
      "postgres",
      "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lus_restore_verifier') THEN CREATE ROLE lus_restore_verifier LOGIN BYPASSRLS; END IF; END$$",
    );
    await pg.admin(database, "GRANT USAGE ON SCHEMA public TO lus_restore_verifier; GRANT SELECT ON ALL TABLES IN SCHEMA public TO lus_restore_verifier");
    const db = createPostgresDatabase({ connectionString: pg.url(database, "lus_restore_verifier"), tlsMode: "require", maxConnections: 1 });
    opened.push(db);
    return db;
  };

  it("C-03: a faithful restore passes the database-wide verification (all tenants, bindings, row counts)", async () => {
    const source = await verifierFor(fx.database);
    const restored = await backupAndRestore();
    const target = await verifierFor(restored.name);
    const manifest = await verifyRestoredDatabaseComplete(source, target);
    expect(manifest.tenantCount).toBe(2);
    expect(manifest.tenants.map((t) => t.tenantId).sort()).toEqual([fx.tenantA, fx.tenantB].sort());
  });

  it.each([
    ["tenant B deleted (cascading its rows)", () => `DELETE FROM tenants WHERE tenant_id = '${fx.tenantB}'`, /completeness verification failed: .*tenantCount.*tenantSetDigest/],
    ["an additional, unauthorised tenant", () => `INSERT INTO tenants (tenant_id, organization_id_hash, status) VALUES ('${randomUUID()}', '${"6".repeat(64)}', 'active')`, /completeness verification failed: .*tenantSetDigest/],
    ["tenant B's organisation binding changed", () => `UPDATE tenants SET organization_id_hash = '${"7".repeat(64)}' WHERE tenant_id = '${fx.tenantB}'`, /Restore verification failed: tenantBindingDigest/],
    ["tenant B's audit entry altered", () => `UPDATE audit_events SET item_count = item_count + 1 WHERE tenant_id = '${fx.tenantB}'`, /integrity/i],
    ["a runtime binding removed", () => `DELETE FROM tenant_runtime_bindings WHERE tenant_id = '${fx.tenantB}'`, /completeness verification failed: .*runtimeBindingDigest/],
    ["a runtime binding added for another role", () => `INSERT INTO tenant_runtime_bindings (role_name, tenant_id) VALUES ('lus_intruder', '${fx.tenantA}')`, /completeness verification failed: .*runtimeBindingDigest/],
  ])("C-03: a restore with %s is detected although the tenant-A manifest still matches", async (_label, tamper, expected) => {
    const source = await verifierFor(fx.database);
    const restored = await backupAndRestore();
    await restored.admin(tamper());
    // The old tenant-scoped check alone does not notice (this is the gap C-03 describes) ...
    await expect(verifyRestoredDatabase(fx.runtime(), restored.runtime, fx.tenantA)).resolves.toMatchObject({ tenantId: fx.tenantA });
    // ... the database-wide verification does.
    const target = await verifierFor(restored.name);
    await expect(verifyRestoredDatabaseComplete(source, target)).rejects.toThrow(expected);
  });

  it("C-03: completeness verification refuses a role that cannot see every tenant (no partial view reported as complete)", async () => {
    await expect(captureCompleteRestoreManifest(fx.runtime())).rejects.toThrow(/bypasses row-level security/);
    await expect(captureCompleteRestoreManifest(fx.runtimeMaintenance())).rejects.toThrow(/bypasses row-level security/);
  });
});
