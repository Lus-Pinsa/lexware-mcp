import { parseChainSeq, type SqlExecutor } from "./repository.js";
import { assertTenantCapabilityTier } from "./tenant-capabilities.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

export interface RestoreEvidenceRows {
  readonly tenantBinding: {
    readonly organizationIdHash: string;
    readonly status: "active" | "disabled";
    readonly capabilityTier: "read_only" | "drafts" | "finalize";
    /** Storage limits and creation time, rendered in SQL (epoch, integers) so the text is session-independent. */
    readonly policyFingerprint: string;
  } | null;
  readonly webhookRows: readonly {
    readonly eventKeyHash: string;
    readonly payloadChecksum: string;
    readonly receivedAt: string;
    readonly acknowledgedAt: string | null;
    /** SHA-256 over every other stored column, including the encrypted resource (computed in SQL). */
    readonly rowFingerprint: string;
  }[];
  readonly auditRows: readonly {
    readonly auditId: string;
    readonly entryHash: string;
    readonly createdEpoch: string;
  }[];
  readonly auditAnchorHash: string | null;
  readonly auditAnchorSeq: number | null;
}

function assertEpochText(value: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,12}(\.[0-9]{1,6})?$/.test(value)) {
    throw new PersistenceValidationError("Invalid restore audit timestamp.");
  }
  return value;
}

function assertFingerprintText(value: string): string {
  if (typeof value !== "string" || !/^[0-9.|]{1,200}$/.test(value)) {
    throw new PersistenceValidationError("Invalid restore tenant policy.");
  }
  return value;
}

function assertRestoreTenantStatus(value: string): "active" | "disabled" {
  if (value !== "active" && value !== "disabled") {
    throw new PersistenceValidationError("Invalid restore tenant status.");
  }
  return value;
}

function assertTimestamp(value: string | Date, field: string): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (
    text.length < 20 ||
    text.length > 40 ||
    Number.isNaN(Date.parse(text))
  ) {
    throw new PersistenceValidationError("Invalid restore evidence " + field + ".");
  }
  return text;
}

