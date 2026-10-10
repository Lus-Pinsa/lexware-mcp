import { describe, expect, it, vi } from "vitest";
import {
  deleteExpiredAcknowledgedWebhookEvents,
  deleteExpiredAuditEvents,
  deleteTenantData,
} from "../src/persistence/maintenance-repository.js";
import type { SqlExecutor } from "../src/persistence/repository.js";
import { sha256Hex } from "../src/persistence/crypto.js";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");

describe("persistence maintenance repository", () => {
  it("deletes only acknowledged webhook rows older than the fixed cutoff input", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 4 });
    const tx = { query } as unknown as SqlExecutor;

    await expect(
      deleteExpiredAcknowledgedWebhookEvents(
        TENANT,
        tx,
        "2026-09-09T08:00:00.000Z",
      ),
    ).resolves.toBe(4);

    expect(query.mock.calls[0][0].text).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[0][0].text).not.toContain("FOR UPDATE");
    expect(query.mock.calls[1][0].text).toContain("acknowledged_at IS NOT NULL");
    expect(query.mock.calls[1][0].text).toContain("acknowledged_at < $2");
    expect(query.mock.calls[1][0].values).toEqual([
      TENANT,
      "2026-09-09T08:00:00.000Z",
    ]);
  });

  it("verifies the full chain and its deletion boundary before advancing the anchor", async () => {
    const input = {
      auditId: "00000000-0000-4000-8000-0000000000c1",
      tenantId: TENANT,
      actorHash: sha256Hex("synthetic-maintenance-actor"),
      action: "tenant.create",
      result: "SUCCESS",
      itemCount: 1,
      createdAt: "2025-09-09T08:00:00.000Z",
      previousHash: null,
    };
    const anchorHash = computeAuditEntryHash(input);
    const stored = {
      audit_id: input.auditId, tenant_id: TENANT, actor_hash: input.actorHash,
      action: input.action, result: input.result, item_count: input.itemCount,
      created_at: input.createdAt, previous_hash: null, entry_hash: anchorHash,
    };
    const query = vi.fn(async (statement: { text: string }) => {
      if (statement.text.includes("pg_advisory_xact_lock")) return { rows: [{ tenant_id: TENANT }], rowCount: 1 };
      if (statement.text.includes("SELECT entry_hash FROM audit_events")) return { rows: [{ entry_hash: anchorHash }], rowCount: 1 };
      if (statement.text.includes("SELECT previous_hash FROM audit_retention_anchors")) return { rows: [], rowCount: 0 };
      if (statement.text.includes("SELECT audit_id, tenant_id")) return { rows: [stored], rowCount: 1 };
      if (statement.text.includes("SELECT previous_hash FROM audit_events")) return { rows: [], rowCount: 0 };
      if (statement.text.includes("INSERT INTO audit_retention_anchors")) return { rows: [], rowCount: 1 };
      if (statement.text.includes("DELETE FROM audit_events")) return { rows: [], rowCount: 1 };
      throw new Error("Unexpected SQL: " + statement.text);
    });
    const tx = { query } as unknown as SqlExecutor;

    await expect(deleteExpiredAuditEvents(
      TENANT, tx, "2025-10-09T08:00:00.000Z", "2026-10-09T08:00:00.000Z",
    )).resolves.toBe(1);

    const calls = query.mock.calls.map(([q]) => q.text);
    expect(calls.findIndex((x) => x.includes("SELECT audit_id, tenant_id"))).toBeLessThan(
      calls.findIndex((x) => x.includes("INSERT INTO audit_retention_anchors")),
    );
    expect(calls.findIndex((x) => x.includes("SELECT previous_hash FROM audit_events"))).toBeLessThan(
      calls.findIndex((x) => x.includes("DELETE FROM audit_events")),
    );
  });

  it("refuses a retention cutoff that removes a middle entry", async () => {
    const actorHash = sha256Hex("synthetic-actor");
    const first = {
      auditId: "00000000-0000-4000-8000-0000000000c1",
      tenantId: TENANT, actorHash, action: "tenant.create", result: "SUCCESS",
      itemCount: 1, createdAt: "2025-09-01T00:00:00.000Z", previousHash: null,
    };
    const firstHash = computeAuditEntryHash(first);
    const second = {
      ...first, auditId: "00000000-0000-4000-8000-0000000000c2",
      createdAt: "2025-11-01T00:00:00.000Z", previousHash: firstHash,
    };
    const secondHash = computeAuditEntryHash(second);
    const third = {
      ...first, auditId: "00000000-0000-4000-8000-0000000000c3",
      createdAt: "2025-09-03T00:00:00.000Z", previousHash: secondHash,
    };
    const stored = [first, second, third].map((e) => ({
      audit_id: e.auditId, tenant_id: TENANT, actor_hash: actorHash,
      action: e.action, result: e.result, item_count: e.itemCount,
      created_at: e.createdAt, previous_hash: e.previousHash,
      entry_hash: computeAuditEntryHash(e),
    }));
    // DB timestamp ordering puts the third hash-chain event before the second.
    const query = vi.fn(async (statement: { text: string }) => {
      if (statement.text.includes("pg_advisory_xact_lock")) return { rows: [{ tenant_id: TENANT }], rowCount: 1 };
      if (statement.text.includes("SELECT entry_hash FROM audit_events")) return { rows: [{ entry_hash: stored[2].entry_hash }], rowCount: 1 };
      if (statement.text.includes("SELECT previous_hash FROM audit_retention_anchors")) return { rows: [], rowCount: 0 };
      if (statement.text.includes("SELECT audit_id, tenant_id")) return { rows: [stored[0], stored[2], stored[1]], rowCount: 3 };
      throw new Error("Unexpected mutation or SQL: " + statement.text);
    });
    await expect(deleteExpiredAuditEvents(
      TENANT, { query } as unknown as SqlExecutor,
      "2025-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z",
    )).rejects.toThrow(/Audit chain integrity check failed/);
    expect(query.mock.calls.every(([q]) => !q.text.startsWith("DELETE") && !q.text.startsWith("INSERT"))).toBe(true);
  });

  it("does not mutate an anchor when no audit rows are expired", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const tx = { query } as unknown as SqlExecutor;
    await expect(
      deleteExpiredAuditEvents(
        TENANT,
        tx,
        "2025-10-09T08:00:00.000Z",
        "2026-10-09T08:00:00.000Z",
      ),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("tenant deletion is exact, tenant-bound and parameterized", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const tx = { query } as unknown as SqlExecutor;
    await expect(deleteTenantData(TENANT, tx)).resolves.toBeUndefined();
    expect(query.mock.calls[1][0]).toEqual({
      text: "DELETE FROM tenants WHERE tenant_id = $1",
      values: [TENANT],
    });
    expect(query.mock.calls[1][0].text).not.toContain(TENANT);
  });

  it("fails closed for malformed retention timestamps before mutation", async () => {
    const query = vi.fn();
    const tx = { query } as unknown as SqlExecutor;
    await expect(
      deleteExpiredAcknowledgedWebhookEvents(TENANT, tx, "not-a-date"),
    ).rejects.toThrow(/Invalid webhook retention cutoff/);
    expect(query).not.toHaveBeenCalled();
  });
});
