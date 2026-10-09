import type { AuditEventInput, PersistedWebhookEvent, TenantId } from "./types.js";

/**
 * Global directory used only to resolve a verified Lexware organization hash to
 * its explicitly provisioned tenant. It is deliberately separate from tenant
 * data repositories so ordinary persistence access cannot become cross-tenant.
 */
export interface TenantDirectory {
  resolveOrganizationHash(organizationHash: string): Promise<{ tenantId: TenantId } | null>;
}

/** Runtime repository: ordinary request handling, no destructive maintenance. */
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
}

/**
 * Maintenance repository: retention / tenant deletion only.
 * It must be wired to a separate maintenance credential, never the runtime role.
 */
export interface PersistenceMaintenanceRepository {
  deleteExpiredWebhookEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteExpiredAuditEvents(tenantId: TenantId, before: string): Promise<number>;
  deleteTenantData(tenantId: TenantId): Promise<void>;
}
