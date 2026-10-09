import { describe, expect, it } from "vitest";
import { hashAuditEntry } from "../src/persistence/audit-chain.js";
import { asTenantId } from "../src/persistence/types.js";

const base = {
  tenantId: asTenantId("550e8400-e29b-41d4-a716-446655440000"),
  actorHash: "a".repeat(64),
  action: "RETENTION_DELETE" as const,
  result: "SUCCESS" as const,
  count: 3,
  occurredAt: "2026-10-09T08:00:00.000Z",
  previousHash: null,
};

describe("persistence audit chain", () => {
  it("is deterministic and SHA-256 shaped", () => {
    const hash = hashAuditEntry(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashAuditEntry(base));
  });

  it("changes when any security-relevant field changes", () => {
    const original = hashAuditEntry(base);
    expect(hashAuditEntry({ ...base, count: 4 })).not.toBe(original);
    expect(hashAuditEntry({ ...base, result: "FAILED" })).not.toBe(original);
    expect(hashAuditEntry({ ...base, previousHash: "b".repeat(64) })).not.toBe(original);
  });

  it("uses length-prefixing so delimiter-like values cannot collide", () => {
    const a = hashAuditEntry({ ...base, actorHash: "ab|c" });
    const b = hashAuditEntry({ ...base, actorHash: "ab", occurredAt: "c|" + base.occurredAt });
    expect(a).not.toBe(b);
  });
});
