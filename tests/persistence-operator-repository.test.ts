import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/persistence/crypto.js";
import type {
  MigrationDatabase,
  StaticMigrationExecutor,
} from "../src/persistence/migration-types.js";
import { bootstrapTenant } from "../src/persistence/operator-repository.js";
import type { QueryResult } from "../src/persistence/repository.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const ORG_HASH = sha256Hex("synthetic-org");
const ACTOR_HASH = sha256Hex("synthetic-operator");
const AUDIT_ID = "00000000-0000-4000-8000-0000000000c1";

function bootstrapDb(options: {
  insertCount: 0 | 1;
  storedOrgHash?: string;
  storedStatus?: "active" | "disabled";
}) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];

  const query = vi.fn(async <Row = Record<string, unknown>>(statement: {
    readonly text: string;
    readonly values: readonly unknown[];
  }): Promise<QueryResult<Row>> => {
    queries.push(statement);

    if (statement.text.startsWith("SELECT set_config")) {
      return { rows: [{ tenant_id: TENANT }] as unknown as readonly Row[], rowCount: 1 };
    }
    if (statement.text.startsWith("INSERT INTO tenants")) {
      return { rows: [] as readonly Row[], rowCount: options.insertCount };
    }
    if (
      statement.text.startsWith("SELECT tenant_id, organization_id_hash, status, capability_tier FROM tenants") &&
      !statement.text.includes("FOR UPDATE")
    ) {
      return {
        rows: [
          {
            tenant_id: TENANT,
            organization_id_hash: options.storedOrgHash ?? ORG_HASH,
            status: options.storedStatus ?? "active",
            capability_tier: "read_only",
          },
        ] as unknown as readonly Row[],
        rowCount: 1,
      };
    }
    if (statement.text.includes("FROM tenants") && statement.text.includes("pg_advisory_xact_lock")) {
      return { rows: [{ tenant_id: TENANT }] as unknown as readonly Row[], rowCount: 1 };
    }
    if (statement.text.startsWith("SELECT entry_hash FROM audit_events")) {
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

    throw new Error("unexpected query");
  });

  const tx = {
    query,
    executeStatic: vi.fn(async () => {}),
  } as unknown as StaticMigrationExecutor;

  const transaction = vi.fn(async <T>(work: (executor: StaticMigrationExecutor) => Promise<T>) =>
    work(tx),
  );

  return {
    db: { transaction } as MigrationDatabase,
    query,
    queries,
    transaction,
  };
}

const input = () => ({
  tenantId: TENANT,
  organizationIdHash: ORG_HASH,
  auditId: AUDIT_ID,
  actorHash: ACTOR_HASH,
  createdAt: "2026-10-08T20:00:00Z",
});

describe("explicit persistence tenant bootstrap", () => {
  it("creates exactly the configured tenant and appends a tenant.create audit event", async () => {
    const h = bootstrapDb({ insertCount: 1 });
    await expect(bootstrapTenant(h.db, input())).resolves.toEqual({ created: true });

    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.queries[0].values).toEqual([TENANT]);
    expect(h.queries[1].text).toContain("INSERT INTO tenants");
    expect(h.queries[1].values).toEqual([TENANT, ORG_HASH]);

    const auditInsert = h.queries.find((q) => q.text.startsWith("INSERT INTO audit_events"));
    expect(auditInsert).toBeDefined();
    expect(auditInsert!.values[1]).toBe(TENANT);
    expect(auditInsert!.values[2]).toBe(ACTOR_HASH);
    expect(auditInsert!.values[3]).toBe("tenant.create");
    expect(auditInsert!.values[4]).toBe("SUCCESS");
    expect(auditInsert!.values[5]).toBe(1);
  });

  it("is idempotent for an already-existing matching tenant and does not duplicate creation audit", async () => {
    const h = bootstrapDb({ insertCount: 0 });
    await expect(bootstrapTenant(h.db, input())).resolves.toEqual({ created: false });
    expect(h.queries.filter((q) => q.text.startsWith("INSERT INTO audit_events"))).toHaveLength(0);
  });

  it("fails closed if an existing tenant has a different organization binding", async () => {
    const h = bootstrapDb({
      insertCount: 0,
      storedOrgHash: sha256Hex("other-synthetic-org"),
    });
    await expect(bootstrapTenant(h.db, input())).rejects.toThrow(/does not match/);
    expect(h.queries.filter((q) => q.text.startsWith("INSERT INTO audit_events"))).toHaveLength(0);
  });

  it("fails closed if an existing tenant is disabled", async () => {
    const h = bootstrapDb({ insertCount: 0, storedStatus: "disabled" });
    await expect(bootstrapTenant(h.db, input())).rejects.toThrow(/does not match/);
    expect(h.queries.filter((q) => q.text.startsWith("INSERT INTO audit_events"))).toHaveLength(0);
  });

  it("never accepts a row for another tenant", async () => {
    const h = bootstrapDb({ insertCount: 0 });
    h.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 1 }));
    h.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    h.query.mockImplementationOnce(async () => ({
      rows: [{
        tenant_id: "00000000-0000-4000-8000-0000000000bb",
        organization_id_hash: ORG_HASH,
        status: "active",
        capability_tier: "read_only",
      }],
      rowCount: 1,
    }));
    await expect(bootstrapTenant(h.db, input())).rejects.toThrow(/unavailable/);
  });
});
