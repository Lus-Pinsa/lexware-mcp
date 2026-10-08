import {
  type EncryptedValue,
  type QualityStatus,
  type RequestBudgetStatus,
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

export interface QueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(statement: {
    readonly text: string;
    readonly values: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

export interface PersistenceDatabase {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface TenantBinding {
  readonly tenantId: TenantId;
  readonly organizationIdHash: string;
  readonly status: "active" | "disabled";
}

export interface WebhookEventInsert {
  readonly eventKeyHash: string;
  readonly eventType: "voucher.created";
  readonly resource: EncryptedValue;
  readonly receivedAt: string;
  readonly payloadChecksum: string;
  readonly source: "lexware_webhook";
  readonly requestBudgetStatus: RequestBudgetStatus;
  readonly qualityStatus: QualityStatus;
}

export interface PendingWebhookEvent {
  readonly eventKeyHash: string;
  readonly eventType: "voucher.created";
  readonly resource: EncryptedValue;
  readonly receivedAt: string;
  readonly payloadChecksum: string;
  readonly source: "lexware_webhook";
  readonly requestBudgetStatus: RequestBudgetStatus;
  readonly qualityStatus: QualityStatus;
}

const SQL_SET_TENANT = "SELECT set_config('app.tenant_id', $1, true) AS tenant_id";
const SQL_GET_TENANT =
  "SELECT tenant_id, organization_id_hash, status FROM tenants WHERE tenant_id = $1";
const SQL_INSERT_WEBHOOK =
  "INSERT INTO webhook_events " +
  "(tenant_id, event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, received_at, payload_checksum, source, request_budget_status, quality_status) " +
  "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) " +
  "ON CONFLICT (tenant_id, event_key_hash) DO NOTHING";
const SQL_LIST_PENDING =
  "SELECT event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, received_at, payload_checksum, source, request_budget_status, quality_status " +
  "FROM webhook_events WHERE tenant_id = $1 AND acknowledged_at IS NULL ORDER BY received_at ASC, event_key_hash ASC LIMIT $2";
const SQL_ACK_EVENT =
  "UPDATE webhook_events SET acknowledged_at = $3 " +
  "WHERE tenant_id = $1 AND event_key_hash = $2 AND acknowledged_at IS NULL";

function assertIsoTimestamp(value: string, field: string): string {
  if (
    value.length < 20 ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  ) {
    throw new PersistenceValidationError(`Invalid ${field}.`);
  }
  return value;
}

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export async function withTenantTransaction<T>(
  tenantId: TenantId,
  db: PersistenceDatabase,
  work: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  const checkedTenantId = parseTenantId(tenantId);
  return db.transaction(async (tx) => {
    await tx.query({ text: SQL_SET_TENANT, values: [checkedTenantId] });
    return work(tx);
  });
}

export async function getTenantBinding(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<TenantBinding | null> {
  const checkedTenantId = parseTenantId(tenantId);
  const result = await tx.query<{
    tenant_id: string;
    organization_id_hash: string;
    status: "active" | "disabled";
  }>({ text: SQL_GET_TENANT, values: [checkedTenantId] });

  const row = result.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    tenantId: parseTenantId(row.tenant_id),
    organizationIdHash: assertSha256Hex(row.organization_id_hash, "organization id hash"),
    status: row.status,
  });
}

export async function insertWebhookEvent(
  tenantId: TenantId,
  tx: SqlExecutor,
  event: WebhookEventInsert,
): Promise<{ readonly inserted: boolean }> {
  const checkedTenantId = parseTenantId(tenantId);
  const eventKeyHash = assertSha256Hex(event.eventKeyHash, "event key hash");
  const payloadChecksum = assertSha256Hex(event.payloadChecksum, "payload checksum");
  const receivedAt = assertIsoTimestamp(event.receivedAt, "receivedAt");

  const result = await tx.query({
    text: SQL_INSERT_WEBHOOK,
    values: [
      checkedTenantId,
      eventKeyHash,
      event.eventType,
      bytes(event.resource.ciphertext),
      bytes(event.resource.nonce),
      bytes(event.resource.authTag),
      event.resource.keyId,
      receivedAt,
      payloadChecksum,
      event.source,
      event.requestBudgetStatus,
      event.qualityStatus,
    ],
  });
  return Object.freeze({ inserted: result.rowCount === 1 });
}

export async function listPendingWebhookEvents(
  tenantId: TenantId,
  tx: SqlExecutor,
  limit = 100,
): Promise<readonly PendingWebhookEvent[]> {
  const checkedTenantId = parseTenantId(tenantId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new PersistenceValidationError("Pending webhook limit must be an integer from 1 to 1000.");
  }

  const result = await tx.query<{
    event_key_hash: string;
    event_type: "voucher.created";
    resource_ciphertext: Uint8Array;
    resource_nonce: Uint8Array;
    resource_auth_tag: Uint8Array;
    key_id: string;
    received_at: string | Date;
    payload_checksum: string;
    source: "lexware_webhook";
    request_budget_status: RequestBudgetStatus;
    quality_status: QualityStatus;
  }>({ text: SQL_LIST_PENDING, values: [checkedTenantId, limit] });

  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        eventKeyHash: assertSha256Hex(row.event_key_hash, "event key hash"),
        eventType: row.event_type,
        resource: Object.freeze({
          ciphertext: bytes(row.resource_ciphertext),
          nonce: bytes(row.resource_nonce),
          authTag: bytes(row.resource_auth_tag),
          keyId: row.key_id,
        }),
        receivedAt:
          row.received_at instanceof Date ? row.received_at.toISOString() : assertIsoTimestamp(row.received_at, "receivedAt"),
        payloadChecksum: assertSha256Hex(row.payload_checksum, "payload checksum"),
        source: row.source,
        requestBudgetStatus: row.request_budget_status,
        qualityStatus: row.quality_status,
      }),
    ),
  );
}

export async function acknowledgeWebhookEvent(
  tenantId: TenantId,
  tx: SqlExecutor,
  eventKeyHash: string,
  acknowledgedAt: string,
): Promise<{ readonly acknowledged: boolean }> {
  const checkedTenantId = parseTenantId(tenantId);
  const checkedHash = assertSha256Hex(eventKeyHash, "event key hash");
  const checkedTime = assertIsoTimestamp(acknowledgedAt, "acknowledgedAt");
  const result = await tx.query({
    text: SQL_ACK_EVENT,
    values: [checkedTenantId, checkedHash, checkedTime],
  });
  return Object.freeze({ acknowledged: result.rowCount === 1 });
}
