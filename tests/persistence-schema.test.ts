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
    for (const table of ["tenants", "webhook_events", "audit_events"]) {
      expect(sql).toContain("ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY;");
      expect(sql).toContain("ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY;");
      expect(sql).toContain("tenant_isolation_" + table);
    }
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

  it("reserves audit mutation for the migration/maintenance role", () => {
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;");
    expect(sql).not.toContain("ON DELETE RESTRICT");
  });
});

describe("persistence structural policy", () => {
  it("keeps DB query calls inside the repository layer only", () => {
    const root = join(process.cwd(), "src/persistence");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(join(root, entry.name), "utf8");
      if (entry.name === "repository.ts") continue;
      expect({ file: entry.name, directQuery: /\.query\s*\(/.test(source) }).toEqual({
        file: entry.name,
        directQuery: false,
      });
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

  it("adds no dependency on Lexware write surfaces", () => {
    for (const file of ["types.ts", "crypto.ts", "repository.ts", "redaction.ts", "schema.ts"]) {
      const source = read("src/persistence/" + file);
      expect(source).not.toMatch(/\.\.\/lexware\/(?!errors)|\.\.\/tools\/|pending-voucher-events/);
    }
  });
});

describe("schema version fail-closed helpers", () => {
  it("accepts only the exact known schema version", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(assessSchemaVersion(1)).toBe("AVAILABLE");
    expect(assessSchemaVersion(null)).toBe("UNAVAILABLE");
    expect(assessSchemaVersion(0)).toBe("INTEGRITY_FAILED");
    expect(assessSchemaVersion(2)).toBe("VERSION_MISMATCH");
    expect(() => requireKnownSchemaVersion(2)).toThrow(/VERSION_MISMATCH/);
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
