export type TenantId = string & { readonly __tenantId: unique symbol };

export function asTenantId(value: string): TenantId {
  const v = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
    throw new Error("Invalid tenant id.");
  }
  return v as TenantId;
}

export type DataQuality =
  | "STRUCTURED"
  | "DERIVED"
  | "UNVERIFIED"
  | "PLACEHOLDER"
  | "CONFLICT"
  | "MISSING";

export type RequestBudgetStatus = "OK" | "DEGRADED" | "EXHAUSTED";

export interface PersistedWebhookEvent {
  tenantId: TenantId;
  eventKeyHash: string;
  organizationHash: string;
  resourceIdCiphertext: string;
  resourceIdNonce: string;
  resourceIdAuthTag: string;
  resourceIdKeyId: string;
  eventType: "voucher.created";
  receivedAt: string;
  acknowledgedAt: string | null;
  payloadSha256: string;
  source: "lexware-webhook";
  quality: DataQuality;
  requestBudgetStatus: RequestBudgetStatus;
}

export interface AuditEventInput {
  tenantId: TenantId;
  actorHash: string;
  action:
    | "SCHEMA_MIGRATION"
    | "RESTORE"
    | "RETENTION_DELETE"
    | "TENANT_CREATE"
    | "TENANT_DELETE"
    | "TENANT_MISMATCH"
    | "INTEGRITY_FAILURE";
  result: "SUCCESS" | "DENIED" | "FAILED";
  count: number;
}
