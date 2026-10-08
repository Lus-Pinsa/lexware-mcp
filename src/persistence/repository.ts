import type { AuditEventInput, PersistedWebhookEvent, TenantId } from "./types.js";

export interface PersistenceRepository {
  getTenantByOrganizationHash(organizationHash: string): Promise<{ tenantId: TenantId } | null>;
  insertWebhookEvent(tenantId: TenantId, event: Omit<PersistedWebhookEvent, "tenantId">): Promise<"inserted" | "duplicate">;
  acknowledgeWebhookEvent(tenantId: TenantId, eventKeyHash: string, acknowledgedAt: string): Promise<boolean>;
  listPendingWebhookEvents(tenantId: TenantId, limit: number): Promise<PersistedWebhookEvent[]>;
  appendAuditEvent(tenantId: TenantId, event: Omit<AuditEventInput, "tenantId">): Promise<void>;
  deleteExpiredWebhookEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteExpiredAuditEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteTenantData(tenantId: TenantId): Promise<void>;
}
