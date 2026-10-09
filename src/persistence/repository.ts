import { type AuditEntryInput, computeAuditEntryHash, validateAuditEntry } from "./audit.js";
import { validateEncryptedValue } from "./crypto.js";
import {
  type TenantStoragePolicy,
  type TenantStorageUsage,
  assertTenantStorageWithinPolicy,
} from "./capacity.js";
import { assertTenantCapabilityTier, type TenantCapabilityTier } from "./tenant-capabilities.js";
import {
  type EncryptedValue,
  type QualityStatus,
  type RequestBudgetStatus,
  type TenantId,
  PersistenceValidationError,
  assertQualityStatus,
  assertRequestBudgetStatus,
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
  readonly capabilityTier: TenantCapabilityTier;
}

export interface WebhookEventInsert {
  readonly eventKeyHash: string;
  readonly eventType: "voucher.created";
  readonly resource: EncryptedValue;
  readonly eventDate: string;
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
  readonly eventDate: string;
  readonly receivedAt: string;
  readonly payloadChecksum: string;
  readonly source: "lexware_webhook";
  readonly requestBudgetStatus: RequestBudgetStatus;
  readonly qualityStatus: QualityStatus;
}

const SQL_LIST_SCHEMA_MIGRATIONS =
  "SELECT version::int AS version, name, checksum FROM schema_migrations ORDER BY version ASC";
const SQL_RUNTIME_PRIVILEGES =
  "SELECT " +
  "current_user AS role_name, " +
  "r.rolsuper AS is_superuser, " +
  "r.rolbypassrls AS bypass_rls, " +
  "r.rolcreatedb AS can_create_database, " +
  "r.rolcreaterole AS can_create_role, " +
  "has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database, " +
  "has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public_schema, " +
  "has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS migrations_select, " +
  "has_table_privilege(current_user, 'public.schema_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE') AS migrations_mutate, " +
  "has_table_privilege(current_user, 'public.tenants', 'SELECT') AS tenants_select, " +
  "has_table_privilege(current_user, 'public.tenants', 'INSERT,UPDATE,DELETE,TRUNCATE') AS tenants_mutate, " +
  "has_table_privilege(current_user, 'public.webhook_events', 'SELECT,INSERT,UPDATE') AS webhook_dml, " +
  "has_table_privilege(current_user, 'public.webhook_events', 'DELETE,TRUNCATE') AS webhook_delete, " +
  "has_table_privilege(current_user, 'public.audit_events', 'SELECT,INSERT') AS audit_append, " +
  "has_table_privilege(current_user, 'public.audit_events', 'UPDATE,DELETE,TRUNCATE') AS audit_mutate, " +
  "has_table_privilege(current_user, 'public.audit_retention_anchors', 'SELECT') AS audit_anchor_select, " +
  "has_table_privilege(current_user, 'public.audit_retention_anchors', 'INSERT,UPDATE,DELETE,TRUNCATE') AS audit_anchor_mutate, " +
  "(SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = current_user) AS role_memberships " +
  "FROM pg_roles r WHERE r.rolname = current_user";
const SQL_SET_TENANT = "SELECT set_config('app.tenant_id', $1, true) AS tenant_id";
const SQL_GET_TENANT =
  "SELECT tenant_id, organization_id_hash, status, capability_tier FROM tenants WHERE tenant_id = $1";
const SQL_INSERT_WEBHOOK =
  "INSERT INTO webhook_events " +
  "(tenant_id, event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, event_date, received_at, payload_checksum, source, request_budget_status, quality_status) " +
  "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) " +
  "ON CONFLICT (tenant_id, event_key_hash) DO NOTHING";
const SQL_LIST_PENDING =
  "SELECT tenant_id, event_key_hash, event_type, resource_ciphertext, resource_nonce, resource_auth_tag, key_id, event_date, received_at, payload_checksum, source, request_budget_status, quality_status " +
  "FROM webhook_events WHERE tenant_id = $1 AND acknowledged_at IS NULL ORDER BY received_at ASC, event_key_hash ASC LIMIT $2";
const SQL_ACK_EVENT =
  "UPDATE webhook_events SET acknowledged_at = $3 " +
  "WHERE tenant_id = $1 AND event_key_hash = $2 AND acknowledged_at IS NULL";
const SQL_COUNT_PENDING =
  "SELECT count(*)::int AS count FROM webhook_events WHERE tenant_id = $1 AND acknowledged_at IS NULL";
