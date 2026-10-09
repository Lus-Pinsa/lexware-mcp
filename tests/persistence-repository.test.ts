import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeWebhookEvent,
  appendAuditEvent,
  getTenantBinding,
  insertWebhookEvent,
  inspectRuntimePrivileges,
  listAppliedSchemaMigrations,
  listPendingWebhookEvents,
  type PersistenceDatabase,
  type QueryResult,
  type SqlExecutor,
  withTenantTransaction,
} from "../src/persistence/repository.js";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import { createEncryptionKeyring, encryptField, sha256Hex } from "../src/persistence/crypto.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const OTHER = parseTenantId("00000000-0000-4000-8000-0000000000bb");

function executor(rows: readonly unknown[] = [], rowCount = rows.length) {
  const query = vi.fn(async () => ({ rows, rowCount }) as QueryResult<never>);
  return { query } as unknown as SqlExecutor & { query: typeof query };
}

describe("tenant-scoped persistence repository", () => {
  it("sets app.tenant_id inside the same pinned transaction before work runs", async () => {
    const tx = executor();
    const transaction = vi.fn(async (work: (inner: SqlExecutor) => Promise<string>) => work(tx));
    const db = { transaction } as PersistenceDatabase;
    const result = await withTenantTransaction(TENANT, db, async (inner) => {
      expect(inner).toBe(tx);
      expect(tx.query).toHaveBeenCalledTimes(1);
      expect(tx.query.mock.calls[0][0]).toEqual({
        text: "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
        values: [TENANT],
      });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("fails before opening a transaction for an invalid tenant id", async () => {
    const transaction = vi.fn();
    await expect(
      withTenantTransaction("not-a-tenant" as never, { transaction } as PersistenceDatabase, async () => "x"),
    ).rejects.toThrow(/tenant/i);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reads runtime privilege facts without exposing credentials or dynamic identifiers", async () => {
    const row = {
      role_name: "lus_runtime",
      is_superuser: false,
      bypass_rls: false,
      can_create_database: false,
      can_create_role: false,
      can_create_in_database: false,
      can_create_in_public_schema: false,
      migrations_select: true,
      migrations_mutate: false,
      tenants_select: true,
      tenants_mutate: false,
      webhook_dml: true,
      webhook_delete: false,
      audit_append: true,
      audit_mutate: false,
      audit_anchor_select: true,
      audit_anchor_mutate: false,
      role_memberships: 0,
    };
    const tx = executor([row]);
    await expect(inspectRuntimePrivileges(tx)).resolves.toEqual({
      roleName: "lus_runtime",
      isSuperuser: false,
      bypassRls: false,
      canCreateDatabase: false,
      canCreateRole: false,
      canCreateInDatabase: false,
      canCreateInPublicSchema: false,
      migrationsSelect: true,
      migrationsMutate: false,
      tenantsSelect: true,
      tenantsMutate: false,
      webhookDml: true,
      webhookDelete: false,
      auditAppend: true,
      auditMutate: false,
      auditAnchorSelect: true,
      auditAnchorMutate: false,
      roleMemberships: 0,
    });
    expect(tx.query.mock.calls[0][0].values).toEqual([]);
    expect(tx.query.mock.calls[0][0].text).toContain("has_table_privilege");
    expect(tx.query.mock.calls[0][0].text).not.toContain("PERSISTENCE_DATABASE_URL");
  });

  it("reads and validates the schema migration ledger without tenant fallback", async () => {
    const tx = executor([
      { version: 1, name: "foundation", checksum: sha256Hex("m1") },
      { version: 2, name: "webhook_event_date", checksum: sha256Hex("m2") },
    ]);
    await expect(listAppliedSchemaMigrations(tx)).resolves.toEqual([
      { version: 1, name: "foundation", checksum: sha256Hex("m1") },
      { version: 2, name: "webhook_event_date", checksum: sha256Hex("m2") },
    ]);
    expect(tx.query.mock.calls[0][0].values).toEqual([]);
  });

  it("reads a tenant binding only by the explicit tenant id", async () => {
    const orgHash = sha256Hex("synthetic-org");
    const tx = executor([{
      tenant_id: TENANT,
      organization_id_hash: orgHash,
      status: "active",
      capability_tier: "read_only",
    }]);
    const result = await getTenantBinding(TENANT, tx);
    expect(result).toEqual({
      tenantId: TENANT,
      organizationIdHash: orgHash,
      status: "active",
      capabilityTier: "read_only",
    });
    expect(tx.query.mock.calls[0][0].values).toEqual([TENANT]);
  });

  it("inserts a webhook idempotently with tenant id as parameter 1 and no raw resource id", async () => {
    const tx = executor([], 1);
    const ring = createEncryptionKeyring({ k1: Buffer.alloc(32, 7) }, "k1");
    const eventKeyHash = sha256Hex("event-key");
    const payloadChecksum = sha256Hex("payload");
    const rawResource = "TEST-RESOURCE-RAW";
    const resource = encryptField(ring, rawResource, {
      tenantId: TENANT,
      table: "webhook_events",
      field: "resource_id",
      recordId: eventKeyHash,
    });

    const result = await insertWebhookEvent(TENANT, tx, {
      eventKeyHash,
      eventType: "voucher.created",
      resource,
      eventDate: "2026-10-08T16:59:00.000Z",
      receivedAt: "2026-10-08T17:00:00.000Z",
      payloadChecksum,
      source: "lexware_webhook",
      requestBudgetStatus: "NOT_APPLICABLE",
      qualityStatus: "STRUCTURED",
    });

    expect(result.inserted).toBe(true);
    const call = tx.query.mock.calls[0][0];
    expect(call.values[0]).toBe(TENANT);
    expect(call.values).not.toContain(rawResource);
    expect(JSON.stringify(call.values)).not.toContain(rawResource);
  });

  it("maps a duplicate insert to inserted=false without inventing a second event", async () => {
    const tx = executor([], 0);
    const ring = createEncryptionKeyring({ k1: Buffer.alloc(32, 7) }, "k1");
    const eventKeyHash = sha256Hex("event-key");
    const result = await insertWebhookEvent(TENANT, tx, {
      eventKeyHash,
      eventType: "voucher.created",
      resource: encryptField(ring, "resource", {
        tenantId: TENANT,
        table: "webhook_events",
        field: "resource_id",
        recordId: eventKeyHash,
      }),
      eventDate: "2026-10-08T16:59:00Z",
      receivedAt: "2026-10-08T17:00:00Z",
      payloadChecksum: sha256Hex("payload"),
      source: "lexware_webhook",
      requestBudgetStatus: "NOT_APPLICABLE",
      qualityStatus: "STRUCTURED",
    });
    expect(result).toEqual({ inserted: false });
  });

  it("lists and acknowledges only within the explicit tenant", async () => {
    const hash = sha256Hex("event-key");
    const listTx = executor([
      {
        tenant_id: TENANT,
        event_key_hash: hash,
        event_type: "voucher.created",
        resource_ciphertext: new Uint8Array([1, 2]),
        resource_nonce: new Uint8Array(12),
        resource_auth_tag: new Uint8Array(16),
        key_id: "k1",
        event_date: "2026-10-08T16:59:00Z",
        received_at: "2026-10-08T17:00:00Z",
        payload_checksum: sha256Hex("payload"),
        source: "lexware_webhook",
        request_budget_status: "NOT_APPLICABLE",
        quality_status: "STRUCTURED",
      },
    ]);
    const rows = await listPendingWebhookEvents(TENANT, listTx, 25);
    expect(rows).toHaveLength(1);
    expect(listTx.query.mock.calls[0][0].values).toEqual([TENANT, 25]);

    const ackTx = executor([], 1);
    expect(await acknowledgeWebhookEvent(TENANT, ackTx, hash, "2026-10-08T18:00:00Z")).toEqual({
      acknowledged: true,
    });
    expect(ackTx.query.mock.calls[0][0].values).toEqual([TENANT, hash, "2026-10-08T18:00:00Z"]);

    expect(listTx.query.mock.calls[0][0].values).not.toContain(OTHER);
    expect(ackTx.query.mock.calls[0][0].values).not.toContain(OTHER);
  });

  it("rejects a cross-tenant row even if a broken driver/DB returned it", async () => {
    const hash = sha256Hex("event-key");
    const tx = executor([
      {
        tenant_id: OTHER,
        event_key_hash: hash,
        event_type: "voucher.created",
        resource_ciphertext: new Uint8Array([1]),
        resource_nonce: new Uint8Array(12),
        resource_auth_tag: new Uint8Array(16),
        key_id: "k1",
        event_date: "2026-10-08T16:59:00Z",
        received_at: "2026-10-08T17:00:00Z",
        payload_checksum: sha256Hex("payload"),
        source: "lexware_webhook",
        request_budget_status: "NOT_APPLICABLE",
        quality_status: "STRUCTURED",
      },
    ]);
    await expect(listPendingWebhookEvents(TENANT, tx)).rejects.toThrow(/Cross-tenant/);
  });

  it("rejects malformed encrypted input before touching the database", async () => {
    const tx = executor([], 1);
    await expect(
      insertWebhookEvent(TENANT, tx, {
        eventKeyHash: sha256Hex("event-key"),
        eventType: "voucher.created",
        resource: { ciphertext: new Uint8Array(), nonce: new Uint8Array(12), authTag: new Uint8Array(16), keyId: "k1" },
        eventDate: "2026-10-08T16:59:00Z",
        receivedAt: "2026-10-08T17:00:00Z",
        payloadChecksum: sha256Hex("payload"),
        source: "lexware_webhook",
        requestBudgetStatus: "NOT_APPLICABLE",
        qualityStatus: "STRUCTURED",
      }),
    ).rejects.toThrow(/ciphertext size/);
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("serializes audit chaining through the tenant row and inserts only an append", async () => {
    const previousHash = sha256Hex("previous-audit");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ entry_hash: previousHash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          max_webhook_events: 10_000,
          max_audit_events: 100_000,
          max_persistence_bytes: 67_108_864,
          webhook_events: 0,
          audit_events: 1,
          persistence_bytes: 512,
        }],
        rowCount: 1,
      });
    const tx = { query } as unknown as SqlExecutor;

    const input = {
      auditId: "00000000-0000-4000-8000-0000000000c1",
      actorHash: sha256Hex("synthetic-actor"),
      action: "webhook.accept",
      result: "SUCCESS",
      itemCount: 1,
      createdAt: "2026-10-08T19:00:00Z",
    };

    const result = await appendAuditEvent(TENANT, tx, input);
    expect(result.previousHash).toBe(previousHash);
    expect(result.entryHash).toBe(
      computeAuditEntryHash({ ...input, tenantId: TENANT, previousHash }),
    );

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0].text).toContain("FOR UPDATE");
    expect(query.mock.calls[0][0].values).toEqual([TENANT]);
    expect(query.mock.calls[2][0].text).toContain("INSERT INTO audit_events");
    expect(query.mock.calls[2][0].text).not.toMatch(/UPDATE audit_events|DELETE FROM audit_events/);
    expect(query.mock.calls[2][0].values[1]).toBe(TENANT);
    expect(query.mock.calls[2][0].values[7]).toBe(previousHash);
    expect(query.mock.calls[2][0].values[8]).toBe(result.entryHash);
  });

  it("continues the audit chain from the retention anchor when no retained rows remain", async () => {
    const anchorHash = sha256Hex("retained-anchor");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ previous_hash: anchorHash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          max_webhook_events: 10_000,
          max_audit_events: 100_000,
          max_persistence_bytes: 67_108_864,
          webhook_events: 0,
          audit_events: 1,
          persistence_bytes: 512,
        }],
        rowCount: 1,
      });
    const tx = { query } as unknown as SqlExecutor;

    const input = {
      auditId: "00000000-0000-4000-8000-0000000000c2",
      actorHash: sha256Hex("synthetic-actor"),
      action: "retention.run",
      result: "SUCCESS",
      itemCount: 5,
      createdAt: "2026-10-09T08:00:00Z",
    };

    const result = await appendAuditEvent(TENANT, tx, input);
    expect(result.previousHash).toBe(anchorHash);
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[2][0].text).toContain("audit_retention_anchors");
    expect(query.mock.calls[3][0].values[7]).toBe(anchorHash);
  });

  it("fails closed when the tenant cannot be locked for an audit append", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const tx = { query } as unknown as SqlExecutor;
    await expect(
      appendAuditEvent(TENANT, tx, {
        auditId: "00000000-0000-4000-8000-0000000000c1",
        actorHash: sha256Hex("synthetic-actor"),
        action: "webhook.accept",
        result: "SUCCESS",
        itemCount: 1,
        createdAt: "2026-10-08T19:00:00Z",
      }),
    ).rejects.toThrow(/Tenant unavailable/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbounded pending-event request", async () => {
    const tx = executor();
    await expect(listPendingWebhookEvents(TENANT, tx, 1001)).rejects.toThrow(/1 to 1000/);
    expect(tx.query).not.toHaveBeenCalled();
  });
});
