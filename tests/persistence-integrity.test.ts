import { describe, expect, it, vi } from "vitest";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import { sha256Hex } from "../src/persistence/crypto.js";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import type { QueryResult, SqlExecutor } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const OTHER = parseTenantId("00000000-0000-4000-8000-0000000000bb");
const ACTOR = sha256Hex("synthetic-actor");

function row(input: {
  auditId: string;
  previousHash: string | null;
  action: string;
  createdAt: string;
  tenantId?: string;
}) {
  const entry = {
    auditId: input.auditId,
    tenantId: (input.tenantId ?? TENANT) as typeof TENANT,
    actorHash: ACTOR,
    action: input.action,
    result: "SUCCESS",
    itemCount: 1,
    createdAt: input.createdAt,
    previousHash: input.previousHash,
  };
  return {
    audit_id: entry.auditId,
    tenant_id: entry.tenantId,
    actor_hash: entry.actorHash,
    action: entry.action,
    result: entry.result,
    item_count: entry.itemCount,
    created_at: entry.createdAt,
    previous_hash: entry.previousHash,
    entry_hash: computeAuditEntryHash(entry),
  };
}

function executor(anchor: string | null, rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async <Row = Record<string, unknown>>(statement: {
    readonly text: string;
    readonly values: readonly unknown[];
  }): Promise<QueryResult<Row>> => {
    if (statement.text.includes("FROM audit_retention_anchors")) {
      return {
        rows: (anchor === null ? [] : [{ previous_hash: anchor }]) as unknown as readonly Row[],
        rowCount: anchor === null ? 0 : 1,
      };
    }
    if (statement.text.includes("FROM audit_events")) {
      return { rows: rows as unknown as readonly Row[], rowCount: rows.length };
    }
    throw new Error("unexpected query");
  });
  return { query } as unknown as SqlExecutor & { query: typeof query };
}

describe("persistence audit integrity", () => {
  it("verifies an intact retained audit chain", async () => {
    const first = row({
      auditId: "00000000-0000-4000-8000-0000000000c1",
      previousHash: null,
      action: "tenant.create",
      createdAt: "2026-10-08T08:00:00.000Z",
    });
    const second = row({
      auditId: "00000000-0000-4000-8000-0000000000c2",
      previousHash: first.entry_hash,
      action: "retention.run",
      createdAt: "2026-10-09T08:00:00.000Z",
    });

    await expect(
      verifyAuditChainIntegrity(TENANT, executor(null, [first, second])),
    ).resolves.toEqual({
      count: 2,
      anchorHash: null,
      headHash: second.entry_hash,
    });
  });

  it("starts verification from the retention anchor after old rows were pruned", async () => {
    const anchor = sha256Hex("pruned-head");
    const retained = row({
      auditId: "00000000-0000-4000-8000-0000000000c3",
      previousHash: anchor,
      action: "retention.run",
      createdAt: "2026-10-09T08:00:00.000Z",
    });

    await expect(
      verifyAuditChainIntegrity(TENANT, executor(anchor, [retained])),
    ).resolves.toEqual({
      count: 1,
      anchorHash: anchor,
      headHash: retained.entry_hash,
    });
  });

  it("fails closed on a broken previous-hash link", async () => {
    const anchor = sha256Hex("anchor");
    const retained = row({
      auditId: "00000000-0000-4000-8000-0000000000c4",
      previousHash: sha256Hex("wrong"),
      action: "retention.run",
      createdAt: "2026-10-09T08:00:00.000Z",
    });
    await expect(
      verifyAuditChainIntegrity(TENANT, executor(anchor, [retained])),
    ).rejects.toThrow(/integrity check failed/);
  });

  it("fails closed when a stored audit hash was tampered with", async () => {
    const entry = {
      ...row({
        auditId: "00000000-0000-4000-8000-0000000000c5",
        previousHash: null,
        action: "tenant.create",
        createdAt: "2026-10-09T08:00:00.000Z",
      }),
      entry_hash: sha256Hex("tampered"),
    };
    await expect(
      verifyAuditChainIntegrity(TENANT, executor(null, [entry])),
    ).rejects.toThrow(/integrity check failed/);
  });

  it("rejects a cross-tenant row even if the database returned it", async () => {
    const entry = row({
      auditId: "00000000-0000-4000-8000-0000000000c6",
      previousHash: null,
      action: "tenant.create",
      createdAt: "2026-10-09T08:00:00.000Z",
      tenantId: OTHER,
    });
    await expect(
      verifyAuditChainIntegrity(TENANT, executor(null, [entry])),
    ).rejects.toThrow(/Cross-tenant/);
  });
});
