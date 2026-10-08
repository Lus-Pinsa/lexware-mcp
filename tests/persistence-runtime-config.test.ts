import { describe, expect, it, vi } from "vitest";
import { decryptField, encryptField, sha256Hex } from "../src/persistence/crypto.js";
import type { PersistenceDatabase, SqlExecutor } from "../src/persistence/repository.js";
import { loadPersistenceRuntimeConfig } from "../src/persistence/runtime-config.js";
import { verifyConfiguredTenantBinding } from "../src/persistence/tenant-binding.js";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ORG = "00000000-0000-4000-8000-0000000000bb";

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString("base64");
}

function enabledEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PERSISTENCE_ENABLED: "true",
    PERSISTENCE_DATABASE_URL: "postgresql://db.internal.example.test/lus",
    LUS_TENANT_ID: TENANT,
    PERSISTENCE_CURRENT_KEY_ID: "k1",
    PERSISTENCE_KEYRING: JSON.stringify({ k1: b64(32, 7), old: b64(32, 8) }),
    PERSISTENCE_AUDIT_ACTOR_SALT: b64(32, 9),
    ...extra,
  };
}

describe("persistence runtime configuration", () => {
  it("is disabled by default and requires no persistence secrets", () => {
    expect(loadPersistenceRuntimeConfig({}, undefined)).toEqual({ enabled: false });
    expect(
      loadPersistenceRuntimeConfig(
        { PERSISTENCE_ENABLED: "false", PERSISTENCE_KEYRING: "{broken" },
        undefined,
      ),
    ).toEqual({ enabled: false });
  });

  it("loads an explicit tenant-bound config without making secrets JSON-serializable", () => {
    const env = enabledEnv();
    const config = loadPersistenceRuntimeConfig(env, ORG);
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("expected enabled config");

    expect(config.tenantId).toBe(TENANT);
    expect(config.organizationIdHash).toBe(sha256Hex(ORG));
    expect(config.secrets.keyring.currentKeyId).toBe("k1");
    expect(config.secrets.getDatabaseUrl()).toBe(env.PERSISTENCE_DATABASE_URL);
    expect(config.secrets.getAuditActorSalt()).toHaveLength(32);

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(String(env.PERSISTENCE_DATABASE_URL));
    expect(serialized).not.toContain(b64(32, 7));
    expect(serialized).not.toContain(b64(32, 9));
    expect(serialized).not.toContain(ORG);
  });

  it("returns defensive copies of secret key/salt material", () => {
    const config = loadPersistenceRuntimeConfig(enabledEnv(), ORG);
    if (!config.enabled) throw new Error("expected enabled config");

    const context = {
      tenantId: config.tenantId,
      table: "webhook_events",
      field: "resource_id",
      recordId: sha256Hex("event"),
    };
    const encrypted = encryptField(config.secrets.keyring, "synthetic-resource", context);
    expect(decryptField(config.secrets.keyring, encrypted, context)).toBe("synthetic-resource");

    const saltA = config.secrets.getAuditActorSalt();
    const saltB = config.secrets.getAuditActorSalt();
    saltA[0] ^= 0xff;
    expect(saltA[0]).not.toBe(saltB[0]);
  });

  it("fails closed when enabled configuration is incomplete or malformed", () => {
    const cases: Array<NodeJS.ProcessEnv> = [
      { ...enabledEnv(), PERSISTENCE_DATABASE_URL: "" },
      { ...enabledEnv(), LUS_TENANT_ID: "not-a-tenant" },
      { ...enabledEnv(), PERSISTENCE_CURRENT_KEY_ID: "missing" },
      { ...enabledEnv(), PERSISTENCE_KEYRING: "{bad" },
      { ...enabledEnv(), PERSISTENCE_KEYRING: JSON.stringify({ k1: b64(31, 1) }) },
      { ...enabledEnv(), PERSISTENCE_AUDIT_ACTOR_SALT: b64(8, 1) },
    ];
    for (const env of cases) {
      expect(() => loadPersistenceRuntimeConfig(env, ORG)).toThrow();
    }
    expect(() => loadPersistenceRuntimeConfig(enabledEnv(), undefined)).toThrow(
      /LEXWARE_ORGANIZATION_ID/,
    );
    expect(() =>
      loadPersistenceRuntimeConfig({ PERSISTENCE_ENABLED: "maybe" }, ORG),
    ).toThrow(/boolean/);
  });
});

describe("configured tenant binding", () => {
  function databaseFor(row: Record<string, unknown> | null): PersistenceDatabase {
    return {
      transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
        const tx: SqlExecutor = {
          query: vi.fn(async (statement) => {
            if (statement.text.includes("set_config")) {
              return { rows: [], rowCount: 1 };
            }
            if (statement.text.includes("FROM tenants")) {
              return {
                rows: row === null ? [] : [row],
                rowCount: row === null ? 0 : 1,
              };
            }
            throw new Error("unexpected query");
          }) as SqlExecutor["query"],
        };
        return work(tx);
      },
    };
  }

  it("accepts only the explicitly configured active tenant and organization hash", async () => {
    const config = loadPersistenceRuntimeConfig(enabledEnv(), ORG);
    if (!config.enabled) throw new Error("expected enabled config");

    await expect(
      verifyConfiguredTenantBinding(
        config,
        databaseFor({
          tenant_id: TENANT,
          organization_id_hash: sha256Hex(ORG),
          status: "active",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed on missing, disabled, or organization-mismatched tenant", async () => {
    const config = loadPersistenceRuntimeConfig(enabledEnv(), ORG);
    if (!config.enabled) throw new Error("expected enabled config");

    await expect(verifyConfiguredTenantBinding(config, databaseFor(null))).rejects.toThrow(/does not exist/);
    await expect(
      verifyConfiguredTenantBinding(
        config,
        databaseFor({
          tenant_id: TENANT,
          organization_id_hash: sha256Hex(ORG),
          status: "disabled",
        }),
      ),
    ).rejects.toThrow(/disabled/);
    await expect(
      verifyConfiguredTenantBinding(
        config,
        databaseFor({
          tenant_id: TENANT,
          organization_id_hash: sha256Hex("different-org"),
          status: "active",
        }),
      ),
    ).rejects.toThrow(/organization mismatch/);
  });
});
