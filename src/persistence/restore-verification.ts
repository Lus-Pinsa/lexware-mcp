import { createHash } from "node:crypto";
import { verifyAuditChainIntegrity } from "./integrity.js";
import {
  listAppliedSchemaMigrations,
  type PersistenceDatabase,
  withTenantTransaction,
} from "./repository.js";
import { readRestoreEvidenceRows } from "./restore-repository.js";
import { assertMigrationStateCurrent } from "./migration-runner.js";
import {
  type TenantId,
  PersistenceValidationError,
  parseTenantId,
} from "./types.js";

export interface RestoreVerificationManifest {
  readonly version: 1;
  readonly tenantId: TenantId;
  readonly schemaMigrationCount: number;
  readonly schemaMigrationDigest: string;
  readonly tenantRowCount: 0 | 1;
  readonly tenantBindingDigest: string;
  readonly webhookCount: number;
  readonly webhookDigest: string;
  readonly auditCount: number;
  readonly auditDigest: string;
  readonly auditAnchorHash: string | null;
  readonly auditHeadHash: string | null;
}

function encode(value: string): string {
  return Buffer.byteLength(value, "utf8") + ":" + value;
}

function digest(domain: string, rows: readonly (readonly string[])[]): string {
  const hash = createHash("sha256");
  hash.update("lus-restore-manifest-v1\0" + domain + "\0", "utf8");
  for (const row of rows) {
    hash.update(row.map(encode).join("|") + "\n", "utf8");
  }
  return hash.digest("hex");
}

export async function captureRestoreVerificationManifest(
  db: PersistenceDatabase,
  tenantIdInput: TenantId,
): Promise<RestoreVerificationManifest> {
  const tenantId = parseTenantId(tenantIdInput);

  const migrations = await db.transaction((tx) =>
    listAppliedSchemaMigrations(tx),
  );
  assertMigrationStateCurrent(migrations);

  const migrationDigest = digest(
    "schema-migrations",
    migrations.map((row) => [
      String(row.version),
      row.name,
      row.checksum,
    ]),
  );

  return withTenantTransaction(tenantId, db, async (tx) => {
    const evidence = await readRestoreEvidenceRows(tenantId, tx);
    const integrity = await verifyAuditChainIntegrity(tenantId, tx);

    const tenantBindingDigest = digest(
      "tenant-binding",
      evidence.tenantBinding === null
        ? []
        : [[
            evidence.tenantBinding.organizationIdHash,
            evidence.tenantBinding.status,
          ]],
    );

    const webhookDigest = digest(
      "webhook-events",
      evidence.webhookRows.map((row) => [
        row.eventKeyHash,
        row.payloadChecksum,
        row.receivedAt,
        row.acknowledgedAt ?? "",
      ]),
    );

    const auditDigest = digest(
      "audit-events",
      evidence.auditRows.map((row) => [row.auditId, row.entryHash]),
    );

    if (integrity.count !== evidence.auditRows.length) {
      throw new PersistenceValidationError(
        "Restore audit evidence count mismatch.",
      );
    }
    if (integrity.anchorHash !== evidence.auditAnchorHash) {
      throw new PersistenceValidationError(
        "Restore audit anchor mismatch.",
      );
    }

    return Object.freeze({
      version: 1 as const,
      tenantId,
      schemaMigrationCount: migrations.length,
      schemaMigrationDigest: migrationDigest,
      tenantRowCount: evidence.tenantBinding === null ? 0 : 1,
      tenantBindingDigest,
      webhookCount: evidence.webhookRows.length,
      webhookDigest,
      auditCount: evidence.auditRows.length,
      auditDigest,
      auditAnchorHash: evidence.auditAnchorHash,
      auditHeadHash: integrity.headHash,
    });
  });
}

const MANIFEST_FIELDS: readonly (keyof RestoreVerificationManifest)[] = [
  "version",
  "tenantId",
  "schemaMigrationCount",
  "schemaMigrationDigest",
  "tenantRowCount",
  "tenantBindingDigest",
  "webhookCount",
  "webhookDigest",
  "auditCount",
  "auditDigest",
  "auditAnchorHash",
  "auditHeadHash",
];

export function assertRestoreManifestMatches(
  expected: RestoreVerificationManifest,
  actual: RestoreVerificationManifest,
): void {
  const mismatches = MANIFEST_FIELDS.filter(
    (field) => expected[field] !== actual[field],
  );
  if (mismatches.length > 0) {
    throw new PersistenceValidationError(
      "Restore verification failed: " + mismatches.join(",") + ".",
    );
  }
}

export async function verifyRestoredDatabase(
  sourceDb: PersistenceDatabase,
  restoredDb: PersistenceDatabase,
  tenantId: TenantId,
): Promise<RestoreVerificationManifest> {
  const expected = await captureRestoreVerificationManifest(sourceDb, tenantId);
  const actual = await captureRestoreVerificationManifest(restoredDb, tenantId);
  assertRestoreManifestMatches(expected, actual);
  return actual;
}
