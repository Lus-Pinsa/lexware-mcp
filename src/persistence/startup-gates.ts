import { assertMigrationStateCurrent } from "./migration-runner.js";
import {
  inspectRuntimePrivileges,
  listAppliedSchemaMigrations,
  type PersistenceDatabase,
} from "./repository.js";
import { assertLeastPrivilegeRuntimeRole } from "./runtime-privileges.js";
import type { EnabledPersistenceRuntimeConfig } from "./runtime-config.js";
import { verifySchemaSafety, verifySessionSettings } from "./schema-safety-repository.js";
import type { EffectiveWriteCapabilities } from "./tenant-capabilities.js";
import { verifyConfiguredTenantBinding } from "./tenant-binding.js";

/**
 * Every persistence gate that must pass before the server accepts traffic, in order. Used by src/server.ts and by the
 * real-PostgreSQL start-up tests, so a gate removed here fails those tests (there is no separate test copy).
 * Persistence is fail-closed: any violation throws and the start is aborted; there is no RAM fallback.
 */
export async function runPersistenceStartupGates(
  db: PersistenceDatabase,
  config: EnabledPersistenceRuntimeConfig,
  capabilities: EffectiveWriteCapabilities,
): Promise<void> {
  assertMigrationStateCurrent(await db.transaction((tx) => listAppliedSchemaMigrations(tx)));

  // The ledger proves which scripts ran, not that their effects are intact: verify the pinned session settings,
  // row-level security, policies, the runtime binding objects, the append guard and the guard indexes.
  await db.transaction(async (tx) => {
    await verifySessionSettings(tx);
    await verifySchemaSafety(tx);
  });

  assertLeastPrivilegeRuntimeRole(
    await db.transaction((tx) => inspectRuntimePrivileges(tx)),
    config.expectedRuntimeRole,
  );

  await verifyConfiguredTenantBinding(config, db, capabilities);
}
