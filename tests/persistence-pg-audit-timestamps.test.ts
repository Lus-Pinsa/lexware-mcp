/**
 * Audit timestamps through the REAL driver and PostgreSQL timestamptz (no mocks): the hash computed before INSERT
 * must be reproducible from what PostgreSQL stores and the driver returns.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAuditEntryHash } from "../src/persistence/audit.js";
import { verifyAuditChainIntegrity } from "../src/persistence/integrity.js";
import { appendAuditEvent, withTenantTransaction } from "../src/persistence/repository.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { ACTOR, createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

describe.skipIf(!postgresAvailable())("audit timestamps on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
    fx = await createPgFixture(pg);
  }, 120_000);
  afterAll(async () => {
    await fx?.close();
    await pg?.stop();
  });

  const append = (tenant: typeof fx.tenantA, createdAt: string) =>
    withTenantTransaction(tenant, fx.runtime(), (tx) =>
      appendAuditEvent(tenant, tx, { auditId: randomUUID(), actorHash: ACTOR, action: "test.event", result: "SUCCESS", itemCount: 0, createdAt }),
    );
  const verify = (tenant: typeof fx.tenantA) => withTenantTransaction(tenant, fx.runtime(), (tx) => verifyAuditChainIntegrity(tenant, tx));

  it.each([
    ["UTC with milliseconds", "2026-02-01T10:00:00.123Z"],
    ["positive offset", "2026-02-01T12:00:00.124+02:00"],
    ["negative offset without colon", "2026-02-01T05:00:00.125-0500"],
    ["no fraction", "2026-02-01T10:00:01Z"],
    ["trailing zero sub-millisecond digits", "2026-02-01T10:00:02.126000Z"],
  ])("a chain stays verifiable after appending a timestamp with %s", async (_label, createdAt) => {
    await append(fx.tenantA, createdAt);
    await expect(verify(fx.tenantA)).resolves.toMatchObject({ headHash: expect.any(String) });
  });

  it("stores one canonical instant: equal instants in different notations hash identically", () => {
    const base = { auditId: randomUUID(), tenantId: fx.tenantA, actorHash: ACTOR, action: "x", result: "SUCCESS", itemCount: 0, previousHash: null };
    const h1 = computeAuditEntryHash({ ...base, createdAt: "2026-03-01T10:00:00.000Z" });
    const h2 = computeAuditEntryHash({ ...base, createdAt: "2026-03-01T11:00:00+01:00" });
    const h3 = computeAuditEntryHash({ ...base, createdAt: "2026-03-01T10:00:00.000000Z" });
    expect(h2).toBe(h1);
    expect(h3).toBe(h1);
  });

  it.each([
    ["sub-millisecond precision that PostgreSQL+driver would silently drop", "2026-02-01T10:00:00.1234Z"],
    ["nanoseconds", "2026-02-01T10:00:00.000000001Z"],
    ["invalid calendar day", "2026-02-30T10:00:00Z"],
    ["invalid leap day", "2025-02-29T10:00:00Z"],
    ["hour 24", "2026-02-01T24:00:00Z"],
    ["offset beyond +14:00", "2026-02-01T10:00:00+15:00"],
    ["missing zone", "2026-02-01T10:00:00"],
  ])("rejects %s before anything is written", async (_label, createdAt) => {
    await expect(append(fx.tenantB, createdAt)).rejects.toThrow(/Invalid audit timestamp/);
  });

  it("leaves the chain of the other tenant verifiable", async () => {
    await expect(verify(fx.tenantB)).resolves.toMatchObject({ count: 1 });
  });
});
