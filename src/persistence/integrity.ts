import { computeAuditEntryHash, validateAuditEntry } from "./audit.js";
import {
  getAuditRetentionAnchor,
  listAuditChainEntries,
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
}

export async function verifyAuditChainIntegrity(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<AuditIntegrityResult> {
  const checkedTenantId = parseTenantId(tenantId);
  const anchorHash = await getAuditRetentionAnchor(checkedTenantId, tx);
  const rows = await listAuditChainEntries(checkedTenantId, tx);

  let expectedPrevious = anchorHash;
  let headHash = anchorHash;

  for (const row of rows) {
    if (row.previousHash !== expectedPrevious) {
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
    });
    const recomputed = computeAuditEntryHash(validated);
    if (recomputed !== assertSha256Hex(row.entryHash, "audit entry hash")) {
      throw new PersistenceValidationError("Audit chain integrity check failed.");
    }

    expectedPrevious = row.entryHash;
    headHash = row.entryHash;
  }

  return Object.freeze({
    count: rows.length,
    anchorHash,
    headHash,
  });
}
