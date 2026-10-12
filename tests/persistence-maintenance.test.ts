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

  /** A synthetic chain (append order = array order) and a stateful executor that behaves like the tables. */
  function chain(createdAts: readonly string[]) {
    const actorHash = sha256Hex("synthetic-maintenance-actor");
    let previousHash: string | null = null;
    const rows = createdAts.map((createdAt, i) => {
      const entry = {
        auditId: `00000000-0000-4000-8000-0000000000${(0xc0 + i).toString(16)}`,
        tenantId: TENANT, actorHash, action: "test.event", result: "SUCCESS", itemCount: 1,
        createdAt, previousHash, chainSeq: i + 1,
      };
      const entryHash = computeAuditEntryHash(entry);
      previousHash = entryHash;
      return {
        audit_id: entry.auditId, tenant_id: TENANT, actor_hash: actorHash, action: entry.action, result: entry.result,
        item_count: entry.itemCount, created_at: createdAt, previous_hash: entry.previousHash, entry_hash: entryHash,
        chain_seq: String(entry.chainSeq), chain_version: 2,
      };
    });
    return rows;
  }

  function tables(initial: ReturnType<typeof chain>, opts: { deleteCountOverride?: number; returnRows?: (rows: ReturnType<typeof chain>) => ReturnType<typeof chain> } = {}) {
    let rows = [...initial];
    let anchor: { previous_hash: string; last_pruned_seq: string } | null = null;
    const query = vi.fn(async (statement: { text: string; values: readonly unknown[] }) => {
      if (statement.text.includes("pg_advisory_xact_lock")) return { rows: [{ tenant_id: TENANT }], rowCount: 1 };
      if (statement.text.includes("FROM audit_retention_anchors")) return { rows: anchor ? [anchor] : [], rowCount: anchor ? 1 : 0 };
      if (statement.text.includes("SELECT audit_id, tenant_id")) {
        const out = opts.returnRows ? opts.returnRows(rows) : rows;
        return { rows: out, rowCount: out.length };
      }
      if (statement.text.startsWith("INSERT INTO audit_retention_anchors")) {
        anchor = { previous_hash: statement.values[1] as string, last_pruned_seq: String(statement.values[2]) };
        return { rows: [], rowCount: 1 };
      }
      if (statement.text.startsWith("DELETE FROM audit_events")) {
        expect(statement.text).toBe("DELETE FROM audit_events WHERE tenant_id = $1 AND chain_seq <= $2");
        const before = rows.length;
        rows = rows.filter((r) => Number(r.chain_seq) > (statement.values[1] as number));
        return { rows: [], rowCount: opts.deleteCountOverride ?? before - rows.length };
      }
      throw new Error("Unexpected SQL: " + statement.text);
    });
    return { query, tx: { query } as unknown as SqlExecutor, rows: () => rows, anchor: () => anchor };
  }

  it("verifies the chain, moves the anchor to the last pruned entry, deletes exactly that prefix and re-verifies", async () => {
    const stored = chain(["2025-09-01T00:00:00.000Z", "2025-09-02T00:00:00.000Z", "2025-12-01T00:00:00.000Z"]);
    const t = tables(stored);
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T08:00:00.000Z", "2026-10-09T08:00:00.000Z")).resolves.toBe(2);
    expect(t.anchor()).toEqual({ previous_hash: stored[1].entry_hash, last_pruned_seq: "2" });
    expect(t.rows().map((r) => r.chain_seq)).toEqual(["3"]);
    const calls = t.query.mock.calls.map(([q]) => q.text);
    const firstVerify = calls.findIndex((x) => x.includes("SELECT audit_id, tenant_id"));
    const anchorWrite = calls.findIndex((x) => x.startsWith("INSERT INTO audit_retention_anchors"));
    const deletion = calls.findIndex((x) => x.startsWith("DELETE FROM audit_events"));
    const reVerify = calls.findLastIndex((x) => x.includes("SELECT audit_id, tenant_id"));
    expect(firstVerify).toBeLessThan(anchorWrite);
    expect(anchorWrite).toBeLessThan(deletion);
    expect(deletion).toBeLessThan(reVerify);
  });

  it("stops at the first retained entry: a later, older (backdated) entry is not part of the prefix", async () => {
    const stored = chain(["2025-09-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", "2025-09-03T00:00:00.000Z"]);
    const t = tables(stored);
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).resolves.toBe(1);
    expect(t.rows().map((r) => r.chain_seq)).toEqual(["2", "3"]);
  });

  it("refuses to prune a chain whose positions are out of order, without any mutation", async () => {
    const stored = chain(["2025-09-01T00:00:00.000Z", "2025-09-02T00:00:00.000Z", "2025-09-03T00:00:00.000Z"]);
    const t = tables(stored, { returnRows: (rows) => [rows[0], rows[2], rows[1]] });
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).rejects.toThrow(/Audit chain integrity check failed/);
    expect(t.query.mock.calls.every(([q]) => !q.text.startsWith("DELETE") && !q.text.startsWith("INSERT"))).toBe(true);
  });

  it("does not mutate anything when the first entry is not expired", async () => {
    const stored = chain(["2025-12-01T00:00:00.000Z", "2025-09-01T00:00:00.000Z"]);
    const t = tables(stored);
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T08:00:00.000Z", "2026-10-09T08:00:00.000Z")).resolves.toBe(0);
    expect(t.query.mock.calls.every(([q]) => !q.text.startsWith("DELETE") && !q.text.startsWith("INSERT"))).toBe(true);
    expect(t.anchor()).toBeNull();
  });

  it("does not mutate anything for an empty chain", async () => {
    const t = tables([]);
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T08:00:00.000Z", "2026-10-09T08:00:00.000Z")).resolves.toBe(0);
    expect(t.query.mock.calls.every(([q]) => !q.text.startsWith("DELETE") && !q.text.startsWith("INSERT"))).toBe(true);
  });

  it("fails (and the caller rolls back) when the database deletes a different number of rows than verified", async () => {
    const stored = chain(["2025-09-01T00:00:00.000Z", "2025-09-02T00:00:00.000Z", "2025-12-01T00:00:00.000Z"]);
    const t = tables(stored, { deleteCountOverride: 1 });
    await expect(deleteExpiredAuditEvents(TENANT, t.tx, "2025-10-09T08:00:00.000Z", "2026-10-09T08:00:00.000Z")).rejects.toThrow(/unexpected number/);
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
