import { verifyAuditChainIntegrity } from "./integrity.js";
import {
  lockTenantForUpdate,
  type SqlExecutor,
} from "./repository.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

const SQL_DELETE_ACKNOWLEDGED_WEBHOOKS =
  "DELETE FROM webhook_events " +
  "WHERE tenant_id = $1 AND acknowledged_at IS NOT NULL AND acknowledged_at < $2";

const SQL_LAST_EXPIRED_AUDIT =
  "SELECT entry_hash FROM audit_events " +
  "WHERE tenant_id = $1 AND created_at < $2 " +
  "ORDER BY created_at DESC, audit_id DESC LIMIT 1";

const SQL_FIRST_RETAINED_AUDIT =
  "SELECT previous_hash FROM audit_events " +
  "WHERE tenant_id = $1 AND created_at >= $2 " +
  "ORDER BY created_at ASC, audit_id ASC LIMIT 1";

const SQL_UPSERT_AUDIT_ANCHOR =
  "INSERT INTO audit_retention_anchors (tenant_id, previous_hash, updated_at) " +
  "VALUES ($1,$2,$3) " +
  "ON CONFLICT (tenant_id) DO UPDATE SET previous_hash = EXCLUDED.previous_hash, updated_at = EXCLUDED.updated_at";

const SQL_DELETE_EXPIRED_AUDIT =
  "DELETE FROM audit_events WHERE tenant_id = $1 AND created_at < $2";

const SQL_DELETE_TENANT =
  "DELETE FROM tenants WHERE tenant_id = $1";

function assertIsoTimestamp(value: string, field: string): string {
  if (
    value.length < 20 ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return value;
}

export async function deleteExpiredAcknowledgedWebhookEvents(
  tenantId: TenantId,
  tx: SqlExecutor,
  before: string,
): Promise<number> {
  const checkedTenantId = parseTenantId(tenantId);
  const cutoff = assertIsoTimestamp(before, "webhook retention cutoff");
  await lockTenantForUpdate(checkedTenantId, tx);

  const result = await tx.query({
    text: SQL_DELETE_ACKNOWLEDGED_WEBHOOKS,
    values: [checkedTenantId, cutoff],
  });
  if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0) {
    throw new PersistenceValidationError("Invalid webhook retention delete count.");
  }
  return result.rowCount;
}

export async function deleteExpiredAuditEvents(
  tenantId: TenantId,
  tx: SqlExecutor,
  before: string,
  updatedAt: string,
): Promise<number> {
  const checkedTenantId = parseTenantId(tenantId);
  const cutoff = assertIsoTimestamp(before, "audit retention cutoff");
  const anchorUpdatedAt = assertIsoTimestamp(updatedAt, "audit retention timestamp");
  await lockTenantForUpdate(checkedTenantId, tx);

  const anchorCandidate = await tx.query<{ entry_hash: string }>({
    text: SQL_LAST_EXPIRED_AUDIT,
    values: [checkedTenantId, cutoff],
  });
  const lastExpired = anchorCandidate.rows[0];
  if (lastExpired === undefined) return 0;
  const anchorHash = assertSha256Hex(lastExpired.entry_hash, "audit retention anchor");

  // Pruning must not turn a corrupted or truncated chain into an apparently
  // valid history. The caller holds the tenant lock in a pinned transaction.
  const integrity = await verifyAuditChainIntegrity(checkedTenantId, tx);
  if (integrity.count < 1) {
    throw new PersistenceValidationError("Audit retention integrity verification found no source events.");
  }

  // A time-based deletion is safe only for a prefix of the hash chain.
  // If any entry survives, its first previous_hash must match the anchor.
  const boundary = await tx.query<{ previous_hash: string | null }>({
    text: SQL_FIRST_RETAINED_AUDIT,
    values: [checkedTenantId, cutoff],
  });
  if (boundary.rowCount > 1 || boundary.rows.length > 1) {
    throw new PersistenceValidationError("Invalid audit retention boundary cardinality.");
  }
  const firstRetained = boundary.rows[0];
  if (firstRetained !== undefined && firstRetained.previous_hash !== anchorHash) {
    throw new PersistenceValidationError("Audit retention cutoff is not a chain prefix.");
  }

  const anchor = await tx.query({
    text: SQL_UPSERT_AUDIT_ANCHOR,
    values: [checkedTenantId, anchorHash, anchorUpdatedAt],
  });
  if (anchor.rowCount !== 1) {
    throw new PersistenceValidationError("Audit retention anchor update failed.");
  }

  const deleted = await tx.query({
    text: SQL_DELETE_EXPIRED_AUDIT,
    values: [checkedTenantId, cutoff],
  });
  if (!Number.isSafeInteger(deleted.rowCount) || deleted.rowCount < 0) {
    throw new PersistenceValidationError("Invalid audit retention delete count.");
  }
  return deleted.rowCount;
}

/**
 * Operator-only tenant deletion. The caller must run inside a tenant-bound
 * transaction using a dedicated maintenance/operator DB role.
 */
export async function deleteTenantData(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<void> {
  const checkedTenantId = parseTenantId(tenantId);
  await lockTenantForUpdate(checkedTenantId, tx);
  const deleted = await tx.query({
    text: SQL_DELETE_TENANT,
    values: [checkedTenantId],
  });
  if (deleted.rowCount !== 1) {
    throw new PersistenceValidationError(
      "Tenant deletion did not match exactly one tenant.",
    );
  }
}
