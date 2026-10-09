import { describe, expect, it } from "vitest";
import { withTenantTransaction, type SqlDatabase, type SqlSession } from "../src/persistence/sql.js";
import { asTenantId } from "../src/persistence/types.js";

describe("tenant SQL transaction boundary", () => {
  it("sets tenant context before executing tenant work", async () => {
    const calls: Array<{ text: string; params?: readonly unknown[] }> = [];
    const session: SqlSession = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const db: SqlDatabase = {
      query: session.query,
      async transaction(work) {
        calls.push({ text: "BEGIN" });
        const result = await work(session);
        calls.push({ text: "COMMIT" });
        return result;
      },
    };

    const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");
    const result = await withTenantTransaction(db, tenantId, async (tx) => {
      await tx.query("SELECT 1 WHERE $1 = $1", ["safe"]);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls[0]?.text).toBe("BEGIN");
    expect(calls[1]).toEqual({
      text: "SELECT set_config('app.tenant_id', $1, true)",
      params: [tenantId],
    });
    expect(calls[2]?.text).toBe("SELECT 1 WHERE $1 = $1");
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  it("never interpolates the tenant id into SQL text", async () => {
    const texts: string[] = [];
    const session: SqlSession = {
      async query(text) {
        texts.push(text);
        return { rows: [], rowCount: 0 };
      },
    };
    const db: SqlDatabase = {
      query: session.query,
      async transaction(work) {
        return work(session);
      },
    };
    const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");
    await withTenantTransaction(db, tenantId, async () => undefined);
    expect(texts.join("\n")).not.toContain(tenantId);
  });
});
