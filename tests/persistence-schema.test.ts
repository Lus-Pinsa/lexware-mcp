import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  assessSchemaVersion,
  requireKnownSchemaVersion,
} from "../src/persistence/schema.js";
import { buildSafePersistenceLogEvent, redactPersistenceError } from "../src/persistence/redaction.js";
import { PersistenceValidationError, parseTenantId } from "../src/persistence/types.js";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const TENANT = parseTenantId("00000000-0000-4000-8000-0000000000aa");

describe("persistence foundation schema", () => {
  const sql = read("src/persistence/migrations/001_foundation.sql");

  it("is tenant-first and enables FORCE RLS on every tenant-owned table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tenants[\s\S]*tenant_id uuid PRIMARY KEY/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS webhook_events[\s\S]*tenant_id uuid NOT NULL/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_events[\s\S]*tenant_id uuid NOT NULL/);
    const retentionSql = read("src/persistence/migrations/003_audit_retention_anchor.sql");
    expect(retentionSql).toMatch(/CREATE TABLE IF NOT EXISTS audit_retention_anchors[\s\S]*tenant_id uuid PRIMARY KEY/);
    for (const table of ["tenants", "webhook_events", "audit_events"]) {
      expect(sql).toContain("ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY;");
      expect(sql).toContain("ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY;");
      expect(sql).toContain("tenant_isolation_" + table);
    }
    expect(retentionSql).toContain("ALTER TABLE audit_retention_anchors ENABLE ROW LEVEL SECURITY;");
    expect(retentionSql).toContain("ALTER TABLE audit_retention_anchors FORCE ROW LEVEL SECURITY;");
    expect(retentionSql).toContain("tenant_isolation_audit_retention_anchors");
    expect((sql.match(/current_setting\('app\.tenant_id', true\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("stores encrypted webhook identifiers, not plaintext resource ids or document contents", () => {
    expect(sql).toContain("resource_ciphertext bytea NOT NULL");
    expect(sql).toContain("resource_nonce bytea NOT NULL");
    expect(sql).toContain("resource_auth_tag bytea NOT NULL");
    expect(sql).toContain("key_id text NOT NULL");
    expect(sql).not.toMatch(/\b(resource_id|email|iban|pdf_text|document_text|api_key|access_token|refresh_token)\b/i);
  });

  it("pins quality/provenance and unique tenant-scoped event identity in DB constraints", () => {
    expect(sql).toContain("PRIMARY KEY (tenant_id, event_key_hash)");
    expect(sql).toContain("source = 'lexware_webhook'");
    expect(sql).toContain("'NOT_APPLICABLE'");
    for (const quality of ["STRUCTURED", "DERIVED", "UNVERIFIED", "PLACEHOLDER", "CONFLICT", "MISSING"]) {
      expect(sql).toContain("'" + quality + "'");
    }
  });

  it("persists a fail-closed per-tenant capability ceiling", () => {
    const capabilitySql = read("src/persistence/migrations/004_tenant_capability_tier.sql");
    expect(capabilitySql).toContain("ADD COLUMN capability_tier");
    expect(capabilitySql).toContain("DEFAULT 'read_only'");
    expect(capabilitySql).toContain("'read_only', 'drafts', 'finalize'");
  });

  it("pins explicit per-tenant storage ceilings in schema", () => {
    const limitSql = read("src/persistence/migrations/005_tenant_storage_limits.sql");
    expect(limitSql).toContain("DEFAULT 10000");
    expect(limitSql).toContain("DEFAULT 100000");
    expect(limitSql).toContain("DEFAULT 67108864");
    expect(limitSql).toContain("octet_length(resource_ciphertext) BETWEEN 1 AND 512");
  });

  it("reserves audit mutation for the migration/maintenance role", () => {
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;");
    expect(sql).not.toContain("ON DELETE RESTRICT");
  });
});

describe("persistence structural policy", () => {
  it("allows direct DB query calls only in repositories and the privileged migration runner", () => {
    const root = join(process.cwd(), "src/persistence");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, entry.name), "utf8");
      const directQuery = /\.query(?:<[\s\S]*?>)?\s*\(/.test(source);
      const allowed = [
        "repository.ts",
        "operator-repository.ts",
        "maintenance-repository.ts",
        "integrity-repository.ts",
        "restore-repository.ts",
        "migration-runner.ts",
      ].includes(entry.name);
      if (directQuery) expect(allowed, entry.name).toBe(true);
    }
  });

  it("repository SQL is static/parameterized and cannot interpolate external values", () => {
    const source = read("src/persistence/repository.ts");
    const sqlBodies = [...source.matchAll(/const SQL_[A-Z_]+\s*=\s*([\s\S]*?);\n/g)].map((match) => match[1]);
    expect(sqlBodies.length).toBeGreaterThan(0);
    for (const body of sqlBodies) expect(body).not.toContain("$" + "{");
    expect(source).not.toMatch(/\bprocess\.env\b|\bfetch\s*\(|LexwareClient|\.post\s*\(|postMultipart/);
    expect(source).toContain("$1");
  });

  it("keeps the PostgreSQL client dependency inside the driver adapter", () => {
    const root = join(process.cwd(), "src/persistence");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, entry.name), "utf8");
      const importsPostgres = /from ["']postgres["']/.test(source);
      expect({ file: entry.name, importsPostgres }).toEqual({
        file: entry.name,
        importsPostgres: entry.name === "postgres-driver.ts",
      });
    }
  });

  it("restricts unparameterized static SQL execution to migration infrastructure", () => {
    const root = join(process.cwd(), "src/persistence");
    const allowed = new Set(["migration-types.ts", "migration-runner.ts", "postgres-driver.ts"]);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, entry.name), "utf8");
      if (source.includes("executeStatic")) expect(allowed.has(entry.name), entry.name).toBe(true);
    }
  });

  it("packages SQL migrations into dist as part of the normal build", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: { build: string } };
    expect(packageJson.scripts.build).toContain("scripts/copy-persistence-migrations.mjs");
    const copyScript = read("scripts/copy-persistence-migrations.mjs");
    expect(copyScript).toContain('"src", "persistence", "migrations"');
    expect(copyScript).toContain('"dist", "persistence", "migrations"');
    expect(copyScript).toContain("/^\\d{3}_[a-z0-9_-]+\\.sql$/");
  });

  it("adds no dependency on Lexware write surfaces", () => {
    const root = join(process.cwd(), "src/persistence");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, entry.name), "utf8");
      expect(source, entry.name).not.toMatch(/\.\.\/lexware\/(?!errors)|\.\.\/tools\/|pending-voucher-events/);
    }
  });
});

