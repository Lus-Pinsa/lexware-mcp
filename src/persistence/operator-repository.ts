import type { MigrationDatabase } from "./migration-types.js";
import { appendAuditEvent } from "./repository.js";
import {
  type TenantId,
  PersistenceValidationError,
  assertSha256Hex,
  parseTenantId,
} from "./types.js";

const SQL_SET_TENANT = "SELECT set_config('app.tenant_id', $1, true) AS tenant_id";
const SQL_INSERT_TENANT =
  "INSERT INTO tenants (tenant_id, organization_id_hash, status, capability_tier) " +
  "VALUES ($1,$2,'active','read_only') " +
  "ON CONFLICT (tenant_id) DO NOTHING";
const SQL_GET_TENANT =
  "SELECT tenant_id, organization_id_hash, status, capability_tier FROM tenants WHERE tenant_id = $1";

export interface TenantBootstrapInput {
  readonly tenantId: TenantId;
  readonly organizationIdHash: string;
  readonly auditId: string;
  readonly actorHash: string;
  readonly createdAt: string;
}

export async function bootstrapTenant(
  db: MigrationDatabase,
  input: TenantBootstrapInput,
): Promise<{ readonly created: boolean }> {
  const tenantId = parseTenantId(input.tenantId);
  const organizationIdHash = assertSha256Hex(input.organizationIdHash, "organization id hash");

  return db.transaction(async (tx) => {
    // Tenant RLS is FORCE-enabled from migration 001. Set the exact proposed
    // tenant before any tenant-table write; there is no bootstrap bypass tenant.
    await tx.query({ text: SQL_SET_TENANT, values: [tenantId] });

    const inserted = await tx.query({
      text: SQL_INSERT_TENANT,
      values: [tenantId, organizationIdHash],
    });
    if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
      throw new PersistenceValidationError("Unexpected tenant bootstrap result.");
    }

    const verified = await tx.query<{
      tenant_id: string;
      organization_id_hash: string;
      status: string;
      capability_tier: string;
    }>({ text: SQL_GET_TENANT, values: [tenantId] });

    const row = verified.rows[0];
    if (
      verified.rowCount !== 1 ||
      row === undefined ||
      parseTenantId(row.tenant_id) !== tenantId
    ) {
      throw new PersistenceValidationError("Bootstrapped tenant is unavailable.");
    }
    if (
      assertSha256Hex(row.organization_id_hash, "organization id hash") !== organizationIdHash ||
      row.status !== "active"
    ) {
      throw new PersistenceValidationError("Existing tenant binding does not match bootstrap input.");
    }

    if (inserted.rowCount === 1) {
      await appendAuditEvent(tenantId, tx, {
        auditId: input.auditId,
        actorHash: input.actorHash,
        action: "tenant.create",
        result: "SUCCESS",
        itemCount: 1,
        createdAt: input.createdAt,
      });
    }

    return Object.freeze({ created: inserted.rowCount === 1 });
  });
}
