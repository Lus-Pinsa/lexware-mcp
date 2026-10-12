/**
 * Durable pending-voucher queue and webhook acceptance on REAL PostgreSQL (synthetic data, ephemeral cluster).
 *
 * Invariants:
 * - A verified webhook gets 204 only after the queue row is committed; a later reader on another connection sees it.
 * - Redelivery of the same event is deduplicated by the database, also under concurrency.
 * - Capacity is enforced inside the same transaction; an over-capacity event is rolled back, never half-stored.
 * - When the database is unavailable the handler answers 503 and nothing is kept in RAM.
 *
 * Acknowledgements in this file run only against the throw-away test database (no real queue is touched).
 */
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEncryptionKeyring, sha256Hex } from "../src/persistence/crypto.js";
import { createDurablePendingVoucherEventStore } from "../src/persistence/pending-voucher-store.js";
import type { PersistenceDatabase } from "../src/persistence/repository.js";
import type { TenantId } from "../src/persistence/types.js";
import { createLexwareWebhookHandler, type WebhookRequest } from "../src/webhook-receiver.js";
import { postgresAvailable, type EphemeralPostgres } from "./helpers/ephemeral-postgres.js";
import { createPgFixture, maybeStartPostgres, type PgFixture } from "./helpers/persistence-pg-fixture.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RESOURCE = "00000000-0000-4000-8000-0000000000c1";
const EVENT_DATE = "2026-10-07T10:00:00.000+02:00";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

const keyring = createEncryptionKeyring({ "test-k1": randomBytes(32) }, "test-k1");
const checksum = (s: string) => sha256Hex(s);

function signedDelivery(resourceId: string, eventDate = EVENT_DATE) {
  const raw = Buffer.from(JSON.stringify({ organizationId: ORG, eventType: "voucher.created", resourceId, eventDate }));
  const signer = createSign("RSA-SHA512");
  signer.update(raw);
  signer.end();
  return { raw, signature: signer.sign(privateKey).toString("base64") };
}

