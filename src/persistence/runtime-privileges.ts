import type { RuntimePrivilegeSnapshot } from "./repository.js";
import { PersistenceValidationError } from "./types.js";

const ROLE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;

export function assertLeastPrivilegeRuntimeRole(
  snapshot: RuntimePrivilegeSnapshot,
  expectedRoleName: string,
): void {
  if (!ROLE_NAME_PATTERN.test(expectedRoleName)) {
    throw new PersistenceValidationError("Expected runtime database role name is invalid.");
  }

  const violations: string[] = [];
  if (snapshot.roleName !== expectedRoleName) violations.push("ROLE_MISMATCH");
  if (snapshot.isSuperuser) violations.push("SUPERUSER");
  if (snapshot.bypassRls) violations.push("BYPASS_RLS");
  if (snapshot.canCreateDatabase) violations.push("CREATEDB");
  if (snapshot.canCreateRole) violations.push("CREATEROLE");
  if (snapshot.canCreateInDatabase) violations.push("DATABASE_CREATE");
  if (snapshot.canCreateInPublicSchema) violations.push("SCHEMA_CREATE");
  if (!snapshot.migrationsSelect) violations.push("MIGRATION_READ_MISSING");
  if (snapshot.migrationsMutate) violations.push("MIGRATION_MUTATION");
  if (!snapshot.tenantsSelect) violations.push("TENANT_READ_MISSING");
  if (snapshot.tenantsMutate) violations.push("TENANT_MUTATION");
  if (!snapshot.webhookDml) violations.push("WEBHOOK_DML_MISSING");
  if (snapshot.webhookDelete) violations.push("WEBHOOK_DELETE");
  if (!snapshot.auditAppend) violations.push("AUDIT_APPEND_MISSING");
  if (snapshot.auditMutate) violations.push("AUDIT_MUTATION");
  if (!snapshot.auditAnchorSelect) violations.push("AUDIT_ANCHOR_READ_MISSING");
  if (snapshot.auditAnchorMutate) violations.push("AUDIT_ANCHOR_MUTATION");
  if (snapshot.roleMemberships !== 0) violations.push("ROLE_MEMBERSHIP");

  if (violations.length > 0) {
    // Fixed codes only: no role names, identifiers, SQL, credentials, or DB error text.
    throw new PersistenceValidationError(
      "Runtime database privilege verification failed: " + violations.join(",") + ".",
    );
  }
}
