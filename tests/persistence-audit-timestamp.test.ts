import { describe, expect, it, vi } from "vitest";
import {
  assertAuditTimestamp,
  computeAuditEntryHash,
  validateAuditEntry,
} from "../src/persistence/audit.js";
import { sha256Hex } from "../src/persistence/crypto.js";
import { appendAuditEvent, type QueryResult, type SqlExecutor } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const INPUT = {
  auditId: "00000000-0000-4000-8000-0000000000c1",
  tenantId: TENANT,
  actorHash: sha256Hex("synthetic-audit-actor"),
  action: "tenant.create",
  result: "SUCCESS",
  itemCount: 1,
  previousHash: null,
};

describe("audit timestamp canonicalization before hashing", () => {
  it("normalizes UTC, zone offsets and supported zero-padded fractions to one representation", () => {
    for (const value of [
      "2026-10-09T12:34:56Z",
      "2026-10-09T12:34:56.0Z",
      "2026-10-09T12:34:56.000000Z",
      "2026-10-09T12:34:56.000000000Z",
      "2026-10-09T14:34:56+02:00",
      "2026-10-09T14:34:56+0200",
    ]) {
      expect(assertAuditTimestamp(value)).toBe("2026-10-09T12:34:56.000Z");
    }
    expect(assertAuditTimestamp("2026-10-09T14:34:56.123000000+02:00"))
      .toBe("2026-10-09T12:34:56.123Z");
  });

  it("refuses sub-millisecond loss, impossible dates, out-of-range times and offsets", () => {
    for (const invalid of [
      "2026-10-09T12:34:56.123001Z",
      "2026-10-09T12:34:56.123000001Z",
      "2026-02-29T12:34:56Z",
      "2026-04-31T12:34:56Z",
      "2026-13-09T12:34:56Z",
      "2026-10-09T24:00:00Z",
      "2026-10-09T12:60:00Z",
      "2026-10-09T12:34:60Z",
      "2026-10-09T12:34:56+14:01",
      "2026-10-09T12:34:56+25:00",
      "yesterday",
    ]) {
      expect(() => assertAuditTimestamp(invalid), invalid).toThrow(/Invalid audit timestamp/);
    }
    expect(assertAuditTimestamp("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("hashes the same instant identically regardless of the supplied ISO spelling", () => {
    const a = { ...INPUT, createdAt: "2026-10-09T12:34:56.123Z" };
    const b = { ...INPUT, createdAt: "2026-10-09T14:34:56.123000+02:00" };
    expect(computeAuditEntryHash(a)).toBe(computeAuditEntryHash(b));
    expect(validateAuditEntry(b).createdAt).toBe("2026-10-09T12:34:56.123Z");
    expect(computeAuditEntryHash({ ...b, createdAt: "2026-10-09T12:34:56.124Z" }))
      .not.toBe(computeAuditEntryHash(a));
  });

  it("stores the canonical timestamp and its hash in the same audit insert", async () => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const query = vi.fn(async <Row = Record<string, unknown>>(statement: {
      readonly text: string;
      readonly values: readonly unknown[];
    }): Promise<QueryResult<Row>> => {
      statements.push(statement);
      if (statement.text.includes("FROM tenants") && statement.text.includes("FOR UPDATE")) {
        return { rows: [{ tenant_id: TENANT }] as unknown as readonly Row[], rowCount: 1 };
      }
      if (statement.text.includes("FROM audit_events") && statement.text.includes("LIMIT 1")) {
        return { rows: [] as readonly Row[], rowCount: 0 };
      }
      if (statement.text.startsWith("SELECT previous_hash FROM audit_retention_anchors")) {
        return { rows: [] as readonly Row[], rowCount: 0 };
      }
      if (statement.text.startsWith("INSERT INTO audit_events")) {
        return { rows: [] as readonly Row[], rowCount: 1 };
      }
      if (statement.text.startsWith("SELECT t.max_webhook_events")) {
        return {
          rows: [{
            max_webhook_events: 10000,
            max_audit_events: 100000,
            max_persistence_bytes: 67108864,
            webhook_events: 0,
            audit_events: 1,
            persistence_bytes: 256,
          }] as unknown as readonly Row[],
          rowCount: 1,
        };
      }
      throw new Error("unexpected test SQL");
    });
    const input = {
      auditId: INPUT.auditId,
      actorHash: INPUT.actorHash,
      action: INPUT.action,
      result: INPUT.result,
      itemCount: INPUT.itemCount,
      createdAt: "2026-10-09T14:34:56.123000+02:00",
    };
    const result = await appendAuditEvent(TENANT, { query } as unknown as SqlExecutor, input);
    const insert = statements.find((statement) => statement.text.startsWith("INSERT INTO audit_events"));
    expect(insert).toBeDefined();
    expect(insert?.values[6]).toBe("2026-10-09T12:34:56.123Z");
    expect(insert?.values[8]).toBe(computeAuditEntryHash({
      ...input,
      tenantId: TENANT,
      previousHash: null,
      createdAt: "2026-10-09T12:34:56.123Z",
    }));
    expect(insert?.values[8]).toBe(result.entryHash);
  });
});