describe.skipIf(!postgresAvailable())("durable queue and webhook acceptance on real PostgreSQL", () => {
  let pg: EphemeralPostgres;
  let fx: PgFixture;

  beforeAll(async () => {
    pg = (await maybeStartPostgres())!;
  }, 120_000);
  afterAll(async () => {
    await fx?.close();
    await pg?.stop();
  });
  beforeEach(async () => {
    await fx?.close();
    fx = await createPgFixture(pg);
  }, 60_000);

  const store = (tenant: TenantId, db: PersistenceDatabase = fx.runtime()) =>
    createDurablePendingVoucherEventStore({ db, tenantId: tenant, keyring, now: () => new Date("2026-10-08T08:00:00.000Z") });

  /** Owner-side, tenant-bound row count (independent connection; sees only committed rows). */
  const committedRows = async (tenant: TenantId) => {
    let count = -1;
    await fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      const r = await tx.query<{ c: number }>({ text: "SELECT count(*)::int AS c FROM webhook_events WHERE tenant_id = $1", values: [tenant] });
      count = r.rows[0]!.c;
    });
    return count;
  };
  const setWebhookCap = (tenant: TenantId, max: number) =>
    fx.owner().transaction(async (tx) => {
      await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [tenant] });
      await tx.query({ text: "UPDATE tenants SET max_webhook_events = $2 WHERE tenant_id = $1", values: [tenant, max] });
    });

  const handlerFor = (enqueue: Parameters<typeof createLexwareWebhookHandler>[0]["enqueue"]) => {
    const logs: string[] = [];
    const handler = createLexwareWebhookHandler({
      getPublicKey: () => PUBLIC_PEM,
      organizationId: ORG,
      enqueue,
      droppedTotal: () => 0,
      log: (line) => logs.push(line),
    });
    const statuses: number[] = [];
    const send = async (raw: Buffer, signature: string) => {
      const before = statuses.length;
      const req: WebhookRequest = { body: raw, get: (n) => (n.toLowerCase() === "x-lxo-signature" ? signature : undefined) };
      await handler(req, { sendStatus: (s: number) => statuses.push(s) });
      // Exactly one status per request.
      expect(statuses.length - before).toBe(1);
      return statuses[statuses.length - 1]!;
    };
    return { send, logs, statuses };
  };

  it("answers 204 only after the row is committed: a separate connection sees it immediately after", async () => {
    const s = store(fx.tenantA);
    const observed: Array<{ statusesBeforeCommit: number; committedAfter: number }> = [];
    const h = handlerFor(async (e) => {
      const result = await s.enqueue(e);
      // The enqueue transaction has committed here; no status may have been sent yet.
      observed.push({ statusesBeforeCommit: h.statuses.length, committedAfter: await committedRows(fx.tenantA) });
      return result;
    });
    const d = signedDelivery(RESOURCE);
    expect(await h.send(d.raw, d.signature)).toBe(204);
    expect(h.statuses).toEqual([204]);
    expect(observed).toEqual([{ statusesBeforeCommit: 0, committedAfter: 1 }]);
    expect(await committedRows(fx.tenantA)).toBe(1);
    // The stored resource id is encrypted at rest and decrypts back for the bound tenant only.
    const listed = await store(fx.tenantA).list();
    expect(listed.map((e) => e.resourceId)).toEqual([RESOURCE]);
  });

  it("deduplicates a redelivered event (sequential and concurrent from separate connections)", async () => {
    const d = signedDelivery(RESOURCE);
    const first = await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: EVENT_DATE, payloadChecksum: checksum(d.raw.toString()) });
    const second = await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: EVENT_DATE, payloadChecksum: checksum(d.raw.toString()) });
    expect(first).toMatchObject({ added: true, count: 1 });
    expect(second).toMatchObject({ added: false, count: 1 });

    const other = "00000000-0000-4000-8000-0000000000c2";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store(fx.tenantA, fx.runtime()).enqueue({ resourceId: other, eventDate: EVENT_DATE, payloadChecksum: checksum("x") })),
    );
    expect(results.filter((r) => r.added)).toHaveLength(1);
    expect(await committedRows(fx.tenantA)).toBe(2);
  });

  it("the same voucher with a different event date is a distinct event", async () => {
    await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: EVENT_DATE, payloadChecksum: checksum("a") });
    const r = await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: "2026-10-07T11:00:00.000+02:00", payloadChecksum: checksum("b") });
    expect(r).toMatchObject({ added: true, count: 2 });
  });

  it("capacity: an event beyond the tenant limit is rejected and rolled back, the webhook answers 503", async () => {
    await setWebhookCap(fx.tenantA, 1);
    const s = store(fx.tenantA);
    const { send, logs } = handlerFor((e) => s.enqueue(e));
    const one = signedDelivery("00000000-0000-4000-8000-0000000000d1");
    const two = signedDelivery("00000000-0000-4000-8000-0000000000d2");
    expect(await send(one.raw, one.signature)).toBe(204);
    expect(await send(two.raw, two.signature)).toBe(503);
    expect(logs).toContain("[lexware-webhook] queue unavailable");
    expect(await committedRows(fx.tenantA)).toBe(1);
    // A redelivery of the already stored event is still accepted (no new row, so no capacity violation).
    expect(await send(one.raw, one.signature)).toBe(204);
    expect(await committedRows(fx.tenantA)).toBe(1);
  });

  it("database unavailable: 503 and no RAM fallback (nothing is listed afterwards)", async () => {
    const dead = fx.runtime();
    await dead.close();
    const s = store(fx.tenantA, dead);
    expect(s.mode).toBe("postgres");
    const { send } = handlerFor((e) => s.enqueue(e));
    const d = signedDelivery(RESOURCE);
    expect(await send(d.raw, d.signature)).toBe(503);
    expect(s.droppedTotal()).toBe(0);
    await expect(s.list()).rejects.toThrow();
    expect(await committedRows(fx.tenantA)).toBe(0);
  });

  it("acknowledge (test database only) hides the event from the queue but keeps the row; the runtime cannot delete", async () => {
    await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: EVENT_DATE, payloadChecksum: checksum("a") });
    const ack = await store(fx.tenantA).acknowledge(RESOURCE);
    expect(ack).toEqual({ removed: 1, remaining: 0 });
    expect(await store(fx.tenantA).list()).toEqual([]);
    expect(await committedRows(fx.tenantA)).toBe(1);
    await expect(
      fx.runtime().transaction(async (tx) => {
        await tx.query({ text: "SELECT set_config('app.tenant_id', $1, true)", values: [fx.tenantA] });
        await tx.query({ text: "DELETE FROM webhook_events WHERE tenant_id = $1", values: [fx.tenantA] });
      }),
    ).rejects.toThrow();
  });

  it("tenant isolation: tenant B's store neither sees nor acknowledges tenant A's events", async () => {
    await store(fx.tenantA).enqueue({ resourceId: RESOURCE, eventDate: EVENT_DATE, payloadChecksum: checksum("a") });
    expect(await store(fx.tenantB).list()).toEqual([]);
    expect(await store(fx.tenantB).acknowledge(RESOURCE)).toEqual({ removed: 0, remaining: 0 });
    expect((await store(fx.tenantA).list()).map((e) => e.resourceId)).toEqual([RESOURCE]);
  });
});
