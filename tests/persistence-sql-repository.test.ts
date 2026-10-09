import { describe, expect, it } from "vitest";
import {
  SqlPersistenceMaintenanceRepository,
  SqlPersistenceRepository,
  SqlTenantDirectory,
} from "../src/persistence/sql-repository.js";
import type { SqlDatabase, SqlQueryResult, SqlSession } from "../src/persistence/sql.js";
import { asTenantId, type PersistedWebhookEvent } from "../src/persistence/types.js";

interface Call {
  text: string;
  params?: readonly unknown[];
}

function fakeDb(overrides?: {
  onQuery?: (text: string, params?: readonly unknown[]) => SqlQueryResult;
}): { db: SqlDatabase; calls: Call[] } {
  const calls: Call[] = [];
  const query = async (text: string, params?: readonly unknown[]): Promise<SqlQueryResult> => {
    calls.push({ text, params });
    if (text.includes("set_config")) return { rows: [], rowCount: 1 };
    return overrides?.onQuery?.(text, params) ?? { rows: [], rowCount: 1 };
  };
  const session: SqlSession = { query };
  const db: SqlDatabase = {
    query,
    async transaction(work) {
      calls.push({ text: "BEGIN" });
      const result = await work(session);
      calls.push({ text: "COMMIT" });
      return result;
    },
  };
  return { db, calls };
}

const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");

const event: Omit<PersistedWebhookEvent, "tenantId"> = {
  eventKeyHash: "a".repeat(64),
  organizationHash: "b".repeat(64),
  resourceIdCiphertext: "ciphertext",
  resourceIdNonce: "nonce",
  resourceIdAuthTag: "tag",
  resourceIdKeyId: "k1",
  eventType: "voucher.created",
  receivedAt: "2026-10-09T08:00:00.000Z",
  acknowledgedAt: null,
  payloadSha256: "c".repeat(64),
  source: "lexware-webhook",
  quality: "STRUCTURED",
  requestBudgetStatus: "OK",
};

