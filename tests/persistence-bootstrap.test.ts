import { describe, expect, it, vi } from "vitest";
import { checkPersistenceReadiness, type PersistenceHealthProbe } from "../src/persistence/bootstrap.js";
import type { PersistenceConfig } from "../src/persistence/config.js";
import type { TenantDirectory } from "../src/persistence/repository.js";
import { asTenantId } from "../src/persistence/types.js";

const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");
const otherTenantId = asTenantId("550e8400-e29b-41d4-a716-446655440001");
const organizationHash = "a".repeat(64);

const enabledConfig = (): PersistenceConfig => ({
  enabled: true,
  databaseUrl: "postgresql://runtime@db.internal.example/lus?sslmode=verify-full",
  tenantId,
  encryptionKeyId: "v1",
  encryptionKey: Buffer.alloc(32, 1),
  auditActorPepper: Buffer.alloc(32, 2),
});

function directory(result: { tenantId: typeof tenantId } | null): TenantDirectory {
  return { resolveOrganizationHash: vi.fn(async () => result) };
}

function health(schemaVersion = 1, integrity = true): PersistenceHealthProbe {
  return {
    schemaVersion: vi.fn(async () => schemaVersion),
    integrityOk: vi.fn(async () => integrity),
  };
}

const clock = () => new Date("2026-10-09T10:00:00.000Z");

describe("persistence readiness gate", () => {
  it("reports DISABLED without touching the database", async () => {
    const d = directory({ tenantId });
    const h = health();
    await expect(
      checkPersistenceReadiness({ enabled: false }, organizationHash, d, h, clock),
    ).resolves.toEqual({
      status: "UNAVAILABLE",
      checkedAt: "2026-10-09T10:00:00.000Z",
      reason: "DISABLED",
    });
    expect(d.resolveOrganizationHash).not.toHaveBeenCalled();
    expect(h.schemaVersion).not.toHaveBeenCalled();
    expect(h.integrityOk).not.toHaveBeenCalled();
  });

  it("fails closed on malformed organization binding input", async () => {
    const d = directory({ tenantId });
    const h = health();
    await expect(
      checkPersistenceReadiness(enabledConfig(), "not-a-hash", d, h, clock),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "CONFIG_INVALID" });
    expect(h.schemaVersion).not.toHaveBeenCalled();
  });

  it("reports DATABASE_UNREACHABLE when schema probing fails", async () => {
    const h: PersistenceHealthProbe = {
      schemaVersion: vi.fn(async () => {
        throw new Error("offline");
      }),
      integrityOk: vi.fn(async () => true),
    };
    await expect(
      checkPersistenceReadiness(enabledConfig(), organizationHash, directory({ tenantId }), h, clock),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "DATABASE_UNREACHABLE" });
  });

  it("rejects a future schema version", async () => {
    await expect(
      checkPersistenceReadiness(enabledConfig(), organizationHash, directory({ tenantId }), health(999), clock),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "SCHEMA_UNSUPPORTED" });
  });

  it("rejects missing or cross-tenant organization bindings", async () => {
    await expect(
      checkPersistenceReadiness(enabledConfig(), organizationHash, directory(null), health(), clock),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "TENANT_BINDING_MISMATCH" });

    await expect(
      checkPersistenceReadiness(
        enabledConfig(),
        organizationHash,
        directory({ tenantId: otherTenantId as typeof tenantId }),
        health(),
        clock,
      ),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "TENANT_BINDING_MISMATCH" });
  });

  it("reports integrity failure without repair", async () => {
    await expect(
      checkPersistenceReadiness(enabledConfig(), organizationHash, directory({ tenantId }), health(1, false), clock),
    ).resolves.toMatchObject({ status: "UNAVAILABLE", reason: "INTEGRITY_FAILURE" });
  });

  it("becomes AVAILABLE only after schema, binding and integrity all pass", async () => {
    await expect(
      checkPersistenceReadiness(enabledConfig(), organizationHash, directory({ tenantId }), health(), clock),
    ).resolves.toEqual({ status: "AVAILABLE", checkedAt: "2026-10-09T10:00:00.000Z" });
  });
});
