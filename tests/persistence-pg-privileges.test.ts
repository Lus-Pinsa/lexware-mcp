/**
 * Runtime least-privilege verification against REAL PostgreSQL roles (no mocks).
 *
 * Each case provisions a fresh role with the exact production runtime grants, removes one required privilege or
 * adds one forbidden privilege, connects AS that role through the production driver and runs the production check.
 * PostgreSQL semantics under test: has_table_privilege(..., 'A,B') is ANY-OF; table-level checks do not see
 * column-level grants (has_any_column_privilege does).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectRuntimePrivileges } from "../src/persistence/repository.js";
import { assertLeastPrivilegeRuntimeRole } from "../src/persistence/runtime-privileges.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const BASE_GRANTS = [
  "GRANT USAGE ON SCHEMA public TO {r}",
  "GRANT SELECT ON schema_migrations, tenants, audit_retention_anchors TO {r}",
  "GRANT SELECT, INSERT, UPDATE ON webhook_events TO {r}",
  "GRANT SELECT, INSERT ON audit_events TO {r}",
  "GRANT SELECT ON tenant_runtime_bindings TO {r}",
];

describe.skipIf(!postgresAvailable())("runtime privilege verification on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;
  let n = 0;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
    fx = await createPgFixture(pg);
  }, 120_000);

  afterAll(async () => {
    await fx?.close();
    await pg?.stop();
  });

  /** Provision a role with the base grants plus `extra` SQL, minus `revoke` SQL, then run the production check. */
  async function check(opts: { revoke?: string[]; extra?: string[] } = {}): Promise<string | null> {
    const role = `lus_rt_case_${n++}`;
    await pg.admin("postgres", `CREATE ROLE ${role} LOGIN`);
    const sql = [...BASE_GRANTS, ...(opts.extra ?? []), ...(opts.revoke ?? [])].map((s) => s.replaceAll("{r}", role));
    await fx.admin(sql.join(";\n") + ";");
    const db = fx.runtime(role);
    try {
      const snapshot = await db.transaction((tx) => inspectRuntimePrivileges(tx));
      assertLeastPrivilegeRuntimeRole(snapshot, role);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it("accepts exactly the provisioned least-privilege runtime role", async () => {
    expect(await check()).toBeNull();
  });

  it.each([
    ["webhook SELECT", "REVOKE SELECT ON webhook_events FROM {r}", "WEBHOOK_DML_MISSING"],
    ["webhook INSERT", "REVOKE INSERT ON webhook_events FROM {r}", "WEBHOOK_DML_MISSING"],
    ["webhook UPDATE", "REVOKE UPDATE ON webhook_events FROM {r}", "WEBHOOK_DML_MISSING"],
    ["audit SELECT", "REVOKE SELECT ON audit_events FROM {r}", "AUDIT_APPEND_MISSING"],
    ["audit INSERT", "REVOKE INSERT ON audit_events FROM {r}", "AUDIT_APPEND_MISSING"],
    ["migrations SELECT", "REVOKE SELECT ON schema_migrations FROM {r}", "MIGRATION_READ_MISSING"],
    ["tenants SELECT", "REVOKE SELECT ON tenants FROM {r}", "TENANT_READ_MISSING"],
    ["anchor SELECT", "REVOKE SELECT ON audit_retention_anchors FROM {r}", "AUDIT_ANCHOR_READ_MISSING"],
  ])("rejects a role missing the single required privilege %s", async (_label, revoke, code) => {
    const message = await check({ revoke: [revoke] });
    expect(message).toMatch(/Runtime database privilege verification failed/);
    expect(message).toContain(code);
  });

  it.each([
    ["webhook DELETE", "GRANT DELETE ON webhook_events TO {r}", "WEBHOOK_DELETE"],
    ["webhook TRUNCATE", "GRANT TRUNCATE ON webhook_events TO {r}", "WEBHOOK_DELETE"],
    ["audit UPDATE", "GRANT UPDATE ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["audit DELETE", "GRANT DELETE ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["audit TRUNCATE", "GRANT TRUNCATE ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["anchor INSERT", "GRANT INSERT ON audit_retention_anchors TO {r}", "AUDIT_ANCHOR_MUTATION"],
    ["anchor UPDATE", "GRANT UPDATE ON audit_retention_anchors TO {r}", "AUDIT_ANCHOR_MUTATION"],
    ["anchor DELETE", "GRANT DELETE ON audit_retention_anchors TO {r}", "AUDIT_ANCHOR_MUTATION"],
    ["tenants INSERT", "GRANT INSERT ON tenants TO {r}", "TENANT_MUTATION"],
    ["tenants UPDATE", "GRANT UPDATE ON tenants TO {r}", "TENANT_MUTATION"],
    ["migrations INSERT", "GRANT INSERT ON schema_migrations TO {r}", "MIGRATION_MUTATION"],
    ["schema CREATE", "GRANT CREATE ON SCHEMA public TO {r}", "SCHEMA_CREATE"],
    ["PUBLIC audit UPDATE", "GRANT UPDATE ON audit_events TO PUBLIC", "AUDIT_MUTATION"],
  ])("rejects a role with the single forbidden table privilege %s", async (_label, grant, code) => {
    const message = await check({ extra: [grant] });
    if (grant.includes("PUBLIC")) await fx.admin("REVOKE UPDATE ON audit_events FROM PUBLIC");
    expect(message).toContain(code);
  });

  it.each([
    ["audit UPDATE(entry_hash)", "GRANT UPDATE (entry_hash) ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["audit UPDATE(previous_hash)", "GRANT UPDATE (previous_hash) ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["anchor UPDATE(previous_hash)", "GRANT UPDATE (previous_hash) ON audit_retention_anchors TO {r}", "AUDIT_ANCHOR_MUTATION"],
    ["anchor INSERT(columns)", "GRANT INSERT (tenant_id, previous_hash, updated_at) ON audit_retention_anchors TO {r}", "AUDIT_ANCHOR_MUTATION"],
    ["tenants UPDATE(capability_tier)", "GRANT UPDATE (capability_tier) ON tenants TO {r}", "TENANT_MUTATION"],
    ["tenants UPDATE(max_audit_events)", "GRANT UPDATE (max_audit_events) ON tenants TO {r}", "TENANT_MUTATION"],
    ["migrations UPDATE(checksum)", "GRANT UPDATE (checksum) ON schema_migrations TO {r}", "MIGRATION_MUTATION"],
  ])("rejects a role with the single forbidden COLUMN privilege %s", async (_label, grant, code) => {
    expect(await check({ extra: [grant] })).toContain(code);
  });

  it.each([
    ["TRIGGER on audit_events", "GRANT TRIGGER ON audit_events TO {r}", "AUDIT_MUTATION"],
    ["TRIGGER on webhook_events", "GRANT TRIGGER ON webhook_events TO {r}", "WEBHOOK_DELETE"],
    ["TRIGGER on tenants", "GRANT TRIGGER ON tenants TO {r}", "TENANT_MUTATION"],
  ])("rejects a role that may attach triggers: %s", async (_label, grant, code) => {
    expect(await check({ extra: [grant] })).toContain(code);
  });

  it.each([
    ["REFERENCES on tenants", ["GRANT REFERENCES ON tenants TO {r}"], "TENANT_MUTATION"],
    ["REFERENCES (tenant_id) on audit_events", ["GRANT REFERENCES (tenant_id) ON audit_events TO {r}"], "AUDIT_MUTATION"],
    ["CREATE on another schema", ["CREATE SCHEMA other_{r}", "GRANT USAGE, CREATE ON SCHEMA other_{r} TO {r}"], "ANY_SCHEMA_CREATE"],
    ["an own schema (first in the default search_path)", ["CREATE SCHEMA {r} AUTHORIZATION {r}"], "SCHEMA_OWNER"],
    ["the REPLICATION attribute", ["ALTER ROLE {r} REPLICATION"], "REPLICATION"],
    ["SET on session_replication_role (skips ordinary triggers)", ["GRANT SET ON PARAMETER session_replication_role TO {r}"], "PARAMETER_PRIVILEGE"],
    ["ALTER SYSTEM on a parameter", ["GRANT ALTER SYSTEM ON PARAMETER work_mem TO {r}"], "PARAMETER_PRIVILEGE"],
    ["ownership of a function", ["CREATE FUNCTION public.f_{r}() RETURNS int LANGUAGE sql AS 'SELECT 1'", "ALTER FUNCTION public.f_{r}() OWNER TO {r}"], "OBJECT_OWNER"],
    ["ownership of the append guard function", ["ALTER FUNCTION public.audit_events_append_guard() OWNER TO {r}"], "OBJECT_OWNER"],
    ["default privileges on future tables", ["ALTER DEFAULT PRIVILEGES FOR ROLE lus_owner IN SCHEMA public GRANT ALL ON TABLES TO {r}"], "DEFAULT_PRIVILEGES"],
    ["an executable SECURITY DEFINER function", ["CREATE FUNCTION public.ops_fix_{r}() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'", "ALTER FUNCTION public.ops_fix_{r}() OWNER TO lus_owner"], "SECURITY_DEFINER_FUNCTION"],
  ])("rejects a role with %s", async (_label, extra, code) => {
    try {
      expect(await check({ extra })).toContain(code);
    } finally {
      // Shared fixture: undo database-wide side effects so later cases start from the provisioned state.
      await fx.admin(
        "ALTER FUNCTION public.audit_events_append_guard() OWNER TO lus_owner; " +
          "DO $$DECLARE f record; BEGIN FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname LIKE 'ops_fix_%' " +
          "LOOP EXECUTE 'DROP FUNCTION ' || f.sig; END LOOP; END $$;",
      );
    }
  });

  it("a session that created a temporary table still passes (own temp schema is not 'CREATE on any schema')", async () => {
    const db = fx.runtime();
    const message = await db.transaction(async (tx) => {
      await tx.query({ text: "CREATE TEMPORARY TABLE scratch_probe (x int) ON COMMIT DROP", values: [] });
      try {
        assertLeastPrivilegeRuntimeRole(await inspectRuntimePrivileges(tx), "lus_runtime");
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(message).toBeNull();
  });

  it("search_path is pinned: an own-schema or temporary table never shadows a persistence table", async () => {
    const role = `lus_rt_shadow_${n++}`;
    await pg.admin("postgres", `CREATE ROLE ${role} LOGIN`);
    await fx.admin(
      [...BASE_GRANTS, "CREATE SCHEMA {r} AUTHORIZATION {r}", "GRANT TEMPORARY ON DATABASE " + fx.database + " TO {r}"]
        .map((s) => s.replaceAll("{r}", role))
        .join(";\n") + ";",
    );
    await fx.bindRuntime(fx.tenantA, role);
    const db = fx.runtime(role);
    const counts = await db.transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [fx.tenantA] });
      // Shadow candidates without a tenant_id column: if either one were resolved, the next query would fail.
      await tx.query({ text: `CREATE TABLE ${role}.audit_events (x int)`, values: [] });
      await tx.query({ text: "CREATE TEMPORARY TABLE audit_events (x int) ON COMMIT DROP", values: [] });
      const path = await tx.query<{ p: string }>({ text: "SELECT current_setting('search_path') AS p", values: [] });
      const rows = await tx.query<{ c: number }>({ text: "SELECT count(*)::int AS c FROM audit_events WHERE tenant_id = $1", values: [fx.tenantA] });
      return { path: path.rows[0]!.p, count: rows.rows[0]!.c };
    });
    expect(counts.path).toBe("public, pg_temp");
    expect(counts.count).toBeGreaterThanOrEqual(1);
  });

  it("rejects privileges inherited through role membership", async () => {
    await pg.admin("postgres", "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lus_rt_parent') THEN CREATE ROLE lus_rt_parent NOLOGIN; END IF; END $$;");
    await fx.admin("GRANT UPDATE ON audit_events TO lus_rt_parent");
    const message = await check({ extra: ["GRANT lus_rt_parent TO {r}"] });
    expect(message).toContain("ROLE_MEMBERSHIP");
    expect(message).toContain("AUDIT_MUTATION");
  });

  it("proves the impact: a column-level UPDATE grant really lets the runtime rewrite an audit hash", async () => {
    const role = `lus_rt_impact_${n++}`;
    await pg.admin("postgres", `CREATE ROLE ${role} LOGIN`);
    await fx.admin([...BASE_GRANTS, "GRANT UPDATE (entry_hash) ON audit_events TO {r}"].map((s) => s.replaceAll("{r}", role)).join(";\n") + ";");
    await fx.bindRuntime(fx.tenantA, role);
    const db = fx.runtime(role);
    const changed = await db.transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [fx.tenantA] });
      const result = await tx.query({ text: "UPDATE audit_events SET entry_hash = $1 WHERE tenant_id = $2", values: ["f".repeat(64), fx.tenantA] });
      return result.rowCount;
    });
    expect(changed).toBe(1);
  });
});
