import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeWebhookEvent,
  getTenantBinding,
  insertWebhookEvent,
  listPendingWebhookEvents,
  type PersistenceDatabase,
  type QueryResult,
  type SqlExecutor,
  withTenantTransaction,
} from "../src/persistence/repository.js";
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

  it("reads a tenant binding only by the explicit tenant id", async () => {
    const orgHash = sha256Hex("synthetic-org");
    const tx = executor([{ tenant_id: TENANT, organization_id_hash: orgHash, status: "active" }]);
    const result = await getTenantBinding(TENANT, tx);
    expect(result).toEqual({ tenantId: TENANT, organizationIdHash: orgHash, status: "active" });
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
        receivedAt: "2026-10-08T17:00:00Z",
        payloadChecksum: sha256Hex("payload"),
        source: "lexware_webhook",
        requestBudgetStatus: "NOT_APPLICABLE",
        qualityStatus: "STRUCTURED",
      }),
    ).rejects.toThrow(/ciphertext size/);
    expect(tx.query).not.toHaveBeenCalled();
  });

  it("rejects an unbounded pending-event request", async () => {
    const tx = executor();
    await expect(listPendingWebhookEvents(TENANT, tx, 1001)).rejects.toThrow(/1 to 1000/);
    expect(tx.query).not.toHaveBeenCalled();
  });
});
