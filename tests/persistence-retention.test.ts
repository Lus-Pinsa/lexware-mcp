import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/persistence/crypto.js";
import {
  AUDIT_RETENTION_YEARS,
  WEBHOOK_RETENTION_DAYS,
  retentionCutoffs,
  runTenantRetention,
} from "../src/persistence/retention.js";
import type {
  PersistenceDatabase,
  QueryResult,
  SqlExecutor,
} from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const ANCHOR = sha256Hex("expired-audit-anchor");

describe("persistence retention runner", () => {
  it("uses the approved 30-day webhook and one-calendar-year audit windows", () => {
    expect(WEBHOOK_RETENTION_DAYS).toBe(30);
    expect(AUDIT_RETENTION_YEARS).toBe(1);
    expect(retentionCutoffs(new Date("2026-10-09T08:00:00.000Z"))).toEqual({
      webhookBefore: "2026-09-09T08:00:00.000Z",
      auditBefore: "2025-10-09T08:00:00.000Z",
    });
  });

  it("clamps leap-day calendar-year retention safely", () => {
    expect(retentionCutoffs(new Date("2028-02-29T12:00:00.000Z")).auditBefore).toBe(
      "2027-02-28T12:00:00.000Z",
    );
  });

  it("runs retention atomically for one tenant and appends a content-free count audit", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];

    const query = vi.fn(async <Row = Record<string, unknown>>(statement: {
      readonly text: string;
      readonly values: readonly unknown[];
    }): Promise<QueryResult<Row>> => {
      calls.push(statement);

      if (statement.text.startsWith("SELECT set_config")) {
        return { rows: [] as readonly Row[], rowCount: 1 };
      }
      if (statement.text.includes("FROM tenants") && statement.text.includes("pg_advisory_xact_lock")) {
        return {
          rows: [{ tenant_id: TENANT }] as unknown as readonly Row[],
          rowCount: 1,
        };
      }
      if (statement.text.startsWith("DELETE FROM webhook_events")) {
        return { rows: [] as readonly Row[], rowCount: 2 };
      }
      if (statement.text.startsWith("SELECT entry_hash FROM audit_events") && statement.text.includes("created_at <")) {
        return {
          rows: [{ entry_hash: ANCHOR }] as unknown as readonly Row[],
          rowCount: 1,
        };
      }
      if (statement.text.startsWith("INSERT INTO audit_retention_anchors")) {
        return { rows: [] as readonly Row[], rowCount: 1 };
      }
      if (statement.text.startsWith("DELETE FROM audit_events")) {
        return { rows: [] as readonly Row[], rowCount: 3 };
      }
      if (statement.text.startsWith("SELECT entry_hash FROM audit_events")) {
        return { rows: [] as readonly Row[], rowCount: 0 };
      }
      if (statement.text.startsWith("SELECT previous_hash FROM audit_retention_anchors")) {
        return {
          rows: [{ previous_hash: ANCHOR }] as unknown as readonly Row[],
          rowCount: 1,
        };
      }
      if (statement.text.startsWith("INSERT INTO audit_events")) {
        return { rows: [] as readonly Row[], rowCount: 1 };
      }
      if (statement.text.startsWith("SELECT t.max_webhook_events")) {
        return {
          rows: [{
            max_webhook_events: 10_000,
            max_audit_events: 100_000,
            max_persistence_bytes: 67_108_864,
            webhook_events: 0,
            audit_events: 1,
            persistence_bytes: 512,
          }] as unknown as readonly Row[],
          rowCount: 1,
        };
      }

      throw new Error("unexpected query: " + statement.text);
    });

    const tx = { query } as unknown as SqlExecutor;
    const transaction = vi.fn(async <T>(work: (inner: SqlExecutor) => Promise<T>) => work(tx));
    const db = { transaction } as PersistenceDatabase;

    await expect(
      runTenantRetention({
        db,
        tenantId: TENANT,
        actorHash: sha256Hex("system-retention"),
        now: () => new Date("2026-10-09T08:00:00.000Z"),
        makeAuditId: () => "00000000-0000-4000-8000-0000000000c3",
      }),
    ).resolves.toEqual({ webhookDeleted: 2, auditDeleted: 3 });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      text: "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      values: [TENANT],
    });

    const auditInsert = calls.find((call) => call.text.startsWith("INSERT INTO audit_events"));
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.values[3]).toBe("retention.run");
    expect(auditInsert?.values[4]).toBe("SUCCESS");
    expect(auditInsert?.values[5]).toBe(5);
    expect(JSON.stringify(auditInsert?.values)).not.toContain("webhook");
  });

  it("fails closed for an invalid clock before opening a transaction", async () => {
    const transaction = vi.fn();
    await expect(
      runTenantRetention({
        db: { transaction } as unknown as PersistenceDatabase,
        tenantId: TENANT,
        actorHash: sha256Hex("system-retention"),
        now: () => new Date(Number.NaN),
      }),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
