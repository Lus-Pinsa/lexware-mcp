import { describe, expect, it } from "vitest";
import {
  PostgresPersistenceRepository,
  PostgresTenantDirectory,
} from "../src/persistence/postgres-repository.js";
import type { SqlDatabase, SqlQueryResult, SqlSession } from "../src/persistence/sql.js";
import { asTenantId, type PersistedWebhookEvent } from "../src/persistence/types.js";

type Step = {
  contains: string;
  rows?: Record<string, unknown>[];
  rowCount?: number;
};

function scriptedDb(steps: Step[]) {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  let index = 0;
  const session: SqlSession = {
    async query(text, params = []): Promise<SqlQueryResult> {
      calls.push({ text, params });
      const step = steps[index++];
      if (!step) throw new Error(`Unexpected SQL: ${text}`);
      expect(text).toContain(step.contains);
      return { rows: step.rows ?? [], rowCount: step.rowCount ?? (step.rows?.length ?? 0) };
    },
  };
  const db: SqlDatabase = {
    query: session.query,
    async transaction(work) {
      return work(session);
    },
  };
  return { db, session, calls, done: () => expect(index).toBe(steps.length) };
}

const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");

const event = (): Omit<PersistedWebhookEvent, "tenantId"> => ({
  eventKeyHash: "a".repeat(64),
  organizationHash: "b".repeat(64),
  resourceIdCiphertext: "ciphertext",
  resourceIdNonce: "nonce",
  resourceIdAuthTag: "tag",
  resourceIdKeyId: "v1",
  eventType: "voucher.created",
  receivedAt: "2026-10-09T08:00:00.000Z",
  acknowledgedAt: null,
  payloadSha256: "c".repeat(64),
  source: "lexware-webhook",
  quality: "STRUCTURED",
  requestBudgetStatus: "OK",
});

describe("Postgres tenant directory", () => {
  it("resolves only a parameterized organization hash", async () => {
    const fake = scriptedDb([
      {
        contains: "WHERE organization_hash = $1",
        rows: [{ tenant_id: tenantId }],
      },
    ]);
    const directory = new PostgresTenantDirectory(fake.session);
    await expect(directory.resolveOrganizationHash("d".repeat(64))).resolves.toEqual({ tenantId });
    expect(fake.calls[0]?.params).toEqual(["d".repeat(64)]);
    expect(fake.calls[0]?.text).not.toContain("d".repeat(64));
    fake.done();
  });

  it("returns null for an unknown organization", async () => {
    const fake = scriptedDb([{ contains: "WHERE organization_hash = $1", rows: [] }]);
    const directory = new PostgresTenantDirectory(fake.session);
    await expect(directory.resolveOrganizationHash("e".repeat(64))).resolves.toBeNull();
    fake.done();
  });
});

describe("Postgres persistence repository", () => {
  it("inserts a webhook atomically after tenant lock, duplicate check and limit check", async () => {
    const fake = scriptedDb([
      { contains: "set_config('app.tenant_id'" },
      { contains: "FROM tenants WHERE tenant_id = $1 FOR UPDATE", rows: [{ tenant_id: tenantId }] },
      { contains: "FROM webhook_events WHERE tenant_id = $1 AND event_key_hash = $2", rows: [] },
      { contains: "count(*)::int AS count FROM webhook_events", rows: [{ count: 0 }] },
      { contains: "INSERT INTO webhook_events", rows: [{ "?column?": 1 }] },
    ]);
    const repository = new PostgresPersistenceRepository(fake.db);
    await expect(repository.insertWebhookEvent(tenantId, event())).resolves.toBe("inserted");
    expect(fake.calls.at(-1)?.params[0]).toBe(tenantId);
    fake.done();
  });

  it("treats exact replay as duplicate before consuming capacity", async () => {
    const fake = scriptedDb([
      { contains: "set_config('app.tenant_id'" },
      { contains: "FROM tenants WHERE tenant_id = $1 FOR UPDATE", rows: [{ tenant_id: tenantId }] },
      { contains: "FROM webhook_events WHERE tenant_id = $1 AND event_key_hash = $2", rows: [{ "?column?": 1 }] },
    ]);
    const repository = new PostgresPersistenceRepository(fake.db);
    await expect(repository.insertWebhookEvent(tenantId, event())).resolves.toBe("duplicate");
    fake.done();
  });

  it("fails visibly when the pending-event tenant limit is reached", async () => {
    const fake = scriptedDb([
      { contains: "set_config('app.tenant_id'" },
      { contains: "FROM tenants WHERE tenant_id = $1 FOR UPDATE", rows: [{ tenant_id: tenantId }] },
      { contains: "FROM webhook_events WHERE tenant_id = $1 AND event_key_hash = $2", rows: [] },
      { contains: "count(*)::int AS count FROM webhook_events", rows: [{ count: 1000 }] },
    ]);
    const repository = new PostgresPersistenceRepository(fake.db);
    await expect(repository.insertWebhookEvent(tenantId, event())).rejects.toThrow(/limit exceeded/);
    fake.done();
  });

  it("never interpolates tenant or event identifiers into SQL text", async () => {
    const fake = scriptedDb([
      { contains: "set_config('app.tenant_id'" },
      { contains: "UPDATE webhook_events", rows: [{ "?column?": 1 }] },
    ]);
    const repository = new PostgresPersistenceRepository(fake.db);
    const eventHash = "f".repeat(64);
    await repository.acknowledgeWebhookEvent(tenantId, eventHash, "2026-10-09T09:00:00.000Z");
    const sql = fake.calls.map((c) => c.text).join("\n");
    expect(sql).not.toContain(tenantId);
    expect(sql).not.toContain(eventHash);
    fake.done();
  });

  it("appends a hash-chained audit event under the tenant transaction", async () => {
    const fake = scriptedDb([
      { contains: "set_config('app.tenant_id'" },
      { contains: "FROM tenants WHERE tenant_id = $1 FOR UPDATE", rows: [{ tenant_id: tenantId }] },
      { contains: "count(*)::int AS count FROM audit_events", rows: [{ count: 0 }] },
      { contains: "SELECT entry_hash", rows: [] },
      { contains: "INSERT INTO audit_events", rows: [] },
    ]);
    const repository = new PostgresPersistenceRepository(
      fake.db,
      () => new Date("2026-10-09T09:30:00.000Z"),
    );
    await repository.appendAuditEvent(tenantId, {
      actorHash: "a".repeat(64),
      action: "TENANT_CREATE",
      result: "SUCCESS",
      count: 1,
    });
    const params = fake.calls.at(-1)?.params ?? [];
    expect(params[0]).toBe(tenantId);
    expect(params[1]).toBe("2026-10-09T09:30:00.000Z");
    expect(params.at(-1)).toMatch(/^[a-f0-9]{64}$/);
    fake.done();
  });
});
