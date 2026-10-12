import { AUDIT_CHAIN_VERSION, computeAuditEntryHash, validateAuditEntry } from "./audit.js";
import {
  getAuditRetentionAnchor,
  listAuditChainEntries,
  type StoredAuditEntry,
} from "./integrity-repository.js";
import type { SqlExecutor } from "./repository.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

export interface AuditIntegrityResult {
  readonly count: number;
  readonly anchorHash: string | null;
  readonly headHash: string | null;
  /** chain_seq of the head (or of the anchor when the retained chain is empty; 0 for an empty, unanchored chain). */
  readonly headSeq: number;
}

export async function verifyAuditChainIntegrity(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<AuditIntegrityResult> {
  return (await verifyAuditChain(tenantId, tx)).result;
}

/**
 * Verify the complete retained chain and return the verified entries in append order (for retention, which may
 * only act on entries it has just verified). Throws on any inconsistency or when the chain exceeds the window.
 */
export async function verifyAuditChain(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<{ readonly result: AuditIntegrityResult; readonly entries: readonly StoredAuditEntry[] }> {
  const checkedTenantId = parseTenantId(tenantId);
  const anchor = await getAuditRetentionAnchor(checkedTenantId, tx);
  const anchorHash = anchor?.hash ?? null;
  const rows = await listAuditChainEntries(checkedTenantId, tx);

  // Each retained entry must sit at exactly the next position (no gap, duplicate or reordering) and link to the
  // hash of its predecessor; the first one links to the retention anchor (position and hash) or is the root.
  let expectedPrevious = anchorHash;
  let expectedSeq = (anchor?.lastPrunedSeq ?? 0) + 1;
  let headHash = anchorHash;

  for (const row of rows) {
    if (row.chainSeq !== expectedSeq || row.chainVersion !== AUDIT_CHAIN_VERSION || row.previousHash !== expectedPrevious) {
      throw new PersistenceValidationError("Audit chain integrity check failed.");
    }

    const validated = validateAuditEntry({
      auditId: row.auditId,
      tenantId: checkedTenantId,
      actorHash: row.actorHash,
      action: row.action,
      result: row.result,
      itemCount: row.itemCount,
      createdAt: row.createdAt,
      previousHash: row.previousHash,
      chainSeq: row.chainSeq,
    });
    const recomputed = computeAuditEntryHash(validated);
    if (recomputed !== assertSha256Hex(row.entryHash, "audit entry hash")) {
      throw new PersistenceValidationError("Audit chain integrity check failed.");
    }

    expectedPrevious = row.entryHash;
    headHash = row.entryHash;
    expectedSeq += 1;
  }

  const result: AuditIntegrityResult = Object.freeze({
    count: rows.length,
    anchorHash,
    headHash,
    headSeq: expectedSeq - 1,
  });
  return Object.freeze({ result, entries: rows });
}
