import { PersistenceValidationError } from "./types.js";

export const DEFAULT_MAX_WEBHOOK_EVENTS = 10_000;
// Must match both integrity scan limits and migration 006's DB ceiling.
export const MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY = 100_000;
export const DEFAULT_MAX_AUDIT_EVENTS = MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY;
export const DEFAULT_MAX_PERSISTENCE_BYTES = 64 * 1024 * 1024;
export const MAX_PERSISTED_SNAPSHOTS = 0;

export interface TenantStoragePolicy {
  readonly maxWebhookEvents: number;
  readonly maxAuditEvents: number;
  readonly maxPersistenceBytes: number;
}

export interface TenantStorageUsage {
  readonly webhookEvents: number;
  readonly auditEvents: number;
  readonly persistenceBytes: number;
}

function safeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceValidationError("Invalid " + label + ".");
  }
  return value;
}

export function assertTenantStorageWithinPolicy(
  policy: TenantStoragePolicy,
  usage: TenantStorageUsage,
): void {
  const maxWebhookEvents = safeCount(policy.maxWebhookEvents, "max webhook event limit");
  const maxAuditEvents = safeCount(policy.maxAuditEvents, "max audit event limit");
  const maxPersistenceBytes = safeCount(policy.maxPersistenceBytes, "max persistence byte limit");
  const webhookEvents = safeCount(usage.webhookEvents, "webhook event count");
  const auditEvents = safeCount(usage.auditEvents, "audit event count");
  const persistenceBytes = safeCount(usage.persistenceBytes, "persistence byte count");

  // A DB policy above the verifier window is invalid even if current usage
  // is small. Reject it before reporting storage as operationally safe.
  if (maxAuditEvents > MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY) {
    throw new PersistenceValidationError("Tenant audit policy exceeds verifiable integrity limit.");
  }
  if (auditEvents > MAX_AUDIT_EVENTS_WITH_FULL_INTEGRITY) {
    throw new PersistenceValidationError("Tenant audit history exceeds verifiable integrity limit.");
  }

  if (webhookEvents > maxWebhookEvents) {
    throw new PersistenceValidationError("Tenant webhook storage capacity exceeded.");
  }
  if (auditEvents > maxAuditEvents) {
    throw new PersistenceValidationError("Tenant audit storage capacity exceeded.");
  }
  if (persistenceBytes > maxPersistenceBytes) {
    throw new PersistenceValidationError("Tenant persistence byte capacity exceeded.");
  }
}
