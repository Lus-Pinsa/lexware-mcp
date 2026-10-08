import { describe, expect, it, vi } from "vitest";
import { createEncryptionKeyring, sha256Hex } from "../src/persistence/crypto.js";
import {
  createDurablePendingVoucherEventStore,
  PendingVoucherCapacityError,
} from "../src/persistence/pending-voucher-store.js";
import type {
  PersistenceDatabase,
  QueryResult,
  SqlExecutor,
} from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const NOW = "2026-10-08T20:00:00.000Z";

type StoredRow = {
  tenant_id: string;
  event_key_hash: string;
  event_type: string;
  resource_ciphertext: Uint8Array;
  resource_nonce: Uint8Array;
  resource_auth_tag: Uint8Array;
  key_id: string;
  event_date: string;
  received_at: string;
  payload_checksum: string;
  source: string;
  request_budget_status: string;
  quality_status: string;
  acknowledged_at: string | null;
};

function fakeDb(options: { forcedCount?: number } = {}) {
  const rows = new Map<string, StoredRow>();
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];

  const transaction = vi.fn(async <T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
    const snapshot = new Map(rows);
    const tx: SqlExecutor = {
      async query<Row = Record<string, unknown>>(statement: {
        readonly text: string;
        readonly values: readonly unknown[];
      }): Promise<QueryResult<Row>> {
        calls.push(statement);

        if (statement.text.startsWith("SELECT set_config")) {
          return { rows: [{ tenant_id: TENANT }] as unknown as readonly Row[], rowCount: 1 };
        }
        if (statement.text.includes("FROM tenants") && statement.text.includes("FOR UPDATE")) {
          return { rows: [{ tenant_id: TENANT }] as unknown as readonly Row[], rowCount: 1 };
        }
        if (statement.text.startsWith("INSERT INTO webhook_events")) {
          const [
            tenantId,
            eventKeyHash,
            eventType,
            ciphertext,
            nonce,
            authTag,
            keyId,
            eventDate,
            receivedAt,
            payloadChecksum,
            source,
            requestBudgetStatus,
            qualityStatus,
          ] = statement.values;
          const key = String(eventKeyHash);
          if (rows.has(key)) return { rows: [] as readonly Row[], rowCount: 0 };
          rows.set(key, {
            tenant_id: String(tenantId),
            event_key_hash: key,
            event_type: String(eventType),
            resource_ciphertext: ciphertext as Uint8Array,
            resource_nonce: nonce as Uint8Array,
            resource_auth_tag: authTag as Uint8Array,
            key_id: String(keyId),
            event_date: String(eventDate),
            received_at: String(receivedAt),
            payload_checksum: String(payloadChecksum),
            source: String(source),
            request_budget_status: String(requestBudgetStatus),
            quality_status: String(qualityStatus),
            acknowledged_at: null,
          });
          return { rows: [] as readonly Row[], rowCount: 1 };
        }
        if (statement.text.startsWith("SELECT count(*)::int")) {
          const count =
            options.forcedCount ??
            [...rows.values()].filter((row) => row.acknowledged_at === null).length;
          return { rows: [{ count }] as unknown as readonly Row[], rowCount: 1 };
        }
        if (statement.text.startsWith("SELECT tenant_id, event_key_hash")) {
          const limit = Number(statement.values[1]);
          const pending = [...rows.values()]
            .filter((row) => row.acknowledged_at === null)
            .slice(0, limit)
            .map(({ acknowledged_at: _ignored, ...row }) => row);
          return { rows: pending as unknown as readonly Row[], rowCount: pending.length };
        }
        if (statement.text.startsWith("UPDATE webhook_events SET acknowledged_at")) {
          const eventKey = String(statement.values[1]);
          const row = rows.get(eventKey);
          if (row === undefined || row.acknowledged_at !== null) {
            return { rows: [] as readonly Row[], rowCount: 0 };
          }
          rows.set(eventKey, { ...row, acknowledged_at: String(statement.values[2]) });
          return { rows: [] as readonly Row[], rowCount: 1 };
        }
        throw new Error("unexpected query: " + statement.text);
      },
    };

    try {
      return await work(tx);
    } catch (error) {
      rows.clear();
      for (const [key, row] of snapshot) rows.set(key, row);
      throw error;
    }
  });

  return {
    db: { transaction } as PersistenceDatabase,
    rows,
    calls,
    transaction,
  };
}