const SQL_TENANT_STORAGE =
  "SELECT " +
  "t.max_webhook_events, t.max_audit_events, t.max_persistence_bytes, " +
  "(SELECT count(*)::int FROM webhook_events w WHERE w.tenant_id = $1) AS webhook_events, " +
  "(SELECT count(*)::int FROM audit_events a WHERE a.tenant_id = $1) AS audit_events, " +
  "(COALESCE((SELECT sum(pg_column_size(w))::bigint FROM webhook_events w WHERE w.tenant_id = $1),0) + " +
  " COALESCE((SELECT sum(pg_column_size(a))::bigint FROM audit_events a WHERE a.tenant_id = $1),0) + " +
  " COALESCE((SELECT sum(pg_column_size(h))::bigint FROM audit_retention_anchors h WHERE h.tenant_id = $1),0)) " +
  "AS persistence_bytes " +
  "FROM tenants t WHERE t.tenant_id = $1";
const SQL_LOCK_TENANT =
  "SELECT tenant_id FROM tenants WHERE tenant_id = $1 FOR UPDATE";
const SQL_GET_LATEST_AUDIT =
  "SELECT entry_hash FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC, audit_id DESC LIMIT 1";
const SQL_GET_AUDIT_ANCHOR =
  "SELECT previous_hash FROM audit_retention_anchors WHERE tenant_id = $1";
const SQL_INSERT_AUDIT =
  "INSERT INTO audit_events " +
  "(audit_id, tenant_id, actor_hash, action, result, item_count, created_at, previous_hash, entry_hash) " +
  "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)";

function assertIsoTimestamp(value: string, field: string): string {
  if (
    value.length < 20 ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return value;
}

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function assertTenantStatus(value: string): "active" | "disabled" {
  if (value !== "active" && value !== "disabled") {
    throw new PersistenceValidationError("Invalid tenant status.");
  }
  return value;
}

function assertWebhookType(value: string): "voucher.created" {
  if (value !== "voucher.created") {
    throw new PersistenceValidationError("Invalid webhook event type.");
  }
  return value;
}

function assertWebhookSource(value: string): "lexware_webhook" {
  if (value !== "lexware_webhook") {
    throw new PersistenceValidationError("Invalid webhook source.");
  }
  return value;
}

function validateWebhookEvent(event: WebhookEventInsert): void {
  assertWebhookType(event.eventType);
  assertWebhookSource(event.source);
  assertRequestBudgetStatus(event.requestBudgetStatus);
  assertQualityStatus(event.qualityStatus);
  validateEncryptedValue(event.resource);
}

export interface RuntimePrivilegeSnapshot {
  readonly roleName: string;
  readonly isSuperuser: boolean;
  readonly bypassRls: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canCreateInDatabase: boolean;
  readonly canCreateInPublicSchema: boolean;
  readonly migrationsSelect: boolean;
  readonly migrationsMutate: boolean;
  readonly tenantsSelect: boolean;
  readonly tenantsMutate: boolean;
  readonly webhookDml: boolean;
  readonly webhookDelete: boolean;
  readonly auditAppend: boolean;
  readonly auditMutate: boolean;
  readonly auditAnchorSelect: boolean;
  readonly auditAnchorMutate: boolean;
  readonly roleMemberships: number;
}

export async function inspectRuntimePrivileges(
  tx: SqlExecutor,
): Promise<RuntimePrivilegeSnapshot> {
  const result = await tx.query<{
    role_name: string;
    is_superuser: boolean;
    bypass_rls: boolean;
    can_create_database: boolean;
    can_create_role: boolean;
    can_create_in_database: boolean;
    can_create_in_public_schema: boolean;
    migrations_select: boolean;
    migrations_mutate: boolean;
    tenants_select: boolean;
    tenants_mutate: boolean;
    webhook_dml: boolean;
    webhook_delete: boolean;
    audit_append: boolean;
    audit_mutate: boolean;
    audit_anchor_select: boolean;
    audit_anchor_mutate: boolean;
    role_memberships: number;
  }>({ text: SQL_RUNTIME_PRIVILEGES, values: [] });

  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new PersistenceValidationError("Runtime database role could not be inspected.");
  }
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(row.role_name)) {
    throw new PersistenceValidationError("Runtime database role name is invalid.");
  }
  if (!Number.isSafeInteger(row.role_memberships) || row.role_memberships < 0) {
    throw new PersistenceValidationError("Runtime database role memberships are invalid.");
  }

  return Object.freeze({
    roleName: row.role_name,
    isSuperuser: row.is_superuser,
    bypassRls: row.bypass_rls,
    canCreateDatabase: row.can_create_database,
    canCreateRole: row.can_create_role,
    canCreateInDatabase: row.can_create_in_database,
    canCreateInPublicSchema: row.can_create_in_public_schema,
    migrationsSelect: row.migrations_select,
    migrationsMutate: row.migrations_mutate,
    tenantsSelect: row.tenants_select,
    tenantsMutate: row.tenants_mutate,
    webhookDml: row.webhook_dml,
    webhookDelete: row.webhook_delete,
    auditAppend: row.audit_append,
    auditMutate: row.audit_mutate,
    auditAnchorSelect: row.audit_anchor_select,
    auditAnchorMutate: row.audit_anchor_mutate,
    roleMemberships: row.role_memberships,
  });
}

