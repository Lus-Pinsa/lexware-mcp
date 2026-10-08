import { sha256Hex } from "./crypto.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  assertUuidV4,
  parseTenantId,
} from "./types.js";

const ACTION_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const RESULT_PATTERN = /^[A-Z0-9_]{1,32}$/;

export interface AuditEntryInput {
  readonly auditId: string;
  readonly tenantId: TenantId;
  readonly actorHash: string;
  readonly action: string;
  readonly result: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly previousHash: string | null;
}

export function assertAuditAction(value: string): string {
  if (!ACTION_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid audit action.");
  }
  return value;
}

export function assertAuditResult(value: string): string {
  if (!RESULT_PATTERN.test(value)) {
    throw new PersistenceValidationError("Invalid audit result.");
  }
  return value;
}

export function assertAuditItemCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceValidationError("Invalid audit item count.");
  }
  return value;
}

export function assertAuditTimestamp(value: string): string {
  if (
    value.length < 20 ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new PersistenceValidationError("Invalid audit timestamp.");
  }
  return value;
}

export function validateAuditEntry(input: AuditEntryInput): AuditEntryInput {
  const normalized = Object.freeze({
    auditId: assertUuidV4(input.auditId, "audit id"),
    tenantId: parseTenantId(input.tenantId),
    actorHash: assertSha256Hex(input.actorHash, "audit actor hash"),
    action: assertAuditAction(input.action),
    result: assertAuditResult(input.result),
    itemCount: assertAuditItemCount(input.itemCount),
    createdAt: assertAuditTimestamp(input.createdAt),
    previousHash:
      input.previousHash === null ? null : assertSha256Hex(input.previousHash, "previous audit hash"),
  });
  return normalized;
}

export function computeAuditEntryHash(input: AuditEntryInput): string {
  const validated = validateAuditEntry(input);
  const canonical = JSON.stringify({
    v: 1,
    auditId: validated.auditId,
    tenantId: validated.tenantId,
    actorHash: validated.actorHash,
    action: validated.action,
    result: validated.result,
    itemCount: validated.itemCount,
    createdAt: validated.createdAt,
    previousHash: validated.previousHash,
  });
  return sha256Hex(canonical);
}
