import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/persistence/crypto.js";
import {
  PersistenceConfigError,
  loadPersistenceRuntimeConfig,
} from "../src/persistence/runtime-config.js";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ORG = "00000000-0000-4000-8000-0000000000bb";

function enabledEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 7).toString("base64");
  const salt = Buffer.alloc(32, 9).toString("base64");
  return {
    PERSISTENCE_ENABLED: "true",
    PERSISTENCE_DATABASE_URL: "postgres://db.internal.example.test/lus",
    LUS_TENANT_ID: TENANT,
    LEXWARE_ORGANIZATION_ID: ORG,
    PERSISTENCE_CURRENT_KEY_ID: "k1",
    PERSISTENCE_KEYRING_JSON: JSON.stringify({ k1: key }),
    PERSISTENCE_AUDIT_ACTOR_SALT: salt,
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("persistence runtime config", () => {
  it("is disabled by default and ignores unused persistence secrets while disabled", () => {
    expect(loadPersistenceRuntimeConfig({} as NodeJS.ProcessEnv)).toEqual({ enabled: false });
    expect(
      loadPersistenceRuntimeConfig({
        PERSISTENCE_ENABLED: "false",
        PERSISTENCE_KEYRING_JSON: "{not-json",
      } as NodeJS.ProcessEnv),
    ).toEqual({ enabled: false });
  });

  it("loads an explicit tenant-bound config without making secrets enumerable", () => {
    const env = enabledEnv();
    const config = loadPersistenceRuntimeConfig(env);
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("expected enabled config");

    expect(config.tenantId).toBe(TENANT);
    expect(config.organizationIdHash).toBe(sha256Hex(ORG.toLowerCase()));
    expect(config.databaseUrl).toBe(env.PERSISTENCE_DATABASE_URL);
    expect(config.keyring.currentKeyId).toBe("k1");
    expect(config.auditActorSalt).toHaveLength(32);
    const firstSalt = config.auditActorSalt;
    const originalFirstByte = firstSalt[0];
    firstSalt[0] = originalFirstByte ^ 0xff;
    expect(config.auditActorSalt[0]).toBe(originalFirstByte);

    const serialized = JSON.stringify(config);
    expect(serialized).toContain('"enabled":true');
    expect(serialized).toContain('"secretsIncluded":false');
    expect(serialized).not.toContain(String(env.PERSISTENCE_DATABASE_URL));
    expect(serialized).not.toContain(String(env.PERSISTENCE_KEYRING_JSON));
    expect(serialized).not.toContain(config.organizationIdHash);
    expect(Object.keys(config)).toEqual(["enabled", "tenantId"]);
  });

  it("normalizes the organization id before hashing", () => {
    const upper = ORG.toUpperCase();
    const a = loadPersistenceRuntimeConfig(enabledEnv({ LEXWARE_ORGANIZATION_ID: ORG }));
    const b = loadPersistenceRuntimeConfig(enabledEnv({ LEXWARE_ORGANIZATION_ID: upper }));
    if (!a.enabled || !b.enabled) throw new Error("expected enabled configs");
    expect(a.organizationIdHash).toBe(b.organizationIdHash);
  });

  it("requires every binding and secret only when persistence is enabled", () => {
    for (const key of [
      "PERSISTENCE_DATABASE_URL",
      "LUS_TENANT_ID",
      "LEXWARE_ORGANIZATION_ID",
      "PERSISTENCE_CURRENT_KEY_ID",
      "PERSISTENCE_KEYRING_JSON",
      "PERSISTENCE_AUDIT_ACTOR_SALT",
    ]) {
      const env = enabledEnv();
      delete env[key];
      expect(() => loadPersistenceRuntimeConfig(env), key).toThrow(
        new RegExp(key + " is required"),
      );
    }
  });

  it("fails closed for malformed URLs, tenant ids, organization ids and booleans", () => {
    expect(() =>
      loadPersistenceRuntimeConfig(enabledEnv({ PERSISTENCE_DATABASE_URL: "https://db.example.test/lus" })),
    ).toThrow(PersistenceConfigError);
    expect(() =>
      loadPersistenceRuntimeConfig(enabledEnv({ LUS_TENANT_ID: "not-a-tenant" })),
    ).toThrow(/tenant/i);
    expect(() =>
      loadPersistenceRuntimeConfig(enabledEnv({ LEXWARE_ORGANIZATION_ID: "bad org" })),
    ).toThrow(PersistenceConfigError);
    expect(() =>
      loadPersistenceRuntimeConfig({ PERSISTENCE_ENABLED: "maybe" } as NodeJS.ProcessEnv),
    ).toThrow(PersistenceConfigError);
  });

  it("fails closed for malformed keyrings without echoing their content", () => {
    const marker = "DO-NOT-ECHO-MARKER";
    for (const keyring of [
      "{not-json " + marker,
      JSON.stringify({ k1: marker }),
      JSON.stringify({ k1: Buffer.alloc(31, 1).toString("base64") }),
    ]) {
      let error: unknown;
      try {
        loadPersistenceRuntimeConfig(enabledEnv({ PERSISTENCE_KEYRING_JSON: keyring }));
      } catch (value) {
        error = value;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(marker);
    }
  });

  it("requires the current encryption key to exist and caps the keyring size", () => {
    expect(() =>
      loadPersistenceRuntimeConfig(enabledEnv({ PERSISTENCE_CURRENT_KEY_ID: "missing" })),
    ).toThrow(/keyring is invalid/);

    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => ["k" + i, Buffer.alloc(32, i + 1).toString("base64")]),
    );
    expect(() =>
      loadPersistenceRuntimeConfig(
        enabledEnv({
          PERSISTENCE_CURRENT_KEY_ID: "k0",
          PERSISTENCE_KEYRING_JSON: JSON.stringify(many),
        }),
      ),
    ).toThrow(/1 to 8/);
  });

  it("requires a canonical 32-byte audit salt", () => {
    expect(() =>
      loadPersistenceRuntimeConfig(
        enabledEnv({ PERSISTENCE_AUDIT_ACTOR_SALT: Buffer.alloc(31, 1).toString("base64") }),
      ),
    ).toThrow(/32-byte/);
  });
});
