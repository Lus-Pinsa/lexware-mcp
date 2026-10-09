import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/persistence/crypto.js";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import {
  assertRestoreManifestMatches,
  captureRestoreVerificationManifest,
  type RestoreVerificationManifest,
} from "../src/persistence/restore-verification.js";
import type {
  PersistenceDatabase,
  QueryResult,
  SqlExecutor,
} from "../src/persistence/repository.js";
import { loadKnownMigrations } from "../src/persistence/migration-runner.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const ORG_HASH = sha256Hex("synthetic-org");
const ACTOR_HASH = sha256Hex("synthetic-actor");

function database(options: {
  webhookKey?: string;
  auditEntryHashOverride?: string;
  tenantId?: string;
} = {}): PersistenceDatabase {
  const known = loadKnownMigrations();
  const eventKey = options.webhookKey ?? sha256Hex("event-1");
  const auditInput = {
    auditId: "00000000-0000-4000-8000-0000000000c1",
    tenantId: TENANT,
    actorHash: ACTOR_HASH,
    action: "tenant.create",
    result: "SUCCESS",
    itemCount: 1,
    createdAt: "2026-10-09T08:00:00.000Z",
    previousHash: null,
  };
  const auditHash =
    options.auditEntryHashOverride ?? computeAuditEntryHash(auditInput);

  const query = vi.fn(async <Row = Record<string, unknown>>(statement: {
    readonly text: string;
    readonly values: readonly unknown[];
  }): Promise<QueryResult<Row>> => {
    const text = statement.text;
    if (text.startsWith("SELECT version::int")) {
      return {
        rows: known.map(({ version, name, checksum }) => ({
          version,
          name,
          checksum,
        })) as unknown as readonly Row[],
        rowCount: known.length,
      };
    }
    if (text.startsWith("SELECT set_config")) {
      return { rows: [] as readonly Row[], rowCount: 1 };
    }
    if (text.startsWith("SELECT organization_id_hash, status, capability_tier FROM tenants")) {
      return {
        rows: [{
          organization_id_hash: ORG_HASH,
          status: "active",
          capability_tier: "read_only",
        }] as unknown as readonly Row[],
        rowCount: 1,
      };
    }
    if (text.startsWith("SELECT event_key_hash, payload_checksum")) {
      return {
        rows: [{
          event_key_hash: eventKey,
          payload_checksum: sha256Hex("payload"),
          received_at: "2026-10-09T08:00:00.000Z",
          acknowledged_at: null,
        }] as unknown as readonly Row[],
        rowCount: 1,
      };
    }
    if (text.startsWith("SELECT audit_id::text AS audit_id")) {
      return {
        rows: [{
          audit_id: auditInput.auditId,
          entry_hash: auditHash,
        }] as unknown as readonly Row[],
        rowCount: 1,
      };
    }
    if (text.startsWith("SELECT previous_hash FROM audit_retention_anchors")) {
      return { rows: [] as readonly Row[], rowCount: 0 };
    }
    if (text.startsWith("SELECT audit_id, tenant_id")) {
      return {
        rows: [{
          audit_id: auditInput.auditId,
          tenant_id: options.tenantId ?? TENANT,
          actor_hash: ACTOR_HASH,
          action: auditInput.action,
          result: auditInput.result,
          item_count: auditInput.itemCount,
          created_at: auditInput.createdAt,
          previous_hash: null,
          entry_hash: auditHash,
        }] as unknown as readonly Row[],
        rowCount: 1,
      };
    }
    throw new Error("unexpected query: " + text);
  });

  const tx = { query } as unknown as SqlExecutor;
  return {
    async transaction<T>(work: (inner: SqlExecutor) => Promise<T>): Promise<T> {
      return work(tx);
    },
  };
}

describe("restore verification manifest", () => {
  it("captures only counts, hashes and tenant-safe metadata", async () => {
    const manifest = await captureRestoreVerificationManifest(database(), TENANT);
    expect(manifest.version).toBe(1);
    expect(manifest.schemaMigrationCount).toBe(4);
    expect(manifest.tenantRowCount).toBe(1);
    expect(manifest.webhookCount).toBe(1);
    expect(manifest.auditCount).toBe(1);
    for (const value of [
      manifest.schemaMigrationDigest,
      manifest.tenantBindingDigest,
      manifest.webhookDigest,
      manifest.auditDigest,
      manifest.auditHeadHash,
    ]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(manifest)).not.toContain("synthetic-org");
    expect(JSON.stringify(manifest)).not.toContain("synthetic-actor");
  });

  it("is deterministic for identical source and restored evidence", async () => {
    const a = await captureRestoreVerificationManifest(database(), TENANT);
    const b = await captureRestoreVerificationManifest(database(), TENANT);
    expect(a).toEqual(b);
    expect(() => assertRestoreManifestMatches(a, b)).not.toThrow();
  });

  it("fails closed when a restored webhook checksum set differs", async () => {
    const expected = await captureRestoreVerificationManifest(database(), TENANT);
    const actual = await captureRestoreVerificationManifest(
      database({ webhookKey: sha256Hex("different-event") }),
      TENANT,
    );
    expect(() => assertRestoreManifestMatches(expected, actual)).toThrow(
      /webhookDigest/,
    );
  });

  it("fails closed on audit tampering before a manifest can be accepted", async () => {
    await expect(
      captureRestoreVerificationManifest(
        database({ auditEntryHashOverride: sha256Hex("tampered") }),
        TENANT,
      ),
    ).rejects.toThrow(/integrity check failed/);
  });

  it("fails closed on a cross-tenant restored audit row", async () => {
    await expect(
      captureRestoreVerificationManifest(
        database({ tenantId: "00000000-0000-4000-8000-0000000000bb" }),
        TENANT,
      ),
    ).rejects.toThrow(/Cross-tenant/);
  });

  it("never includes differing manifest values in the mismatch error", () => {
    const base: RestoreVerificationManifest = {
      version: 1,
      tenantId: TENANT,
      schemaMigrationCount: 4,
      schemaMigrationDigest: "a".repeat(64),
      tenantRowCount: 1,
      tenantBindingDigest: "b".repeat(64),
      webhookCount: 1,
      webhookDigest: "c".repeat(64),
      auditCount: 1,
      auditDigest: "d".repeat(64),
      auditAnchorHash: null,
      auditHeadHash: "e".repeat(64),
    };
    const actual = { ...base, webhookDigest: "f".repeat(64) };
    let error: unknown;
    try {
      assertRestoreManifestMatches(base, actual);
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("webhookDigest");
    expect(String((error as Error).message)).not.toContain("f".repeat(64));
  });
});
