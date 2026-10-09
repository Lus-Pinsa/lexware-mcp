import type { PersistenceConfig } from "./config.js";
import { assertSupportedSchemaVersion } from "./migrations.js";
import type { TenantDirectory } from "./repository.js";
import type { PersistenceState } from "./state.js";

export interface PersistenceHealthProbe {
  schemaVersion(): Promise<number>;
  integrityOk(): Promise<boolean>;
}

function unavailable(
  reason: Extract<PersistenceState, { status: "UNAVAILABLE" }>["reason"],
  checkedAt: string,
): PersistenceState {
  return { status: "UNAVAILABLE", checkedAt, reason };
}

function validHash64(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * Fail-closed startup gate for persistence.
 *
 * It deliberately returns explicit UNAVAILABLE state rather than pretending
 * storage is empty. No migration or repair is performed here.
 */
export async function checkPersistenceReadiness(
  config: PersistenceConfig,
  organizationHash: string,
  directory: TenantDirectory,
  health: PersistenceHealthProbe,
  now: () => Date = () => new Date(),
): Promise<PersistenceState> {
  const checkedAt = now().toISOString();

  if (!config.enabled) return unavailable("DISABLED", checkedAt);
  if (!validHash64(organizationHash)) return unavailable("CONFIG_INVALID", checkedAt);

  let schemaVersion: number;
  try {
    schemaVersion = await health.schemaVersion();
  } catch {
    return unavailable("DATABASE_UNREACHABLE", checkedAt);
  }

  try {
    assertSupportedSchemaVersion(schemaVersion);
  } catch {
    return unavailable("SCHEMA_UNSUPPORTED", checkedAt);
  }

  let resolved: Awaited<ReturnType<TenantDirectory["resolveOrganizationHash"]>>;
  try {
    resolved = await directory.resolveOrganizationHash(organizationHash);
  } catch {
    return unavailable("DATABASE_UNREACHABLE", checkedAt);
  }
  if (resolved === null || resolved.tenantId !== config.tenantId) {
    return unavailable("TENANT_BINDING_MISMATCH", checkedAt);
  }

  let integrityOk: boolean;
  try {
    integrityOk = await health.integrityOk();
  } catch {
    return unavailable("DATABASE_UNREACHABLE", checkedAt);
  }
  if (!integrityOk) return unavailable("INTEGRITY_FAILURE", checkedAt);

  return { status: "AVAILABLE", checkedAt };
}
