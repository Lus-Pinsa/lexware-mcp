import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asTenantId } from "../src/persistence/types.js";

const migration = readFileSync(new URL("../src/persistence/migrations/001_initial.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/persistence/repository.ts", import.meta.url), "utf8");
const hashing = readFileSync(new URL("../src/persistence/hash.ts", import.meta.url), "utf8");

describe("persistence security contract", () => {
  it("requires tenant_id on every tenant-owned table and enables forced RLS", () => {
    expect(migration).toMatch(/CREATE TABLE webhook_events[\s\S]*tenant_id uuid NOT NULL/);
    expect(migration).toMatch(/CREATE TABLE audit_events[\s\S]*tenant_id uuid NOT NULL/);
    expect(migration).toContain("ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE audit_events FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("current_setting('app.tenant_id', true)::uuid");
  });

  it("keeps prohibited high-risk fields out of the initial schema", () => {
    for (const forbidden of ["pdf_blob", "pdf_text", "access_token", "refresh_token", "api_key", "iban"]) {
      expect(migration.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("repository methods require explicit tenant context for tenant-owned access", () => {
    for (const method of [
      "insertWebhookEvent(",
      "acknowledgeWebhookEvent(",
      "listPendingWebhookEvents(",
      "appendAuditEvent(",
    ]) {
      const index = repository.indexOf(method);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(repository.slice(index, index + 220)).toContain("tenantId: TenantId");
    }
  });

  it("keeps destructive maintenance off the runtime repository", () => {
    const runtimeStart = repository.indexOf("export interface PersistenceRepository");
    const maintenanceStart = repository.indexOf("export interface PersistenceMaintenanceRepository");
    const runtimeSection = repository.slice(runtimeStart, maintenanceStart);
    expect(runtimeSection).not.toContain("deleteExpired");
    expect(runtimeSection).not.toContain("deleteTenantData");
    expect(repository.slice(maintenanceStart)).toContain("deleteExpiredWebhookEvents(tenantId: TenantId");
    expect(repository.slice(maintenanceStart)).toContain("deleteExpiredAuditEvents(tenantId: TenantId");
    expect(repository.slice(maintenanceStart)).toContain("deleteTenantData(tenantId: TenantId");
    ]) {
      const index = repository.indexOf(method);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(repository.slice(index, index + 220)).toContain("tenantId: TenantId");
    }
  });

  it("separates the one global organization-to-tenant directory lookup", () => {
    expect(repository).toContain("export interface TenantDirectory");
    expect(repository).toContain("resolveOrganizationHash(organizationHash: string)");
    expect(repository).not.toContain("getTenantByOrganizationHash");
  });

  it("uses domain-separated hashes and a secret-keyed audit actor hash", () => {
    expect(hashing).toContain('update("\\0")');
    expect(hashing).toContain('createHmac("sha256"');
    expect(hashing).toContain('"audit-actor\\0"');
  });

  it("accepts only UUID-shaped explicit tenant ids", () => {
    expect(asTenantId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(() => asTenantId("1")).toThrow();
    expect(() => asTenantId("default")).toThrow();
    expect(() => asTenantId("")).toThrow();
  });
});
