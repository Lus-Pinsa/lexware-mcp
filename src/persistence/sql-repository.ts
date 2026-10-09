import { Buffer } from "node:buffer";
import { hashAuditEntry } from "./audit-chain.js";
import { assertWithinPersistenceLimit, PERSISTENCE_LIMITS } from "./limits.js";
import type {
  PersistenceMaintenanceRepository,
  PersistenceRepository,
  TenantDirectory,
} from "./repository.js";
import type { SqlDatabase, SqlSession } from "./sql.js";
import { withTenantTransaction } from "./sql.js";
import { asTenantId, type AuditEventInput, type PersistedWebhookEvent, type TenantId } from "./types.js";

interface AuditHeadRow extends Record<string, unknown> {
  currentHash: string | null;
}

interface TenantRow extends Record<string, unknown> {
  tenantId: string;
}

interface WebhookRow extends Record<string, unknown> {
  tenantId: string;
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
  quality: PersistedWebhookEvent["quality"];
  requestBudgetStatus: PersistedWebhookEvent["requestBudgetStatus"];
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Webhook list limit must be a positive integer.");
  assertWithinPersistenceLimit("pendingWebhookEventsPerTenant", limit);
  return limit;
}

function mapWebhookRow(row: WebhookRow): PersistedWebhookEvent {
  return {
    tenantId: asTenantId(row.tenantId),
    eventKeyHash: row.eventKeyHash,
    organizationHash: row.organizationHash,
    resourceIdCiphertext: row.resourceIdCiphertext,
    resourceIdNonce: row.resourceIdNonce,
    resourceIdAuthTag: row.resourceIdAuthTag,
    resourceIdKeyId: row.resourceIdKeyId,
    eventType: row.eventType,
    receivedAt: row.receivedAt,
    acknowledgedAt: row.acknowledgedAt,
    payloadSha256: row.payloadSha256,
    source: row.source,
    quality: row.quality,
    requestBudgetStatus: row.requestBudgetStatus,
  };
}

export class SqlTenantDirectory implements TenantDirectory {
  constructor(private readonly db: SqlDatabase) {}

  async resolveOrganizationHash(organizationHash: string): Promise<{ tenantId: TenantId } | null> {
    const result = await this.db.query<TenantRow>(
      'SELECT tenant_id::text AS "tenantId" FROM tenants WHERE organization_hash = $1 LIMIT 1',
      [organizationHash],
    );
    const row = result.rows[0];
    return row ? { tenantId: asTenantId(row.tenantId) } : null;
  }
}