describe("schema version fail-closed helpers", () => {
  it("accepts only the exact known schema version", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(5);
    expect(assessSchemaVersion(5)).toBe("AVAILABLE");
    expect(assessSchemaVersion(null)).toBe("UNAVAILABLE");
    expect(assessSchemaVersion(0)).toBe("INTEGRITY_FAILED");
    expect(assessSchemaVersion(1)).toBe("VERSION_MISMATCH");
    expect(assessSchemaVersion(6)).toBe("VERSION_MISMATCH");
    expect(() => requireKnownSchemaVersion(1)).toThrow(/VERSION_MISMATCH/);
  });
});

describe("persistence safe logging", () => {
  it("reduces arbitrary errors to a fixed class and never copies the error message", () => {
    const secret = "DO-NOT-LOG-THIS";
    const out = buildSafePersistenceLogEvent(TENANT, "persistence.query_failed", 1, new Error(secret));
    expect(out).toEqual({ event: "persistence.query_failed", tenantId: TENANT, count: 1, errorClass: "UNKNOWN" });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(redactPersistenceError(new PersistenceValidationError(secret))).toBe("CONFIG_INVALID");
  });

  it("rejects arbitrary log event strings instead of echoing them", () => {
    expect(() => buildSafePersistenceLogEvent(TENANT, "x\nforged", 1)).toThrow(/Invalid persistence log event/);
  });
});
