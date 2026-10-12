import { createPostgresDatabase } from "../src/persistence/postgres-driver.js";
import { verifyRestoredDatabaseComplete } from "../src/persistence/restore-verification.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("MISSING_CONFIGURATION");
  return value;
}

function tlsMode(): "verify-full" | "require" {
  const value = process.env.PERSISTENCE_TLS_MODE?.trim() || "verify-full";
  if (value !== "verify-full" && value !== "require") {
    throw new Error("INVALID_TLS_MODE");
  }
  return value;
}

async function main(): Promise<void> {
  const sourceUrl = required("PERSISTENCE_SOURCE_DATABASE_URL");
  const restoreUrl = required("PERSISTENCE_RESTORE_DATABASE_URL");
  if (sourceUrl === restoreUrl) throw new Error("SOURCE_EQUALS_RESTORE");

  // Database-wide verification (every tenant, runtime bindings, total row counts). Both URLs must use a dedicated
  // read-only verifier role that bypasses row-level security; any other role fails closed (C-03).
  const tls = tlsMode();

  const source = createPostgresDatabase({
    connectionString: sourceUrl,
    tlsMode: tls,
    applicationName: "lus-restore-source-verifier",
    maxConnections: 1,
  });
  const restored = createPostgresDatabase({
    connectionString: restoreUrl,
    tlsMode: tls,
    applicationName: "lus-restore-target-verifier",
    maxConnections: 1,
  });

  try {
    const manifest = await verifyRestoredDatabaseComplete(source, restored);
    const sum = (field: "webhookCount" | "auditCount") => manifest.tenants.reduce((n, t) => n + t[field], 0);
    console.error(
      "[restore-verifier] PASS " +
        "schemaMigrations=" +
        (manifest.tenants[0]?.schemaMigrationCount ?? 0) +
        " tenants=" +
        manifest.tenantCount +
        " webhookRows=" +
        sum("webhookCount") +
        " auditRows=" +
        sum("auditCount"),
    );
  } finally {
    await Promise.allSettled([source.close(), restored.close()]);
  }
}

main().catch((error: unknown) => {
  const errorClass =
    error instanceof Error && /^[A-Za-z0-9_-]{1,64}$/.test(error.name)
      ? error.name
      : "UNKNOWN";
  console.error("[restore-verifier] FAIL errorClass=" + errorClass);
  process.exitCode = 1;
});
