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

/**
 * PostgreSQL timestamptz round-trips to UTC with millisecond precision in
 * our JS driver. Hash the same canonical representation before INSERT.
 * A sub-millisecond digit that would be lost must fail closed.
 */
export function assertAuditTimestamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (match === null) {
    throw new PersistenceValidationError("Invalid audit timestamp.");
  }
  const [, yyyy, mm, dd, hh, minute, second, fraction = "", timezone] = match;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = monthLengths[month - 1] ?? 0;
  const offset = timezone === "Z" ? null : timezone.slice(1).replace(":", "");
  const offsetHour = offset === null ? 0 : Number(offset.slice(0, 2));
  const offsetMinute = offset === null ? 0 : Number(offset.slice(2));

  if (
    day < 1 || day > maxDay ||
    Number(hh) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    offsetHour > 14 || offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    (fraction.length > 3 && /[1-9]/.test(fraction.slice(3)))
  ) {
    throw new PersistenceValidationError("Invalid audit timestamp.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PersistenceValidationError("Invalid audit timestamp.");
  }
  return date.toISOString();
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