function store(db: PersistenceDatabase) {
  return createDurablePendingVoucherEventStore({
    db,
    tenantId: TENANT,
    keyring: createEncryptionKeyring({ k1: Buffer.alloc(32, 7) }, "k1"),
    now: () => new Date(NOW),
  });
}

const event = {
  resourceId: "00000000-0000-4000-8000-0000000000c1",
  eventDate: "2026-10-08T19:59:00.000Z",
  payloadChecksum: sha256Hex("synthetic-payload"),
};

describe("durable pending voucher store", () => {
  it("persists encrypted resource ids, survives a new store instance, and preserves event metadata", async () => {
    const h = fakeDb();
    const first = store(h.db);

    await expect(first.enqueue(event)).resolves.toEqual({
      added: true,
      count: 1,
      dropped: 0,
    });

    const stored = [...h.rows.values()][0];
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(event.resourceId);
    expect(stored.event_date).toBe(event.eventDate);
    expect(stored.payload_checksum).toBe(event.payloadChecksum);

    const afterRestart = store(h.db);
    await expect(afterRestart.list()).resolves.toEqual([
      {
        eventType: "voucher.created",
        resourceId: event.resourceId,
        eventDate: event.eventDate,
        receivedAt: NOW,
      },
    ]);
  });

  it("deduplicates identical Lexware retries by deterministic event key", async () => {
    const h = fakeDb();
    const durable = store(h.db);
    await expect(durable.enqueue(event)).resolves.toMatchObject({ added: true, count: 1 });
    await expect(durable.enqueue(event)).resolves.toMatchObject({ added: false, count: 1 });
    expect(h.rows.size).toBe(1);
  });

  it("keeps distinct deliveries for the same resource when eventDate differs", async () => {
    const h = fakeDb();
    const durable = store(h.db);
    await durable.enqueue(event);
    await durable.enqueue({ ...event, eventDate: "2026-10-08T20:01:00.000Z" });
    expect((await durable.list()).map((row) => row.resourceId)).toEqual([
      event.resourceId,
      event.resourceId,
    ]);
  });

  it("acknowledges all pending events for a resource without deleting rows", async () => {
    const h = fakeDb();
    const durable = store(h.db);
    await durable.enqueue(event);
    await durable.enqueue({ ...event, eventDate: "2026-10-08T20:01:00.000Z" });

    await expect(durable.acknowledge(event.resourceId)).resolves.toEqual({
      removed: 2,
      remaining: 0,
    });
    await expect(durable.list()).resolves.toEqual([]);
    expect(h.rows.size).toBe(2);
    expect([...h.rows.values()].every((row) => row.acknowledged_at === NOW)).toBe(true);
  });

  it("rolls back a new event and fails closed instead of dropping old events when capacity is exceeded", async () => {
    const h = fakeDb({ forcedCount: 1001 });
    const durable = store(h.db);
    await expect(durable.enqueue(event)).rejects.toBeInstanceOf(PendingVoucherCapacityError);
    expect(h.rows.size).toBe(0);
  });

  it("rejects malformed checksum/resource/date before persistence", async () => {
    const h = fakeDb();
    const durable = store(h.db);

    await expect(
      durable.enqueue({ ...event, payloadChecksum: "not-a-hash" }),
    ).rejects.toThrow(/checksum/);
    await expect(
      durable.enqueue({ ...event, resourceId: "bad resource" }),
    ).rejects.toThrow(/resource id/);
    await expect(
      durable.enqueue({ ...event, eventDate: "2026-10-08" }),
    ).rejects.toThrow(/event date/);
    expect(h.rows.size).toBe(0);
  });
});
