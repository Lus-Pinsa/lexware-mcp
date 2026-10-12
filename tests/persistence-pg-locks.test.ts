/**
 * Tenant advisory lock on REAL PostgreSQL with separate connections (no mocks).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { lockTenantForUpdate, withTenantTransaction } from "../src/persistence/repository.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!postgresAvailable())("tenant advisory lock on real PostgreSQL", () => {
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

  /** Hold the tenant lock in one transaction until `release` resolves. */
  function holdLock(db: ReturnType<PgFixture["runtime"]>, tenant: typeof fx.tenantA, release: Promise<void>, onLocked: () => void, fail = false) {
    return withTenantTransaction(tenant, db, async (tx) => {
      await lockTenantForUpdate(tenant, tx);
      onLocked();
      await release;
      if (fail) throw new Error("rollback on purpose");
    });
  }

  it("executes the lock statement as the runtime role (regression: uuid = text)", async () => {
    await expect(withTenantTransaction(fx.tenantA, fx.runtime(), (tx) => lockTenantForUpdate(fx.tenantA, tx))).resolves.toBeUndefined();
  });

  it("serializes two connections on the same tenant and releases at COMMIT", async () => {
    const db1 = fx.runtime();
    const db2 = fx.runtime();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let firstLocked = false;
    const first = holdLock(db1, fx.tenantA, released, () => (firstLocked = true));
    while (!firstLocked) await sleep(10);
    let secondLockedAt = 0;
    const second = holdLock(db2, fx.tenantA, Promise.resolve(), () => (secondLockedAt = Date.now()));
    await sleep(300);
    expect(secondLockedAt).toBe(0);
    const releasedAt = Date.now();
    release();
    await first;
    await second;
    expect(secondLockedAt).toBeGreaterThanOrEqual(releasedAt);
  });

  it("does not block a different tenant", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let aLocked = false;
    const holder = holdLock(fx.runtime(), fx.tenantA, released, () => (aLocked = true));
    while (!aLocked) await sleep(10);
    let bLocked = false;
    await holdLock(fx.runtime(), fx.tenantB, Promise.resolve(), () => (bLocked = true));
    expect(bLocked).toBe(true);
    release();
    await holder;
  });

  it("releases the lock on ROLLBACK", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked = false;
    const failing = holdLock(fx.runtime(), fx.tenantA, released, () => (locked = true), true);
    while (!locked) await sleep(10);
    release();
    await expect(failing).rejects.toThrow();
    let again = false;
    await holdLock(fx.runtime(), fx.tenantA, Promise.resolve(), () => (again = true));
    expect(again).toBe(true);
  });

  it("releases the lock when the holding connection dies", async () => {
    const raw = postgres(pg.url(fx.database, "lus_runtime"), { ssl: "require", max: 1, onnotice: () => undefined });
    const reserved = await raw.reserve();
    await reserved.unsafe("BEGIN");
    await reserved.unsafe("SELECT set_config('app.tenant_id', $1, true)", [fx.tenantA]);
    await reserved.unsafe("SELECT pg_advisory_xact_lock(1280659284, hashtext($1::uuid::text))", [fx.tenantA]);
    const [{ pid }] = await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    await fx.admin(`SELECT pg_terminate_backend(${Number(pid)})`);
    let locked = false;
    await holdLock(fx.runtime(), fx.tenantA, Promise.resolve(), () => (locked = true));
    expect(locked).toBe(true);
    reserved.release();
    await raw.end({ timeout: 1 }).catch(() => undefined);
  });

  it("uses the same lock key as the production statement (manual lock blocks the production path)", async () => {
    const raw = postgres(pg.url(fx.database, "lus_runtime"), { ssl: "require", max: 1, onnotice: () => undefined });
    const reserved = await raw.reserve();
    await reserved.unsafe("BEGIN");
    await reserved.unsafe("SELECT pg_advisory_xact_lock(1280659284, hashtext($1::uuid::text))", [fx.tenantA]);
    let locked = false;
    const waiting = holdLock(fx.runtime(), fx.tenantA, Promise.resolve(), () => (locked = true));
    await sleep(300);
    expect(locked).toBe(false);
    await reserved.unsafe("COMMIT");
    await waiting;
    expect(locked).toBe(true);
    reserved.release();
    await raw.end({ timeout: 1 });
  });
});
