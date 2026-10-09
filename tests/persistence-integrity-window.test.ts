import { describe, expect, it, vi } from "vitest";
import { listAuditChainEntries } from "../src/persistence/integrity-repository.js";
import type { SqlExecutor } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");

describe("audit chain verification completeness", () => {
  it("fetches one sentinel beyond the requested limit and fails closed on truncation", async () => {
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

  it("rejects an incomplete result if the driver reports more rows than it exposes", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    const tx = { query } as unknown as SqlExecutor;
    await expect(listAuditChainEntries(TENANT, tx, 1)).rejects.toThrow(
      /exceeds the integrity verification limit/,
    );
  });
});