export class SqlPersistenceRepository implements PersistenceRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insertWebhookEvent(
    tenantId: TenantId,
    event: Omit<PersistedWebhookEvent, "tenantId">,
  ): Promise<"inserted" | "duplicate"> {
    assertWithinPersistenceLimit(
      "encryptedResourceIdBytes",
      Buffer.byteLength(event.resourceIdCiphertext, "utf8"),
    );
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const result = await session.query(
        `INSERT INTO webhook_events (
          tenant_id, event_key_hash, organization_hash, resource_id_ciphertext,
          resource_id_nonce, resource_id_auth_tag, resource_id_key_id, event_type,
          received_at, acknowledged_at, payload_sha256, source, quality, request_budget_status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
        ) ON CONFLICT (tenant_id, event_key_hash) DO NOTHING`,
        [
          tenantId,
          event.eventKeyHash,
          event.organizationHash,
          event.resourceIdCiphertext,
          event.resourceIdNonce,
          event.resourceIdAuthTag,
          event.resourceIdKeyId,
          event.eventType,
          event.receivedAt,
          event.acknowledgedAt,
          event.payloadSha256,
          event.source,
          event.quality,
          event.requestBudgetStatus,
        ],
      );
      return result.rowCount === 1 ? "inserted" : "duplicate";
    });
  }

  async acknowledgeWebhookEvent(
    tenantId: TenantId,
    eventKeyHash: string,
    acknowledgedAt: string,
  ): Promise<boolean> {
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const result = await session.query(
        `UPDATE webhook_events
         SET acknowledged_at = $3
         WHERE tenant_id = $1 AND event_key_hash = $2 AND acknowledged_at IS NULL`,
        [tenantId, eventKeyHash, acknowledgedAt],
      );
      return result.rowCount === 1;
    });
  }

  async listPendingWebhookEvents(
    tenantId: TenantId,
    limit: number,
  ): Promise<PersistedWebhookEvent[]> {
    const safeLimit = requireLimit(limit);
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const result = await session.query<WebhookRow>(
        `SELECT
          tenant_id::text AS "tenantId",
          event_key_hash AS "eventKeyHash",
          organization_hash AS "organizationHash",
          resource_id_ciphertext AS "resourceIdCiphertext",
          resource_id_nonce AS "resourceIdNonce",
          resource_id_auth_tag AS "resourceIdAuthTag",
          resource_id_key_id AS "resourceIdKeyId",
          event_type AS "eventType",
          received_at::text AS "receivedAt",
          acknowledged_at::text AS "acknowledgedAt",
          payload_sha256 AS "payloadSha256",
          source,
          quality,
          request_budget_status AS "requestBudgetStatus"
        FROM webhook_events
        WHERE tenant_id = $1 AND acknowledged_at IS NULL
        ORDER BY received_at ASC, event_key_hash ASC
        LIMIT $2`,
        [tenantId, safeLimit],
      );
      return result.rows.map(mapWebhookRow);
    });
  }

  async appendAuditEvent(
    tenantId: TenantId,
    event: Omit<AuditEventInput, "tenantId">,
  ): Promise<void> {
    const occurredAt = this.now().toISOString();
    await withTenantTransaction(this.db, tenantId, async (session) => {
      const head = await session.query<AuditHeadRow>(
        `SELECT current_hash AS "currentHash"
         FROM audit_chain_heads
         WHERE tenant_id = $1
         FOR UPDATE`,
        [tenantId],
      );
      const headRow = head.rows[0];
      if (!headRow) throw new Error("Audit chain head unavailable for tenant.");

      const entryHash = hashAuditEntry({
        tenantId,
        ...event,
        occurredAt,
        previousHash: headRow.currentHash,
      });

      await session.query(
        `INSERT INTO audit_events (
          tenant_id, occurred_at, actor_hash, action, result, count, previous_hash, entry_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          tenantId,
          occurredAt,
          event.actorHash,
          event.action,
          event.result,
          event.count,
          headRow.currentHash,
          entryHash,
        ],
      );
      const update = await session.query(
        `UPDATE audit_chain_heads SET current_hash = $2 WHERE tenant_id = $1`,
        [tenantId, entryHash],
      );
      if (update.rowCount !== 1) throw new Error("Audit chain head update failed.");
    });
  }
}

export class SqlPersistenceMaintenanceRepository implements PersistenceMaintenanceRepository {
  constructor(private readonly db: SqlDatabase) {}

  async deleteExpiredWebhookEvents(tenantId: TenantId, before: string): Promise<number> {
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const result = await session.query(
        `DELETE FROM webhook_events
         WHERE tenant_id = $1
           AND acknowledged_at IS NOT NULL
           AND acknowledged_at < $2`,
        [tenantId, before],
      );
      return result.rowCount;
    });
  }

  async deleteExpiredAuditEvents(tenantId: TenantId, before: string): Promise<number> {
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const anchor = await session.query<{ entryHash: string }>(
        `SELECT entry_hash AS "entryHash"
         FROM audit_events
         WHERE tenant_id = $1 AND occurred_at < $2
         ORDER BY audit_id DESC
         LIMIT 1
         FOR UPDATE`,
        [tenantId, before],
      );
      const anchorHash = anchor.rows[0]?.entryHash;
      if (!anchorHash) return 0;

      await session.query(
        `UPDATE audit_chain_heads
         SET retention_anchor_hash = $2
         WHERE tenant_id = $1`,
        [tenantId, anchorHash],
      );
      const deleted = await session.query(
        `DELETE FROM audit_events
         WHERE tenant_id = $1 AND occurred_at < $2`,
        [tenantId, before],
      );
      return deleted.rowCount;
    });
  }

  async deleteTenantData(tenantId: TenantId): Promise<void> {
    const result = await this.db.query(
      "DELETE FROM tenants WHERE tenant_id = $1",
      [tenantId],
    );
    if (result.rowCount !== 1) throw new Error("Tenant deletion did not match exactly one tenant.");
  }
}

export function pendingWebhookEventLimit(): number {
  return PERSISTENCE_LIMITS.pendingWebhookEventsPerTenant;
}