describe("SQL tenant directory", () => {
  it("uses one parameterized global organization lookup", async () => {
    const { db, calls } = fakeDb({
      onQuery(text) {
        if (text.includes("FROM tenants")) {
          return { rows: [{ tenantId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const directory = new SqlTenantDirectory(db);
    await expect(directory.resolveOrganizationHash("d".repeat(64))).resolves.toEqual({ tenantId });
    const lookup = calls.find((call) => call.text.includes("FROM tenants"));
    expect(lookup?.text).toContain("organization_hash = $1");
    expect(lookup?.text).not.toContain("d".repeat(64));
    expect(lookup?.params).toEqual(["d".repeat(64)]);
  });
});

describe("SQL runtime persistence repository", () => {
  it("inserts webhook events inside tenant RLS context and deduplicates by row count", async () => {
    const { db, calls } = fakeDb();
    const repository = new SqlPersistenceRepository(db);
    await expect(repository.insertWebhookEvent(tenantId, event)).resolves.toBe("inserted");
    expect(calls[0]?.text).toBe("BEGIN");
    expect(calls[1]).toEqual({
      text: "SELECT set_config('app.tenant_id', $1, true)",
      params: [tenantId],
    });
    const insert = calls.find((call) => call.text.includes("INSERT INTO webhook_events"));
    expect(insert?.text).toContain("ON CONFLICT (tenant_id, event_key_hash) DO NOTHING");
    expect(insert?.text).not.toContain(event.eventKeyHash);
    expect(insert?.params?.[0]).toBe(tenantId);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("reports an exact duplicate without inventing a second event", async () => {
    const { db } = fakeDb({
      onQuery(text) {
        if (text.includes("INSERT INTO webhook_events")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
    });
    const repository = new SqlPersistenceRepository(db);
    await expect(repository.insertWebhookEvent(tenantId, event)).resolves.toBe("duplicate");
  });

  it("rejects an over-limit list before touching the database", async () => {
    const { db, calls } = fakeDb();
    const repository = new SqlPersistenceRepository(db);
    await expect(repository.listPendingWebhookEvents(tenantId, 1_001)).rejects.toThrow(/exceeded/);
    expect(calls).toEqual([]);
  });

  it("appends audit events under a locked per-tenant chain head", async () => {
    const { db, calls } = fakeDb({
      onQuery(text) {
        if (text.includes("FROM audit_chain_heads")) {
          return { rows: [{ currentHash: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    });
    const repository = new SqlPersistenceRepository(
      db,
      () => new Date("2026-10-09T08:00:00.000Z"),
    );
    await repository.appendAuditEvent(tenantId, {
      actorHash: "f".repeat(64),
      action: "INTEGRITY_FAILURE",
      result: "FAILED",
      count: 1,
    });

    const lock = calls.find((call) => call.text.includes("FROM audit_chain_heads"));
    expect(lock?.text).toContain("FOR UPDATE");
    const insert = calls.find((call) => call.text.includes("INSERT INTO audit_events"));
    expect(insert?.params?.[0]).toBe(tenantId);
    expect(insert?.params?.[6]).toBeNull();
    expect(insert?.params?.[7]).toMatch(/^[a-f0-9]{64}$/);
    const update = calls.find((call) => call.text.includes("UPDATE audit_chain_heads SET current_hash"));
    expect(update?.params?.[1]).toBe(insert?.params?.[7]);
  });

  it("fails closed if a tenant has no audit chain head", async () => {
    const { db } = fakeDb({
      onQuery(text) {
        if (text.includes("FROM audit_chain_heads")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
    });
    const repository = new SqlPersistenceRepository(db);
    await expect(
      repository.appendAuditEvent(tenantId, {
        actorHash: "f".repeat(64),
        action: "TENANT_MISMATCH",
        result: "DENIED",
        count: 1,
      }),
    ).rejects.toThrow(/head unavailable/);
  });
});

describe("SQL maintenance repository", () => {
  it("deletes only acknowledged webhook events older than the cutoff", async () => {
    const { db, calls } = fakeDb();
    const repository = new SqlPersistenceMaintenanceRepository(db);
    await expect(
      repository.deleteExpiredWebhookEvents(tenantId, "2026-09-09T08:00:00.000Z"),
    ).resolves.toBe(1);
    const deletion = calls.find((call) => call.text.includes("DELETE FROM webhook_events"));
    expect(deletion?.text).toContain("acknowledged_at IS NOT NULL");
    expect(deletion?.text).toContain("acknowledged_at < $2");
    expect(deletion?.params).toEqual([tenantId, "2026-09-09T08:00:00.000Z"]);
  });

  it("anchors the audit chain before retention deletion", async () => {
    const anchorHash = "e".repeat(64);
    const { db, calls } = fakeDb({
      onQuery(text) {
        if (text.includes('SELECT entry_hash AS "entryHash"')) {
          return { rows: [{ entryHash: anchorHash }], rowCount: 1 };
        }
        if (text.includes("DELETE FROM audit_events")) return { rows: [], rowCount: 4 };
        return { rows: [], rowCount: 1 };
      },
    });
    const repository = new SqlPersistenceMaintenanceRepository(db);
    await expect(
      repository.deleteExpiredAuditEvents(tenantId, "2025-10-09T08:00:00.000Z"),
    ).resolves.toBe(4);
    const anchorUpdateIndex = calls.findIndex((call) =>
      call.text.includes("SET retention_anchor_hash"),
    );
    const deleteIndex = calls.findIndex((call) => call.text.includes("DELETE FROM audit_events"));
    expect(anchorUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(anchorUpdateIndex);
    expect(calls[anchorUpdateIndex]?.params).toEqual([tenantId, anchorHash]);
  });

  it("tenant deletion is exact and parameterized", async () => {
    const { db, calls } = fakeDb();
    const repository = new SqlPersistenceMaintenanceRepository(db);
    await expect(repository.deleteTenantData(tenantId)).resolves.toBeUndefined();
    const deletion = calls.find((call) => call.text.includes("DELETE FROM tenants"));
    expect(deletion?.text).toBe("DELETE FROM tenants WHERE tenant_id = $1");
    expect(deletion?.params).toEqual([tenantId]);
    expect(deletion?.text).not.toContain(tenantId);
  });
});
