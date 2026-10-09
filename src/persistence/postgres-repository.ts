import { hashAuditEntry } from "./audit-chain.js";
import { assertWithinPersistenceLimit } from "./limits.js";
import type { PersistenceRepository, TenantDirectory } from "./repository.js";
import { withTenantTransaction, type SqlDatabase, type SqlSession } from "./sql.js";
import { asTenantId, type AuditEventInput, type PersistedWebhookEvent, type TenantId } from "./types.js";

interface CountRow extends Record<string, unknown> {
  count: number | string;
}

interface HashRow extends Record<string, unknown> {
  entry_hash: string;
}

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
}

interface WebhookRow extends Record<string, unknown> {
  tenant_id: string;
  event_key_hash: string;
  organization_hash: string;
  resource_id_ciphertext: string;
  resource_id_nonce: string;
  resource_id_auth_tag: string;
  resource_id_key_id: string;
  event_type: "voucher.created";
  received_at: string | Date;
  acknowledged_at: string | Date | null;
  payload_sha256: string;
  source: "lexware-webhook";
  quality: PersistedWebhookEvent["quality"];
  request_budget_status: PersistedWebhookEvent["requestBudgetStatus"];
}

function countOf(row: CountRow | undefined): number {
  const raw = row?.count;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid persistence count returned by database.");
  return n;
}

function iso(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid persistence timestamp returned by database.");
  return d.toISOString();
}

function mapWebhookRow(row: WebhookRow): PersistedWebhookEvent {
  return {
    tenantId: asTenantId(row.tenant_id),
    eventKeyHash: row.event_key_hash,
    organizationHash: row.organization_hash,
    resourceIdCiphertext: row.resource_id_ciphertext,
    resourceIdNonce: row.resource_id_nonce,
    resourceIdAuthTag: row.resource_id_auth_tag,
    resourceIdKeyId: row.resource_id_key_id,
    eventType: row.event_type,
    receivedAt: iso(row.received_at),
    acknowledgedAt: row.acknowledged_at === null ? null : iso(row.acknowledged_at),
    payloadSha256: row.payload_sha256,
    source: row.source,
    quality: row.quality,
    requestBudgetStatus: row.request_budget_status,
  };
}

async function lockTenant(session: SqlSession, tenantId: TenantId): Promise<void> {
  const result = await session.query<TenantRow>(
    "SELECT tenant_id::text AS tenant_id FROM tenants WHERE tenant_id = $1 FOR UPDATE",
    [tenantId],
  );
  if (result.rows.length !== 1) throw new Error("Persistence tenant is not provisioned.");
}

/**
 * Minimal global directory. Wire this to a DB role that can only SELECT the
 * tenant directory; it must not share the ordinary tenant-data credential.
 */
export class PostgresTenantDirectory implements TenantDirectory {
  constructor(private readonly db: SqlSession) {}

  async resolveOrganizationHash(organizationHash: string): Promise<{ tenantId: TenantId } | null> {
    const result = await this.db.query<TenantRow>(
      "SELECT tenant_id::text AS tenant_id FROM tenants WHERE organization_hash = $1",
      [organizationHash],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error("Persistence tenant directory integrity failure.");
    return { tenantId: asTenantId(result.rows[0]!.tenant_id) };
  }
}

export class PostgresPersistenceRepository implements PersistenceRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insertWebhookEvent(
    tenantId: TenantId,
    event: Omit<PersistedWebhookEvent, "tenantId">,
  ): Promise<"inserted" | "duplicate"> {
    return withTenantTransaction(this.db, tenantId, async (session) => {
      await lockTenant(session, tenantId);

      const existing = await session.query(
        "SELECT 1 FROM webhook_events WHERE tenant_id = $1 AND event_key_hash = $2 LIMIT 1",
        [tenantId, event.eventKeyHash],
      );
      if (existing.rows.length > 0) return "duplicate";

      const pending = await session.query<CountRow>(
        "SELECT count(*)::int AS count FROM webhook_events WHERE tenant_id = $1 AND acknowledged_at IS NULL",
        [tenantId],
      );
      assertWithinPersistenceLimit(
        "pendingWebhookEventsPerTenant",
        countOf(pending.rows[0]) + 1,
      );

      const resourceBytes = Buffer.byteLength(event.resourceIdCiphertext, "utf8");
      assertWithinPersistenceLimit("encryptedResourceIdBytes", resourceBytes);

      const inserted = await session.query(
        `INSERT INTO webhook_events (
          tenant_id, event_key_hash, organization_hash,
          resource_id_ciphertext, resource_id_nonce, resource_id_auth_tag, resource_id_key_id,
          event_type, received_at, acknowledged_at, payload_sha256, source, quality, request_budget_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (tenant_id, event_key_hash) DO NOTHING
        RETURNING 1`,
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
      return inserted.rows.length === 1 ? "inserted" : "duplicate";
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
         SET acknowledged_at = COALESCE(acknowledged_at, $3::timestamptz)
         WHERE tenant_id = $1 AND event_key_hash = $2
         RETURNING 1`,
        [tenantId, eventKeyHash, acknowledgedAt],
      );
      return result.rows.length === 1;
    });
  }

  async listPendingWebhookEvents(
    tenantId: TenantId,
    limit: number,
  ): Promise<PersistedWebhookEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Invalid pending webhook event limit.");
    }
    return withTenantTransaction(this.db, tenantId, async (session) => {
      const result = await session.query<WebhookRow>(
        `SELECT
           tenant_id::text AS tenant_id, event_key_hash, organization_hash,
           resource_id_ciphertext, resource_id_nonce, resource_id_auth_tag, resource_id_key_id,
           event_type, received_at, acknowledged_at, payload_sha256, source, quality, request_budget_status
         FROM webhook_events
         WHERE tenant_id = $1 AND acknowledged_at IS NULL
         ORDER BY received_at ASC, event_key_hash ASC
         LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map(mapWebhookRow);
    });
  }

  async appendAuditEvent(
    tenantId: TenantId,
    event: Omit<AuditEventInput, "tenantId">,
  ): Promise<void> {
    await withTenantTransaction(this.db, tenantId, async (session) => {
      await lockTenant(session, tenantId);
      const countResult = await session.query<CountRow>(
        "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1",
        [tenantId],
      );
      assertWithinPersistenceLimit("auditEventsPerTenant", countOf(countResult.rows[0]) + 1);

      const previous = await session.query<HashRow>(
        `SELECT entry_hash
         FROM audit_events
         WHERE tenant_id = $1
         ORDER BY audit_id DESC
         LIMIT 1`,
        [tenantId],
      );
      const previousHash = previous.rows[0]?.entry_hash ?? null;
      const occurredAt = this.now().toISOString();
      const entryHash = hashAuditEntry({
        tenantId,
        actorHash: event.actorHash,
        action: event.action,
        result: event.result,
        count: event.count,
        occurredAt,
        previousHash,
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
          previousHash,
          entryHash,
        ],
      );
    });
  }
}
