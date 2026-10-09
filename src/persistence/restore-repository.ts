import type { SqlExecutor } from "./repository.js";
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
  } | null;
  readonly webhookRows: readonly {
    readonly eventKeyHash: string;
    readonly payloadChecksum: string;
    readonly receivedAt: string;
    readonly acknowledgedAt: string | null;
  }[];
  readonly auditRows: readonly {
    readonly auditId: string;
    readonly entryHash: string;
  }[];
  readonly auditAnchorHash: string | null;
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
  }>({
    text:
      "SELECT organization_id_hash, status FROM tenants " +
      "WHERE tenant_id = $1",
    values: [checkedTenantId],
  });
  if (tenant.rowCount > 1) {
    throw new PersistenceValidationError("Invalid restore tenant cardinality.");
  }
  const tenantRow = tenant.rows[0];
  const tenantStatus =
    tenantRow === undefined ? null : assertRestoreTenantStatus(tenantRow.status);

  const webhook = await tx.query<{
    event_key_hash: string;
    payload_checksum: string;
    received_at: string | Date;
    acknowledged_at: string | Date | null;
  }>({
    text:
      "SELECT event_key_hash, payload_checksum, received_at, acknowledged_at " +
      "FROM webhook_events WHERE tenant_id = $1 " +
      "ORDER BY event_key_hash ASC",
    values: [checkedTenantId],
  });

  const audit = await tx.query<{
    audit_id: string;
    entry_hash: string;
  }>({
    text:
      "SELECT audit_id::text AS audit_id, entry_hash FROM audit_events " +
      "WHERE tenant_id = $1 ORDER BY created_at ASC, audit_id ASC",
    values: [checkedTenantId],
  });

  const anchor = await tx.query<{ previous_hash: string }>({
    text:
      "SELECT previous_hash FROM audit_retention_anchors " +
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
        }),
      ),
    ),
    auditRows: Object.freeze(
      audit.rows.map((row) =>
        Object.freeze({
          auditId: row.audit_id,
          entryHash: assertSha256Hex(row.entry_hash, "restore audit entry hash"),
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
  });
}
