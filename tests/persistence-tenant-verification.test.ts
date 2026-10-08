import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/persistence/crypto.js";
import type {
  PersistenceDatabase,
  QueryResult,
  SqlExecutor,
} from "../src/persistence/repository.js";
import type { PersistenceRuntimeConfig } from "../src/persistence/runtime-config.js";
import { verifyPersistenceTenantBinding } from "../src/persistence/tenant-verification.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const ORG_HASH = sha256Hex("synthetic-org");

function enabledConfig(): PersistenceRuntimeConfig {
  return {
    enabled: true,
    databaseUrl: "postgres://db.example.test/lus",
    tenantId: TENANT,
    organizationIdHash: ORG_HASH,
    keyring: { currentKeyId: "unused", getKey: () => undefined },
    auditActorSalt: new Uint8Array(32),
  };
}

function database(row: Record<string, unknown> | null): {
  db: PersistenceDatabase;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (statement: { text: string; values: readonly unknown[] }) => {
    if (statement.text.startsWith("SELECT set_config")) {
      return { rows: [{ tenant_id: TENANT }], rowCount: 1 };
    }
    if (statement.text.startsWith("SELECT tenant_id")) {
      return {
        rows: row === null ? [] : [row],
        rowCount: row === null ? 0 : 1,
      };
    }
    throw new Error("unexpected query");
  });
  const tx = { query } as unknown as SqlExecutor;
  const db = {
    transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) => work(tx),
  } as PersistenceDatabase;
  return { db, query };
}

describe("persistence tenant verification", () => {
  it("does not touch the database when persistence is disabled", async () => {
    const transaction = vi.fn();
    const result = await verifyPersistenceTenantBinding(
      { enabled: false },
      { transaction } as unknown as PersistenceDatabase,
    );
    expect(result).toEqual({ state: "DISABLED" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts only the configured active tenant with the exact organization binding", async () => {
    const { db, query } = database({
      tenant_id: TENANT,
      organization_id_hash: ORG_HASH,
      status: "active",
    });
    await expect(verifyPersistenceTenantBinding(enabledConfig(), db)).resolves.toEqual({
      state: "AVAILABLE",
    });
    expect(query.mock.calls[0][0].values).toEqual([TENANT]);
    expect(query.mock.calls[1][0].values).toEqual([TENANT]);
  });

  it("reports missing, disabled and mismatched bindings without a fallback tenant", async () => {
    await expect(verifyPersistenceTenantBinding(enabledConfig(), database(null).db)).resolves.toMatchObject({
      state: "UNAVAILABLE",
    });
    await expect(
      verifyPersistenceTenantBinding(
        enabledConfig(),
        database({ tenant_id: TENANT, organization_id_hash: ORG_HASH, status: "disabled" }).db,
      ),
    ).resolves.toMatchObject({ state: "TENANT_DISABLED" });
    await expect(
      verifyPersistenceTenantBinding(
        enabledConfig(),
        database({
          tenant_id: TENANT,
          organization_id_hash: sha256Hex("other-org"),
          status: "active",
        }).db,
      ),
    ).resolves.toMatchObject({ state: "BINDING_MISMATCH" });
  });
});
