import { describe, expect, it, vi } from "vitest";
import { listAuditChainEntries } from "../src/persistence/integrity-repository.js";
import { deleteExpiredAuditEvents } from "../src/persistence/maintenance-repository.js";
import { sha256Hex } from "../src/persistence/crypto.js";
import type { SqlExecutor } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");

describe("audit chain verification completeness", () => {
  it("fetches a sentinel row and refuses a chain longer than the requested limit", async () => {
    const query = vi.fn(async () => ({
      rows: [{}, {}],
      rowCount: 2,
    }));
    const tx = { query } as unknown as SqlExecutor;

    await expect(listAuditChainEntries(TENANT, tx, 1)).rejects.toThrow(
      /exceeds the integrity verification limit/,
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ values: [TENANT, 2] }),
    );
  });

  it("requests 100001 records for the 100000-entry maximum", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const tx = { query } as unknown as SqlExecutor;

    await expect(listAuditChainEntries(TENANT, tx, 100_000)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ values: [TENANT, 100_001] }),
    );
  });

  it("refuses a truncated result even when the driver exposes fewer rows", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    const tx = { query } as unknown as SqlExecutor;
    await expect(listAuditChainEntries(TENANT, tx, 1)).rejects.toThrow(
      /exceeds the integrity verification limit/,
    );
  });

  it("blocks retention anchor mutation and deletion when integrity scan is truncated", async () => {
    const hash = sha256Hex("synthetic-expired-last-audit");
    const query = vi.fn(async (statement: { text: string; values: readonly unknown[] }) => {
      if (statement.text.includes("pg_advisory_xact_lock")) {
        return { rows: [{ tenant_id: TENANT }], rowCount: 1 };
      }
      if (statement.text.includes("SELECT previous_hash, last_pruned_seq FROM audit_retention_anchors")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.text.includes("SELECT audit_id, tenant_id")) {
        expect(statement.values).toEqual([TENANT, 100_001]);
        return { rows: [], rowCount: 100_001 };
      }
      throw new Error("Unexpected SQL during fail-closed retention: " + statement.text);
    });
    await expect(
      deleteExpiredAuditEvents(
        TENANT,
        { query } as unknown as SqlExecutor,
        "2025-10-09T08:00:00.000Z",
        "2026-10-09T08:00:00.000Z",
      ),
    ).rejects.toThrow(/exceeds the integrity verification limit/);

    expect(
      query.mock.calls.every(([statement]) =>
        !statement.text.startsWith("DELETE ") &&
        !statement.text.startsWith("INSERT INTO audit_retention_anchors")),
    ).toBe(true);
  });
});