export interface AppliedSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export async function listAppliedSchemaMigrations(
  tx: SqlExecutor,
): Promise<readonly AppliedSchemaMigration[]> {
  const result = await tx.query<{
    version: number;
    name: string;
    checksum: string;
  }>({ text: SQL_LIST_SCHEMA_MIGRATIONS, values: [] });

  return Object.freeze(
    result.rows.map((row) => {
      if (!Number.isSafeInteger(row.version) || row.version < 1) {
        throw new PersistenceValidationError("Invalid applied schema migration version.");
      }
      if (!/^[a-z0-9_]{1,64}$/.test(row.name)) {
        throw new PersistenceValidationError("Invalid applied schema migration name.");
      }
      return Object.freeze({
        version: row.version,
        name: row.name,
        checksum: assertSha256Hex(row.checksum, "applied schema migration checksum"),
      });
    }),
  );
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

export async function lockTenantForUpdate(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<void> {
  const checkedTenantId = parseTenantId(tenantId);
  const locked = await tx.query<{ tenant_id: string }>({
    text: SQL_LOCK_TENANT,
    values: [checkedTenantId],
  });
  const row = locked.rows[0];
  if (locked.rowCount !== 1 || row === undefined || parseTenantId(row.tenant_id) !== checkedTenantId) {
    throw new PersistenceValidationError("Tenant unavailable for locked persistence operation.");
  }
}

export async function getTenantBinding(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<TenantBinding | null> {
  const checkedTenantId = parseTenantId(tenantId);
  const result = await tx.query<{
    tenant_id: string;
    organization_id_hash: string;
    status: string;
    capability_tier: string;
  }>({ text: SQL_GET_TENANT, values: [checkedTenantId] });

  const row = result.rows[0];
  if (row === undefined) return null;
  const returnedTenantId = parseTenantId(row.tenant_id);
  if (returnedTenantId !== checkedTenantId) {
    throw new PersistenceValidationError("Tenant binding mismatch.");
  }
  return Object.freeze({
    tenantId: returnedTenantId,
    organizationIdHash: assertSha256Hex(row.organization_id_hash, "organization id hash"),
    status: assertTenantStatus(row.status),
    capabilityTier: assertTenantCapabilityTier(row.capability_tier),
  });
}

export async function insertWebhookEvent(
  tenantId: TenantId,
  tx: SqlExecutor,
  event: WebhookEventInsert,
): Promise<{ readonly inserted: boolean }> {
  const checkedTenantId = parseTenantId(tenantId);
  validateWebhookEvent(event);
  const eventKeyHash = assertSha256Hex(event.eventKeyHash, "event key hash");
  const payloadChecksum = assertSha256Hex(event.payloadChecksum, "payload checksum");
  const eventDate = assertIsoTimestamp(event.eventDate, "eventDate");
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
      eventDate,
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
    tenant_id: string;
    event_key_hash: string;
    event_type: string;
    resource_ciphertext: Uint8Array;
    resource_nonce: Uint8Array;
    resource_auth_tag: Uint8Array;
    key_id: string;
    event_date: string | Date;
    received_at: string | Date;
    payload_checksum: string;
    source: string;
    request_budget_status: string;
    quality_status: string;
  }>({ text: SQL_LIST_PENDING, values: [checkedTenantId, limit] });

  return Object.freeze(
    result.rows.map((row) => {
      const returnedTenantId = parseTenantId(row.tenant_id);
      if (returnedTenantId !== checkedTenantId) {
        throw new PersistenceValidationError("Cross-tenant persistence row rejected.");
      }
      const resource = Object.freeze({
        ciphertext: bytes(row.resource_ciphertext),
        nonce: bytes(row.resource_nonce),
        authTag: bytes(row.resource_auth_tag),
        keyId: row.key_id,
      });
      validateEncryptedValue(resource);
      return Object.freeze({
        eventKeyHash: assertSha256Hex(row.event_key_hash, "event key hash"),
        eventType: assertWebhookType(row.event_type),
        resource,
        eventDate:
          row.event_date instanceof Date ? row.event_date.toISOString() : assertIsoTimestamp(row.event_date, "eventDate"),
        receivedAt:
          row.received_at instanceof Date ? row.received_at.toISOString() : assertIsoTimestamp(row.received_at, "receivedAt"),
        payloadChecksum: assertSha256Hex(row.payload_checksum, "payload checksum"),
        source: assertWebhookSource(row.source),
        requestBudgetStatus: assertRequestBudgetStatus(row.request_budget_status),
        qualityStatus: assertQualityStatus(row.quality_status),
      });
    }),
  );
}

export async function countPendingWebhookEvents(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<number> {
  const checkedTenantId = parseTenantId(tenantId);
  const result = await tx.query<{ count: number }>({
    text: SQL_COUNT_PENDING,
    values: [checkedTenantId],
  });
  const count = result.rows[0]?.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new PersistenceValidationError("Invalid pending webhook count.");
  }
  return count as number;
}

export interface TenantStorageSnapshot {
  readonly policy: TenantStoragePolicy;
  readonly usage: TenantStorageUsage;
}

function safeDbInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PersistenceValidationError("Invalid " + label + ".");
  }
  return parsed;
}

