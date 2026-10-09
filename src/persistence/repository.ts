import type { AuditEventInput, PersistedWebhookEvent, TenantId } from "./types.js";

/**
 * Global directory used only to resolve a verified Lexware organization hash to
 * its explicitly provisioned tenant. It is deliberately separate from tenant
 * data repositories so ordinary persistence access cannot become cross-tenant.
 */
export interface TenantDirectory {
  resolveOrganizationHash(organizationHash: string): Promise<{ tenantId: TenantId } | null>;
}

export interface PersistenceRepository {
  insertWebhookEvent(
    tenantId: TenantId,
    event: Omit<PersistedWebhookEvent, "tenantId">,
  ): Promise<"inserted" | "duplicate">;
  acknowledgeWebhookEvent(
    tenantId: TenantId,
    eventKeyHash: string,
    acknowledgedAt: string,
  ): Promise<boolean>;
  listPendingWebhookEvents(
    tenantId: TenantId,
    limit: number,
  ): Promise<PersistedWebhookEvent[]>;
  appendAuditEvent(
    tenantId: TenantId,
    event: Omit<AuditEventInput, "tenantId">,
  ): Promise<void>;
  deleteExpiredWebhookEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteExpiredAuditEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteTenantData(tenantId: TenantId): Promise<void>;
}
