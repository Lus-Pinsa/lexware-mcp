import {
  parseChainSeq,
  type SqlExecutor,
} from "./repository.js";
import { MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY } from "./capacity.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

const SQL_GET_AUDIT_ANCHOR =
  "SELECT previous_hash, last_pruned_seq FROM audit_retention_anchors WHERE tenant_id = $1";

// Chain order is the append ordinal. Event time and UUID are data, not order.
const SQL_LIST_AUDIT_CHAIN =
  "SELECT audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash, chain_seq, chain_version " +
  "FROM audit_events WHERE tenant_id = $1 ORDER BY chain_seq ASC LIMIT $2";

export interface StoredAuditEntry {
  readonly auditId: string;
  readonly tenantId: TenantId;
  readonly actorHash: string;
  readonly action: string;
  readonly result: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly previousHash: string | null;
  readonly entryHash: string;
  readonly chainSeq: number;
  readonly chainVersion: number;
}

export interface AuditRetentionAnchor {
  /** entry_hash of the last pruned entry: the predecessor of the first retained entry. */
  readonly hash: string;
  /** chain_seq of the last pruned entry. */
  readonly lastPrunedSeq: number;
}

function timestamp(value: string | Date): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (
    text.length < 20 ||
    text.length > 40 ||
    Number.isNaN(Date.parse(text))
  ) {
    throw new PersistenceValidationError("Invalid audit chain timestamp.");
  }
  return text;
}

export async function getAuditRetentionAnchor(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<AuditRetentionAnchor | null> {
  const checkedTenantId = parseTenantId(tenantId);
  const result = await tx.query<{ previous_hash: string; last_pruned_seq: unknown }>({
    text: SQL_GET_AUDIT_ANCHOR,
    values: [checkedTenantId],
  });
  if (result.rowCount > 1 || result.rows.length > 1) {
    throw new PersistenceValidationError("Invalid audit retention anchor cardinality.");
  }
  const row = result.rows[0];
  return row === undefined
    ? null
    : Object.freeze({
        hash: assertSha256Hex(row.previous_hash, "audit retention anchor"),
        lastPrunedSeq: parseChainSeq(row.last_pruned_seq, "audit retention anchor position"),
      });
}

export async function listAuditChainEntries(
  tenantId: TenantId,
  tx: SqlExecutor,
  limit = MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY,
): Promise<readonly StoredAuditEntry[]> {
  const checkedTenantId = parseTenantId(tenantId);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY) {
    throw new PersistenceValidationError("Audit integrity limit must be an integer from 1 to 100000.");
  }
  const result = await tx.query<{
    audit_id: string;
    tenant_id: string;
    actor_hash: string;
    action: string;
    result: string;
    item_count: number;
    created_at: string | Date;
    previous_hash: string | null;
    entry_hash: string;
    chain_seq: unknown;
    chain_version: unknown;
  }>({
    text: SQL_LIST_AUDIT_CHAIN,
    // Request one sentinel beyond the maximum: a truncated hash chain must
    // never be mistaken for a fully verified chain before audit retention.
    values: [checkedTenantId, limit + 1],
  });

  if (result.rows.length > limit || result.rowCount > limit) {
    throw new PersistenceValidationError(
      "Audit chain exceeds the integrity verification limit.",
    );
  }

  return Object.freeze(
    result.rows.map((row) => {
      const returnedTenantId = parseTenantId(row.tenant_id);
      if (returnedTenantId !== checkedTenantId) {
        throw new PersistenceValidationError("Cross-tenant audit row rejected.");
      }
      return Object.freeze({
        auditId: row.audit_id,
        tenantId: returnedTenantId,
        actorHash: assertSha256Hex(row.actor_hash, "audit actor hash"),
        action: row.action,
        result: row.result,
        itemCount: row.item_count,
        createdAt: timestamp(row.created_at),
        previousHash:
          row.previous_hash === null
            ? null
            : assertSha256Hex(row.previous_hash, "audit previous hash"),
        entryHash: assertSha256Hex(row.entry_hash, "audit entry hash"),
        chainSeq: parseChainSeq(row.chain_seq, "audit chain position"),
        chainVersion: Number(row.chain_version),
      });
    }),
  );
}
