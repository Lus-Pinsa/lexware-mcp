import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asTenantId } from "../src/persistence/types.js";

const migration = readFileSync(new URL("../src/persistence/migrations/001_initial.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/persistence/repository.ts", import.meta.url), "utf8");

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
      "insertWebhookEvent(tenantId: TenantId",
      "acknowledgeWebhookEvent(tenantId: TenantId",
      "listPendingWebhookEvents(tenantId: TenantId",
      "appendAuditEvent(tenantId: TenantId",
      "deleteExpiredWebhookEvents(tenantId: TenantId",
      "deleteExpiredAuditEvents(tenantId: TenantId",
      "deleteTenantData(tenantId: TenantId",
    ]) {
      expect(repository).toContain(method);
    }
  });

  it("accepts only UUID-shaped explicit tenant ids", () => {
    expect(asTenantId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(() => asTenantId("1")).toThrow();
    expect(() => asTenantId("default")).toThrow();
    expect(() => asTenantId("")).toThrow();
  });
});
