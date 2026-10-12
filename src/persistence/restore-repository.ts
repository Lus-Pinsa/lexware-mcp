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
