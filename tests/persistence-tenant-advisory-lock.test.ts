import { describe, expect, it, vi } from "vitest";
import { lockTenantForUpdate, type SqlExecutor } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const OTHER = parseTenantId("00000000-0000-4000-8000-0000000000bb");

describe("tenant transaction-scoped advisory lock", () => {
  it("serializes by tenant without requiring forbidden UPDATE access on tenants", async () => {
    const query = vi.fn(async () => ({
      rows: [{ tenant_id: TENANT, lock_token: null }],
      rowCount: 1,
    }));
    await expect(lockTenantForUpdate(TENANT, { query } as unknown as SqlExecutor))
      .resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);
    const statement = query.mock.calls[0][0] as { text: string; values: readonly unknown[] };
    expect(statement.text).toContain("pg_advisory_xact_lock");
    expect(statement.text).toContain("hashtext($1::text)");
    expect(statement.text).toContain("FROM tenants WHERE tenant_id = $1");
    expect(statement.text).not.toMatch(/FOR UPDATE|FOR SHARE|UPDATE tenants/);
    expect(statement.values).toEqual([TENANT]);
  });

  it("rejects a missing or unbound tenant rather than silently succeeding", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(lockTenantForUpdate(TENANT, { query } as unknown as SqlExecutor))
      .rejects.toThrow(/Tenant unavailable for locked persistence operation/);
  });

  it("rejects cross-tenant rows even when the driver violates the tenant filter", async () => {
    const query = vi.fn(async () => ({
      rows: [{ tenant_id: OTHER, lock_token: null }],
      rowCount: 1,
    }));
    await expect(lockTenantForUpdate(TENANT, { query } as unknown as SqlExecutor))
      .rejects.toThrow(/Tenant unavailable for locked persistence operation/);
  });

  it("never queries the database for an invalid tenant id", async () => {
    const query = vi.fn();
    await expect(lockTenantForUpdate("bogus" as never, { query } as unknown as SqlExecutor))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
