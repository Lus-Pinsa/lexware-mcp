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

const RUNTIME_ROLE_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;
const SQL_BIND_RUNTIME_ROLE =
  "INSERT INTO tenant_runtime_bindings (role_name, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING";

export interface RuntimeRoleBindingInput {
  readonly tenantId: TenantId;
  readonly roleName: string;
  readonly auditId: string;
  readonly actorHash: string;
  readonly createdAt: string;
}

/**
 * Operator path (table owner): allow a database role to act on one tenant (migration 010). Without a binding the
 * runtime role sees and writes no tenant rows; start-up requires exactly one binding, to the configured tenant.
 * Idempotent; a new binding is recorded in the tenant's audit chain.
 */
export async function bindRuntimeRoleToTenant(
  db: MigrationDatabase,
  input: RuntimeRoleBindingInput,
): Promise<{ readonly created: boolean }> {
  const tenantId = parseTenantId(input.tenantId);
  if (!RUNTIME_ROLE_PATTERN.test(input.roleName)) {
    throw new PersistenceValidationError("Runtime database role name is invalid.");
  }

  return db.transaction(async (tx) => {
    await tx.query({ text: SQL_SET_TENANT, values: [tenantId] });

    const tenant = await tx.query<{ tenant_id: string; status: string }>({ text: SQL_GET_TENANT, values: [tenantId] });
    if (tenant.rowCount !== 1 || tenant.rows[0] === undefined || parseTenantId(tenant.rows[0].tenant_id) !== tenantId) {
      throw new PersistenceValidationError("Tenant for runtime binding is unavailable.");
    }

    const inserted = await tx.query({ text: SQL_BIND_RUNTIME_ROLE, values: [input.roleName, tenantId] });
    if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
      throw new PersistenceValidationError("Unexpected runtime binding result.");
    }

    if (inserted.rowCount === 1) {
      await appendAuditEvent(tenantId, tx, {
        auditId: input.auditId,
        actorHash: input.actorHash,
        action: "tenant.runtime_role_bind",
        result: "SUCCESS",
        itemCount: 1,
        createdAt: input.createdAt,
      });
    }

    return Object.freeze({ created: inserted.rowCount === 1 });
  });
}