export async function inspectTenantStorageCapacity(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<TenantStorageSnapshot> {
  const checkedTenantId = parseTenantId(tenantId);
  const result = await tx.query<{
    max_webhook_events: number;
    max_audit_events: number;
    max_persistence_bytes: number | string;
    webhook_events: number;
    audit_events: number;
    persistence_bytes: number | string;
  }>({ text: SQL_TENANT_STORAGE, values: [checkedTenantId] });

  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new PersistenceValidationError("Tenant storage policy unavailable.");
  }

  const snapshot = Object.freeze({
    policy: Object.freeze({
      maxWebhookEvents: safeDbInteger(row.max_webhook_events, "max webhook event limit"),
      maxAuditEvents: safeDbInteger(row.max_audit_events, "max audit event limit"),
      maxPersistenceBytes: safeDbInteger(row.max_persistence_bytes, "max persistence byte limit"),
    }),
    usage: Object.freeze({
      webhookEvents: safeDbInteger(row.webhook_events, "webhook event count"),
      auditEvents: safeDbInteger(row.audit_events, "audit event count"),
      persistenceBytes: safeDbInteger(row.persistence_bytes, "persistence byte count"),
    }),
  });
  assertTenantStorageWithinPolicy(snapshot.policy, snapshot.usage);
  return snapshot;
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


export async function appendAuditEvent(
  tenantId: TenantId,
  tx: SqlExecutor,
  input: Omit<AuditEntryInput, "tenantId" | "previousHash">,
): Promise<{ readonly entryHash: string; readonly previousHash: string | null }> {
  const checkedTenantId = parseTenantId(tenantId);
  await lockTenantForUpdate(checkedTenantId, tx);

  const latest = await tx.query<{ entry_hash: string }>({
    text: SQL_GET_LATEST_AUDIT,
    values: [checkedTenantId],
  });
  let previousHash: string | null;
  if (latest.rows[0] !== undefined) {
    previousHash = assertSha256Hex(latest.rows[0].entry_hash, "previous audit hash");
  } else {
    const anchor = await tx.query<{ previous_hash: string }>({
      text: SQL_GET_AUDIT_ANCHOR,
      values: [checkedTenantId],
    });
    previousHash =
      anchor.rows[0] === undefined
        ? null
        : assertSha256Hex(anchor.rows[0].previous_hash, "audit retention anchor");
  }

  const entry = validateAuditEntry({
    ...input,
    tenantId: checkedTenantId,
    previousHash,
  });
  const entryHash = computeAuditEntryHash(entry);

  const inserted = await tx.query({
    text: SQL_INSERT_AUDIT,
    values: [
      entry.auditId,
      checkedTenantId,
      entry.actorHash,
      entry.action,
      entry.result,
      entry.itemCount,
      entry.createdAt,
      entry.previousHash,
      entryHash,
    ],
  });
  if (inserted.rowCount !== 1) {
    throw new PersistenceValidationError("Audit append failed.");
  }

  // Capacity is checked after the append while the tenant row remains locked.
  // Any excess throws inside the surrounding transaction and rolls the append back.
  await inspectTenantStorageCapacity(checkedTenantId, tx);

  return Object.freeze({ entryHash, previousHash });
}
