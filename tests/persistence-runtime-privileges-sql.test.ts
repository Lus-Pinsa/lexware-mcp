import { describe, expect, it, vi } from "vitest";
import { inspectRuntimePrivileges, type SqlExecutor } from "../src/persistence/repository.js";

/**
 * Static guard for the privilege SQL (taken over from PR #27 and extended). The behaviour itself is proven against
 * real PostgreSQL roles in tests/persistence-pg-privileges.test.ts; this test keeps the guard when PostgreSQL is
 * not available. has_table_privilege(..., 'A,B') answers whether ANY named privilege exists.
 */
describe("runtime privilege SQL semantics", () => {
  async function capturedSql(): Promise<string> {
    let sql = "";
    const tx = {
      query: vi.fn(async (statement: { readonly text: string; readonly values: readonly unknown[] }) => {
        sql = statement.text;
        return { rowCount: 1, rows: [{ role_name: "lus_runtime", role_memberships: 0 }] };
      }),
    } as unknown as SqlExecutor;
    await inspectRuntimePrivileges(tx);
    return sql;
  }

  it("requires every webhook DML privilege and every audit append privilege independently (ALL-OF)", async () => {
    const sql = await capturedSql();
    expect(sql).toMatch(
      /has_table_privilege\(current_user, 'public\.webhook_events', 'SELECT'\) AND has_table_privilege\(current_user, 'public\.webhook_events', 'INSERT'\) AND has_table_privilege\(current_user, 'public\.webhook_events', 'UPDATE'\)\) AS webhook_dml/,
    );
    expect(sql).toMatch(
      /has_table_privilege\(current_user, 'public\.audit_events', 'SELECT'\) AND has_table_privilege\(current_user, 'public\.audit_events', 'INSERT'\)\) AS audit_append/,
    );
    expect(sql).not.toContain("'SELECT,INSERT,UPDATE') AS webhook_dml");
    expect(sql).not.toContain("'SELECT,INSERT') AS audit_append");
  });

  it("treats any single forbidden privilege as a violation, including column-level grants, TRIGGER and REFERENCES", async () => {
    const sql = await capturedSql();
    expect(sql).toContain("'public.webhook_events', 'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS webhook_delete");
    for (const [table, flag, columns] of [
      ["audit_events", "audit_mutate", "UPDATE,REFERENCES"],
      ["audit_retention_anchors", "audit_anchor_mutate", "INSERT,UPDATE,REFERENCES"],
      ["tenants", "tenants_mutate", "INSERT,UPDATE,REFERENCES"],
      ["schema_migrations", "migrations_mutate", "INSERT,UPDATE,REFERENCES"],
    ] as const) {
      expect(sql, flag).toMatch(new RegExp(`has_table_privilege\\(current_user, 'public\\.${table}', '[A-Z,]*TRIGGER,REFERENCES'\\) OR`));
      expect(sql, flag).toContain(`has_any_column_privilege(current_user, 'public.${table}', '${columns}')) AS ${flag}`);
    }
  });

  it("checks CREATE on every schema, schema ownership and the replication attribute (search_path shadowing)", async () => {
    const sql = await capturedSql();
    expect(sql).toContain("EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(current_user, n.oid, 'CREATE')) AS can_create_in_any_schema");
    expect(sql).toContain("EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS owns_schema");
    expect(sql).toContain("r.rolreplication AS is_replication");
  });
});
