/**
 * Audit append order on REAL PostgreSQL (no mocks).
 *
 * Invariant: the chain order is the serialized append order, not the caller-supplied event time and not the UUID.
 * Event time may repeat or run backwards (clock skew, backdated events) without breaking verification, and retention
 * may only remove a contiguous prefix of the append order.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import { runTenantRetention } from "../src/persistence/retention.js";
import { appendAuditEvent, withTenantTransaction } from "../src/persistence/repository.js";
import { type TenantId } from "../src/persistence/types.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const HIGH_UUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const LOW_UUID = "00000000-0000-4000-8000-000000000001";

describe.skipIf(!postgresAvailable())("audit append order on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await fx?.close();
    fx = await createPgFixture(pg);
  }, 60_000);

  const append = (tenant: TenantId, createdAt: string, auditId: string = randomUUID(), db = fx.runtime()) =>
    withTenantTransaction(tenant, db, (tx) =>
      appendAuditEvent(tenant, tx, { auditId, actorHash: ACTOR, action: "test.event", result: "SUCCESS", itemCount: 0, createdAt }),
    );
  const verify = (tenant: TenantId) => withTenantTransaction(tenant, fx.runtime(), (tx) => verifyAuditChainIntegrity(tenant, tx));
  /** Raw rows as the owner sees them (tenant-bound), for structural assertions. */
  const rows = async (tenant: TenantId) => {
    let out: Array<Record<string, unknown>> = [];
    await fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      out = [...(await tx.query({ text: "SELECT audit_id, previous_hash, entry_hash FROM audit_events WHERE tenant_id = $1", values: [tenant] })).rows];
    });
    return out;
  };

  it("same millisecond with inverted UUID order: the chain still verifies", async () => {
    const t = "2026-04-01T10:00:00.000Z";
    await append(fx.tenantA, t, HIGH_UUID);
    await append(fx.tenantA, t, LOW_UUID);
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 3 });
  });

  it("same millisecond: a third append never forks the chain (no two entries share a predecessor)", async () => {
    const t = "2026-04-01T10:00:00.000Z";
    await append(fx.tenantA, t, HIGH_UUID);
    await append(fx.tenantA, t, LOW_UUID);
    await append(fx.tenantA, t);
    const all = await rows(fx.tenantA);
    const predecessors = all.map((r) => r.previous_hash);
    expect(new Set(predecessors).size).toBe(predecessors.length);
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 4 });
  });

  it("a backdated event (clock runs backwards) is appended after the head and the chain verifies", async () => {
    await append(fx.tenantA, "2026-04-02T10:00:00.000Z");
    await append(fx.tenantA, "2026-03-01T10:00:00.000Z");
    await append(fx.tenantA, "2026-04-03T10:00:00.000Z");
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 4 });
  });

  it("concurrent appends from separate connections produce one linear, verifiable chain", async () => {
    const t = "2026-04-05T10:00:00.000Z";
    await Promise.all(Array.from({ length: 12 }, (_, i) => append(fx.tenantA, t, randomUUID(), fx.runtime()).catch((e) => { throw new Error(`append ${i}: ${(e as Error).message}`); })));
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 13 });
    const all = await rows(fx.tenantA);
    expect(new Set(all.map((r) => r.previous_hash)).size).toBe(all.length);
  });

  it("concurrent appends for two tenants stay isolated and both verify", async () => {
    const t = "2026-04-06T10:00:00.000Z";
    await Promise.all([
      ...Array.from({ length: 6 }, () => append(fx.tenantA, t, randomUUID(), fx.runtime())),
      ...Array.from({ length: 6 }, () => append(fx.tenantB, t, randomUUID(), fx.runtime())),
    ]);
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 7 });
    await expect(verify(fx.tenantB)).resolves.toMatchObject({ count: 7 });
  });

  it("retention removes only a contiguous prefix of the append order and stops at the first retained entry", async () => {
    // Append order: bootstrap(2026-01-01), old(2025-01-01), new(2026-06-01), old-but-later(2025-02-01).
    await append(fx.tenantA, "2025-01-01T00:00:00.000Z");
    await append(fx.tenantA, "2026-06-01T00:00:00.000Z");
    await append(fx.tenantA, "2025-02-01T00:00:00.000Z");
    const result = await runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantA, actorHash: ACTOR, now: () => new Date("2026-09-01T00:00:00.000Z") });
    // bootstrap (2026-01-01) is NOT older than one year before 2026-09-01, so nothing may be pruned: the prefix
    // starts with a retained entry. The old entry later in the chain must survive too.
    expect(result.auditDeleted).toBe(0);
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ count: 5 });
  });

  it("retention prunes the expired prefix, keeps a later backdated entry, and the remaining chain verifies", async () => {
    // Tenant B: bootstrap(2026-01-01) is expired relative to now=2027-06-01, so is the next one; then a fresh entry,
    // then a backdated one that is older than the cutoff but must be kept (not part of the prefix).
    await append(fx.tenantB, "2026-02-01T00:00:00.000Z");
    await append(fx.tenantB, "2027-05-01T00:00:00.000Z");
    await append(fx.tenantB, "2026-03-01T00:00:00.000Z");
    const result = await runTenantRetention({ db: fx.runtimeMaintenance(), tenantId: fx.tenantB, actorHash: ACTOR, now: () => new Date("2027-06-01T00:00:00.000Z") });
    expect(result.auditDeleted).toBe(2);
    // Remaining: fresh, backdated, retention.run entry.
    await expect(verify(fx.tenantB)).resolves.toMatchObject({ count: 3 });
  });
});