export async function readRestoreEvidenceRows(
  tenantId: TenantId,
  tx: SqlExecutor,
): Promise<RestoreEvidenceRows> {
  const checkedTenantId = parseTenantId(tenantId);

  const tenant = await tx.query<{
    organization_id_hash: string;
    status: string;
    capability_tier: string;
    policy_fingerprint: string;
  }>({
    text:
      "SELECT organization_id_hash, status, capability_tier, " +
      "concat_ws('|', max_webhook_events, max_audit_events, max_persistence_bytes, extract(epoch FROM created_at)) AS policy_fingerprint " +
      "FROM tenants " +
      "WHERE tenant_id = $1",
    values: [checkedTenantId],
  });
  if (tenant.rowCount > 1) {
    throw new PersistenceValidationError("Invalid restore tenant cardinality.");
  }
  const tenantRow = tenant.rows[0];
  const tenantStatus =
    tenantRow === undefined ? null : assertRestoreTenantStatus(tenantRow.status);
  const tenantCapability =
    tenantRow === undefined ? null : assertTenantCapabilityTier(tenantRow.capability_tier);

  const webhook = await tx.query<{
    event_key_hash: string;
    payload_checksum: string;
    received_at: string | Date;
    acknowledged_at: string | Date | null;
    row_fingerprint: string;
  }>({
    text:
      "SELECT event_key_hash, payload_checksum, received_at, acknowledged_at, " +
      // Text columns have restricted character sets without '|'; nonce (12) and tag (16) have fixed sizes, so the
      // concatenation is unambiguous. Timestamps as epoch text: independent of DateStyle and TimeZone.
      "encode(sha256(convert_to(concat_ws('|', event_type, key_id, extract(epoch FROM event_date), " +
      "extract(epoch FROM received_at), coalesce(extract(epoch FROM acknowledged_at)::text, '-'), source, " +
      "request_budget_status, quality_status), 'UTF8') || '\\x7c'::bytea || resource_ciphertext || resource_nonce || resource_auth_tag), 'hex') " +
      "AS row_fingerprint " +
      "FROM webhook_events WHERE tenant_id = $1 " +
      "ORDER BY event_key_hash ASC",
    values: [checkedTenantId],
  });

  const audit = await tx.query<{
    audit_id: string;
    entry_hash: string;
    created_epoch: string;
  }>({
    text:
      // created_at as epoch text: the entry hash covers it only at millisecond precision.
      "SELECT audit_id::text AS audit_id, entry_hash, extract(epoch FROM created_at)::text AS created_epoch FROM audit_events " +
      "WHERE tenant_id = $1 ORDER BY chain_seq ASC",
    values: [checkedTenantId],
  });

  const anchor = await tx.query<{ previous_hash: string; last_pruned_seq: number | string }>({
    text:
      "SELECT previous_hash, last_pruned_seq FROM audit_retention_anchors " +
      "WHERE tenant_id = $1",
    values: [checkedTenantId],
  });
  if (anchor.rowCount > 1) {
    throw new PersistenceValidationError("Invalid restore audit anchor cardinality.");
  }

  return Object.freeze({
    tenantBinding:
      tenantRow === undefined
        ? null
        : Object.freeze({
            organizationIdHash: assertSha256Hex(
              tenantRow.organization_id_hash,
              "restore organization hash",
            ),
            status: tenantStatus!,
            capabilityTier: tenantCapability!,
            policyFingerprint: assertFingerprintText(tenantRow.policy_fingerprint),
          }),
    webhookRows: Object.freeze(
      webhook.rows.map((row) =>
        Object.freeze({
          eventKeyHash: assertSha256Hex(row.event_key_hash, "restore event key hash"),
          payloadChecksum: assertSha256Hex(
            row.payload_checksum,
            "restore payload checksum",
          ),
          receivedAt: assertTimestamp(row.received_at, "receivedAt"),
          acknowledgedAt:
            row.acknowledged_at === null
              ? null
              : assertTimestamp(row.acknowledged_at, "acknowledgedAt"),
          rowFingerprint: assertSha256Hex(row.row_fingerprint, "restore webhook row fingerprint"),
        }),
      ),
    ),
    auditRows: Object.freeze(
      audit.rows.map((row) =>
        Object.freeze({
          auditId: row.audit_id,
          entryHash: assertSha256Hex(row.entry_hash, "restore audit entry hash"),
          createdEpoch: assertEpochText(row.created_epoch),
        }),
      ),
    ),
    auditAnchorHash:
      anchor.rows[0] === undefined
        ? null
        : assertSha256Hex(
            anchor.rows[0].previous_hash,
            "restore audit retention anchor",
          ),
    auditAnchorSeq:
      anchor.rows[0] === undefined
        ? null
        : parseChainSeq(anchor.rows[0].last_pruned_seq, "restore audit retention anchor position"),
  });
}

export interface RestoreCompletenessScope {
  readonly tenantIds: readonly TenantId[];
  readonly bindings: readonly (readonly [roleName: string, tenantId: TenantId])[];
  /** Total rows of tenants, webhook_events, audit_events, audit_retention_anchors, tenant_runtime_bindings. */
  readonly counts: readonly string[];
  /** Persisted metadata outside the per-tenant evidence: ledger applied_at and anchor updated_at (epoch text). */
  readonly metadata: readonly (readonly string[])[];
}

