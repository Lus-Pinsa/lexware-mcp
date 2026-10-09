import { describe, expect, it, vi } from "vitest";
import { inspectRuntimePrivileges, type SqlExecutor } from "../src/persistence/repository.js";

/**
 * Regression: PostgreSQL has_table_privilege with a comma-separated list
 * answers whether ANY named privilege exists. Runtime writes require ALL.
 * This verifies the SQL expression, not just a mocked Boolean snapshot.
 */
describe("runtime privilege SQL all-of semantics", () => {
  it("requires every webhook DML privilege and every audit append privilege independently", async () => {
    let sql = "";
    const tx = {
      query: vi.fn(async (statement: { readonly text: string; readonly values: readonly unknown[] }) => {
        sql = statement.text;
        return {
          rowCount: 1,
          rows: [{ role_name: "lus_runtime", role_memberships: 0 }],
        };
      }),
    } as unknown as SqlExecutor;

    await inspectRuntimePrivileges(tx);

    expect(sql).toMatch(
      /has_table_privilege\(current_user, 'public\.webhook_events', 'SELECT'\) AND has_table_privilege\(current_user, 'public\.webhook_events', 'INSERT'\) AND has_table_privilege\(current_user, 'public\.webhook_events', 'UPDATE'\)\) AS webhook_dml/,
    );
    expect(sql).toMatch(
      /has_table_privilege\(current_user, 'public\.audit_events', 'SELECT'\) AND has_table_privilege\(current_user, 'public\.audit_events', 'INSERT'\)\) AS audit_append/,
    );

    // A comma-separated list is an OR, and would mask absent INSERT/UPDATE.
    expect(sql).not.toContain("'SELECT,INSERT,UPDATE') AS webhook_dml");
    expect(sql).not.toContain("'SELECT,INSERT') AS audit_append");

    // Forbidden rights are correctly any-of checks, and must remain so.
    expect(sql).toContain("'DELETE,TRUNCATE') AS webhook_delete");
    expect(sql).toContain("'UPDATE,DELETE,TRUNCATE') AS audit_mutate");
    expect(sql).toContain("'INSERT,UPDATE,DELETE,TRUNCATE') AS audit_anchor_mutate");
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});
