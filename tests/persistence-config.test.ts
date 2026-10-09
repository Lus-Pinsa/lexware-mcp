import { describe, expect, it } from "vitest";
import { loadPersistenceConfig } from "../src/persistence/config.js";

const key = Buffer.alloc(32, 7).toString("base64");
const pepper = Buffer.alloc(32, 9).toString("base64");

const enabled = () =>
  ({
    PERSISTENCE_ENABLED: "true",
    PERSISTENCE_DATABASE_URL:
      "postgresql://runtime:secret@db.internal.example/lus?sslmode=verify-full",
    PERSISTENCE_TENANT_ID: "550e8400-e29b-41d4-a716-446655440000",
    PERSISTENCE_ENCRYPTION_KEY_ID: "v1",
    PERSISTENCE_ENCRYPTION_KEY: key,
    PERSISTENCE_AUDIT_PEPPER: pepper,
  }) as NodeJS.ProcessEnv;

describe("persistence config", () => {
  it("is disabled by default", () => {
    expect(loadPersistenceConfig({})).toEqual({ enabled: false });
  });

  it("requires an explicit enable flag before reading persistence secrets", () => {
    expect(
      loadPersistenceConfig({
        PERSISTENCE_DATABASE_URL: "not-a-url",
        PERSISTENCE_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toEqual({ enabled: false });
  });

  it("loads a complete fail-closed persistence configuration", () => {
    const cfg = loadPersistenceConfig(enabled());
    expect(cfg.enabled).toBe(true);
    if (!cfg.enabled) throw new Error("expected enabled config");
    expect(cfg.tenantId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(cfg.encryptionKeyId).toBe("v1");
    expect(cfg.encryptionKey).toHaveLength(32);
    expect(cfg.auditActorPepper).toHaveLength(32);
  });

  it("requires PostgreSQL TLS certificate verification", () => {
    for (const url of [
      "postgresql://runtime:secret@db.internal.example/lus",
      "postgresql://runtime:secret@db.internal.example/lus?sslmode=require",
      "http://db.internal.example/lus?sslmode=verify-full",
    ]) {
      expect(() =>
        loadPersistenceConfig({
          ...enabled(),
          PERSISTENCE_DATABASE_URL: url,
        }),
      ).toThrow();
    }
  });

  it("rejects malformed tenant ids, key ids and secret material", () => {
    expect(() =>
      loadPersistenceConfig({ ...enabled(), PERSISTENCE_TENANT_ID: "default" }),
    ).toThrow();
    expect(() =>
      loadPersistenceConfig({ ...enabled(), PERSISTENCE_ENCRYPTION_KEY_ID: "bad id" }),
    ).toThrow();
    expect(() =>
      loadPersistenceConfig({
        ...enabled(),
        PERSISTENCE_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64"),
      }),
    ).toThrow(/32 bytes/);
  });

  it("never includes secret values in validation errors", () => {
    const secret = "postgresql://runtime:SUPERSECRET@db.internal.example/lus";
    let message = "";
    try {
      loadPersistenceConfig({
        ...enabled(),
        PERSISTENCE_DATABASE_URL: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("SUPERSECRET");
    expect(message).not.toContain(secret);
  });
});