const SQL_VERIFIER_ROLE =
  "SELECT r.rolbypassrls AS sees_all, (" +
  // Read-only verifier profile (BYPASSRLS is the one intended exception): no superuser or role-administration
  // attributes, no role memberships (SET ROLE), no CREATE anywhere, no owned objects, no default privileges, no
  // parameter privileges, no write right on any user relation (tables and views), and no executable SECURITY DEFINER
  // function outside the system schemas (an owner-defined function could write on its behalf).
  "NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication " +
  "AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) " +
  "AND NOT has_database_privilege(r.oid, current_database(), 'CREATE') " +
  "AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(r.oid, n.oid, 'CREATE') " +
  " AND n.oid <> pg_my_temp_schema() AND NOT pg_is_other_temp_schema(n.oid) AND n.nspname !~ '^pg_toast_temp_') " +
  "AND NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid " +
  " AND d.deptype = 'o' AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))) " +
  "AND NOT EXISTS (SELECT 1 FROM pg_default_acl a CROSS JOIN LATERAL aclexplode(a.defaclacl) x WHERE x.grantee = r.oid) " +
  "AND NOT EXISTS (SELECT 1 FROM pg_parameter_acl a WHERE has_parameter_privilege(r.oid, a.parname, 'SET') " +
  " OR has_parameter_privilege(r.oid, a.parname, 'ALTER SYSTEM')) " +
  "AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  " WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') " +
  " AND n.nspname !~ '^pg_(toast|temp)' AND (c.relowner = r.oid " +
  " OR has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') " +
  " OR has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES'))) " +
  "AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE p.prosecdef " +
  " AND pn.nspname NOT IN ('pg_catalog', 'information_schema') AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))" +
  ") AS read_only FROM pg_roles r WHERE r.rolname = current_user";

/**
 * Database-wide restore scope (C-03): every tenant, every runtime binding and the total row count of every tenant
 * table. Only meaningful for a role that bypasses row-level security; any other role sees a partial view, so the
 * read fails closed instead.
 */
export async function readRestoreCompletenessScope(tx: SqlExecutor): Promise<RestoreCompletenessScope> {
  const role = await tx.query<{ sees_all: boolean; read_only: boolean }>({ text: SQL_VERIFIER_ROLE, values: [] });
  if (role.rowCount !== 1 || role.rows[0]?.sees_all !== true) {
    throw new PersistenceValidationError(
      "Restore completeness verification requires a read-only verifier role that bypasses row-level security.",
    );
  }
  if (role.rows[0].read_only !== true) {
    throw new PersistenceValidationError(
      "Restore completeness verification requires a read-only verifier role (no superuser, ownership, membership or write path).",
    );
  }
  const tenants = await tx.query<{ tenant_id: string }>({
    text: "SELECT tenant_id::text AS tenant_id FROM tenants ORDER BY tenant_id ASC",
    values: [],
  });
  const bindings = await tx.query<{ role_name: string; tenant_id: string }>({
    text: "SELECT role_name::text AS role_name, tenant_id::text AS tenant_id FROM tenant_runtime_bindings ORDER BY role_name ASC, tenant_id ASC",
    values: [],
  });
  const counts = await tx.query<{ t: number; w: number; a: number; h: number; b: number }>({
    text:
      "SELECT (SELECT count(*)::int FROM tenants) AS t, (SELECT count(*)::int FROM webhook_events) AS w, " +
      "(SELECT count(*)::int FROM audit_events) AS a, (SELECT count(*)::int FROM audit_retention_anchors) AS h, " +
      "(SELECT count(*)::int FROM tenant_runtime_bindings) AS b",
    values: [],
  });
  const c = counts.rows[0];
  if (counts.rowCount !== 1 || c === undefined) {
    throw new PersistenceValidationError("Restore completeness counts unavailable.");
  }
  const metadata = await tx.query<{ k: string; id: string; epoch: string }>({
    text:
      "SELECT 'ledger' AS k, version::text AS id, extract(epoch FROM applied_at)::text AS epoch FROM schema_migrations " +
      "UNION ALL SELECT 'anchor', tenant_id::text, extract(epoch FROM updated_at)::text FROM audit_retention_anchors " +
      "ORDER BY 1, 2",
    values: [],
  });
  return Object.freeze({
    tenantIds: Object.freeze(tenants.rows.map((row) => parseTenantId(row.tenant_id))),
    bindings: Object.freeze(
      bindings.rows.map((row) => {
        if (!/^[A-Za-z0-9_-]{1,63}$/.test(row.role_name)) {
          throw new PersistenceValidationError("Invalid restore runtime binding role.");
        }
        return Object.freeze([row.role_name, parseTenantId(row.tenant_id)] as const);
      }),
    ),
    counts: Object.freeze([c.t, c.w, c.a, c.h, c.b].map(String)),
    metadata: Object.freeze(metadata.rows.map((row) => Object.freeze([row.k, row.id, row.epoch]))),
  });
}
