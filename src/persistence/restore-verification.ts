import { createHash } from "node:crypto";
import { verifyAuditChainIntegrity } from "./integrity.js";
import {
  listAppliedSchemaMigrations,
  type PersistenceDatabase,
  withTenantTransaction,
} from "./repository.js";
import { readRestoreCompletenessScope, readRestoreEvidenceRows } from "./restore-repository.js";
import { assertMigrationStateCurrent } from "./migration-runner.js";
import { verifySchemaSafety } from "./schema-safety-repository.js";
import {
  type TenantId,
  PersistenceValidationError,
  parseTenantId,
} from "./types.js";

export interface RestoreVerificationManifest {
  readonly version: 2;
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
  readonly auditAnchorSeq: number | null;
  readonly auditHeadHash: string | null;
}

function encode(value: string): string {
  return Buffer.byteLength(value, "utf8") + ":" + value;
}

function digest(domain: string, rows: readonly (readonly string[])[]): string {
  const hash = createHash("sha256");
  hash.update("lus-restore-manifest-v2\0" + domain + "\0", "utf8");
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
  // A restore must also bring back the schema's safety objects (RLS, policies, append guard, guard indexes);
  // a dump restored without them would otherwise compare equal on data alone.
  await db.transaction((tx) => verifySchemaSafety(tx));

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
            evidence.tenantBinding.capabilityTier,
            evidence.tenantBinding.policyFingerprint,
          ]],
    );

    const webhookDigest = digest(
      "webhook-events",
      evidence.webhookRows.map((row) => [
        row.eventKeyHash,
        row.payloadChecksum,
        row.receivedAt,
        row.acknowledgedAt ?? "",
        row.rowFingerprint,
      ]),
    );

    const auditDigest = digest(
      "audit-events",
      evidence.auditRows.map((row) => [row.auditId, row.entryHash, row.createdEpoch]),
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
      version: 2 as const,
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
      auditAnchorSeq: evidence.auditAnchorSeq,
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
  "auditAnchorSeq",
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

/**
 * Database-wide restore evidence (C-03). The tenant-scoped manifest above proves one tenant; a restore that drops,
 * alters or adds other tenants would still pass it. This manifest covers the exact tenant set, the runtime bindings
 * (migration 010), every tenant's full manifest and the total row count of every tenant table, so rows outside the
 * per-tenant pass are detected as well.
 *
 * Row-level security hides other tenants from every ordinary role, including the FORCE-RLS table owner. Completeness
 * can therefore only be proven by a dedicated read-only verifier role that bypasses row-level security; any other role
 * fails closed instead of reporting a partial view as complete.
 */
export interface CompleteRestoreManifest {
  readonly version: 3;
  readonly tenantCount: number;
  readonly tenantSetDigest: string;
  readonly runtimeBindingDigest: string;
  readonly tableRowCountsDigest: string;
  readonly tenants: readonly RestoreVerificationManifest[];
}

export async function captureCompleteRestoreManifest(
  db: PersistenceDatabase,
): Promise<CompleteRestoreManifest> {
  const scope = await db.transaction((tx) => readRestoreCompletenessScope(tx));

  const tenants: RestoreVerificationManifest[] = [];
  for (const tenantId of scope.tenantIds) {
    tenants.push(await captureRestoreVerificationManifest(db, tenantId));
  }
  const perTenantWebhooks = tenants.reduce((sum, t) => sum + t.webhookCount, 0);
  const perTenantAudit = tenants.reduce((sum, t) => sum + t.auditCount, 0);
  // With the foreign keys to tenants every row belongs to a listed tenant; a mismatch means rows the per-tenant
  // evidence did not cover (e.g. a dropped constraint), which must not pass as complete.
  if (String(perTenantWebhooks) !== scope.counts[1] || String(perTenantAudit) !== scope.counts[2]) {
    throw new PersistenceValidationError("Restore completeness row coverage mismatch.");
  }

  return Object.freeze({
    version: 3 as const,
    tenantCount: scope.tenantIds.length,
    tenantSetDigest: digest("tenant-set", scope.tenantIds.map((id) => [id])),
    runtimeBindingDigest: digest("runtime-bindings", scope.bindings.map(([role, tenant]) => [role, tenant])),
    tableRowCountsDigest: digest("table-row-counts", [scope.counts]),
    tenants: Object.freeze(tenants),
  });
}

const COMPLETE_MANIFEST_FIELDS = ["version", "tenantCount", "tenantSetDigest", "runtimeBindingDigest", "tableRowCountsDigest"] as const;

export function assertCompleteRestoreManifestMatches(
  expected: CompleteRestoreManifest,
  actual: CompleteRestoreManifest,
): void {
  const mismatches: string[] = COMPLETE_MANIFEST_FIELDS.filter((field) => expected[field] !== actual[field]);
  if (mismatches.length > 0) {
    throw new PersistenceValidationError("Restore completeness verification failed: " + mismatches.join(",") + ".");
  }
  // Same tenant set (checked above), so the per-tenant manifests pair up in order.
  expected.tenants.forEach((tenant, i) => {
    const restored = actual.tenants[i];
    if (restored === undefined || restored.tenantId !== tenant.tenantId) {
      throw new PersistenceValidationError("Restore completeness verification failed: tenantSet.");
    }
    assertRestoreManifestMatches(tenant, restored);
  });
}

export async function verifyRestoredDatabaseComplete(
  sourceDb: PersistenceDatabase,
  restoredDb: PersistenceDatabase,
): Promise<CompleteRestoreManifest> {
  const expected = await captureCompleteRestoreManifest(sourceDb);
  const actual = await captureCompleteRestoreManifest(restoredDb);
  assertCompleteRestoreManifestMatches(expected, actual);
  return actual;
}
