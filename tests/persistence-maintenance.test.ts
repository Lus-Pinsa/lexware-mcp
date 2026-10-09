import { describe, expect, it, vi } from "vitest";
import {
  deleteExpiredAcknowledgedWebhookEvents,
  deleteExpiredAuditEvents,
  deleteTenantData,
} from "../src/persistence/maintenance-repository.js";
import type { SqlExecutor } from "../src/persistence/repository.js";
import { sha256Hex } from "../src/persistence/crypto.js";
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

    expect(query.mock.calls[0][0].text).toContain("FOR UPDATE");
    expect(query.mock.calls[1][0].text).toContain("acknowledged_at IS NOT NULL");
    expect(query.mock.calls[1][0].text).toContain("acknowledged_at < $2");
    expect(query.mock.calls[1][0].values).toEqual([
      TENANT,
      "2026-09-09T08:00:00.000Z",
    ]);
  });

  it("stores the last deleted audit hash as a retention anchor before deleting", async () => {
    const anchorHash = sha256Hex("last-expired-audit");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ entry_hash: anchorHash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 7 });
    const tx = { query } as unknown as SqlExecutor;

    await expect(
      deleteExpiredAuditEvents(
        TENANT,
        tx,
        "2025-10-09T08:00:00.000Z",
        "2026-10-09T08:00:00.000Z",
      ),
    ).resolves.toBe(7);

    expect(query.mock.calls[2][0].text).toContain("audit_retention_anchors");
    expect(query.mock.calls[2][0].values).toEqual([
      TENANT,
      anchorHash,
      "2026-10-09T08:00:00.000Z",
    ]);
    expect(query.mock.calls[3][0].text).toContain("DELETE FROM audit_events");
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
