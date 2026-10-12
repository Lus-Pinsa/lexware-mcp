import { verifyAuditChain } from "./integrity.js";
import {
  lockTenantForUpdate,
  type SqlExecutor,
} from "./repository.js";
import {
  type TenantId,
  PersistenceValidationError,
  parseTenantId,
} from "./types.js";

const SQL_DELETE_ACKNOWLEDGED_WEBHOOKS =
  "DELETE FROM webhook_events " +
  "WHERE tenant_id = $1 AND acknowledged_at IS NOT NULL AND acknowledged_at < $2";

const SQL_UPSERT_AUDIT_ANCHOR =
  "INSERT INTO audit_retention_anchors (tenant_id, previous_hash, last_pruned_seq, updated_at) " +
  "VALUES ($1,$2,$3,$4) " +
  "ON CONFLICT (tenant_id) DO UPDATE SET previous_hash = EXCLUDED.previous_hash, " +
  "last_pruned_seq = EXCLUDED.last_pruned_seq, updated_at = EXCLUDED.updated_at";

// Deletes exactly the verified prefix by position; never a bare "created_at < cutoff" on the chain.
const SQL_DELETE_AUDIT_PREFIX =
  "DELETE FROM audit_events WHERE tenant_id = $1 AND chain_seq <= $2";

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

/**
 * Prune the expired PREFIX of a tenant's audit chain, in one tenant-locked transaction:
 * verify the complete chain → take the longest prefix in append order whose entries are all older than the cutoff
 * (stop at the first newer entry, even if later entries are older) → move the anchor to the last pruned entry
 * (hash and position) → delete exactly that prefix → verify the remaining chain. Any mismatch throws and the caller's
 * transaction rolls back without deletion.
 */
export async function deleteExpiredAuditEvents(
  tenantId: TenantId,
  tx: SqlExecutor,
  before: string,
  updatedAt: string,
): Promise<number> {
  const checkedTenantId = parseTenantId(tenantId);
  const cutoff = assertIsoTimestamp(before, "audit retention cutoff");
  const cutoffMs = Date.parse(cutoff);
  const anchorUpdatedAt = assertIsoTimestamp(updatedAt, "audit retention timestamp");
  await lockTenantForUpdate(checkedTenantId, tx);

  // Pruning must not turn a corrupted or truncated chain into an apparently valid history.
  const { entries } = await verifyAuditChain(checkedTenantId, tx);
  let prefix = 0;
  while (prefix < entries.length && Date.parse(entries[prefix].createdAt) < cutoffMs) prefix += 1;
  if (prefix === 0) return 0;
  const lastPruned = entries[prefix - 1];

  const anchor = await tx.query({
    text: SQL_UPSERT_AUDIT_ANCHOR,
    values: [checkedTenantId, lastPruned.entryHash, lastPruned.chainSeq, anchorUpdatedAt],
  });
  if (anchor.rowCount !== 1) {
    throw new PersistenceValidationError("Audit retention anchor update failed.");
  }

  const deleted = await tx.query({
    text: SQL_DELETE_AUDIT_PREFIX,
    values: [checkedTenantId, lastPruned.chainSeq],
  });
  if (deleted.rowCount !== prefix) {
    throw new PersistenceValidationError("Audit retention deleted an unexpected number of entries.");
  }

  // The remaining chain must start exactly at the new anchor.
  const after = await verifyAuditChain(checkedTenantId, tx);
  if (after.result.count !== entries.length - prefix) {
    throw new PersistenceValidationError("Audit chain integrity check failed after retention.");
  }
  return prefix;
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
