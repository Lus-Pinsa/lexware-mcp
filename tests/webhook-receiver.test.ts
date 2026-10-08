import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createLexwareWebhookHandler,
  verifyLexwareWebhookSignature,
  type WebhookQueueResult,
  type WebhookRequest,
} from "../src/webhook-receiver.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ORG = "00000000-0000-4000-8000-0000000000aa";
const FOREIGN = "00000000-0000-4000-8000-0000000000bb";
const RESOURCE = "00000000-0000-4000-8000-0000000000c1";
const EVENT_DATE = "2026-10-07T10:00:00.000+02:00";

function sign(raw: Buffer, key = privateKey, algorithm = "RSA-SHA512"): string {
  const s = createSign(algorithm);
  s.update(raw);
  s.end();
  return s.sign(key).toString("base64");
}

const payload = (patch: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ organizationId: ORG, eventType: "voucher.created", resourceId: RESOURCE, eventDate: EVENT_DATE, ...patch }));

function harness(opts: { organizationId?: string; publicKey?: string | undefined; queue?: Partial<WebhookQueueResult> } = {}) {
  const logs: string[] = [];
  const enqueue = vi.fn(async (_e: { resourceId: string; eventDate: string; payloadChecksum: string }) => ({
    added: true,
    count: 1,
    dropped: 0,
    ...opts.queue,
  }));
  const handler = createLexwareWebhookHandler({
    getPublicKey: () => ("publicKey" in opts ? opts.publicKey : PUBLIC_PEM),
    organizationId: "organizationId" in opts ? opts.organizationId : ORG,
    enqueue,
    droppedTotal: () => 7,
    log: (line) => logs.push(line),
  });
  const send = async (body: unknown, signature?: string): Promise<number> => {
    let status = 0;
    const req: WebhookRequest = { body, get: (name) => (name.toLowerCase() === "x-lxo-signature" ? signature : undefined) };
    await handler(req, { sendStatus: (s: number) => (status = s) });
    return status;
  };
  return { send, logs, enqueue };
}

describe("Lexware webhook receiver (complete request handling)", () => {
  it("accepts a signed event of the bound organization and queues it (204)", () => {
    const h = harness();
    const raw = payload();
    expect(await h.send(raw, sign(raw))).toBe(204);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith({
      resourceId: RESOURCE,
      eventDate: EVENT_DATE,
      payloadChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(h.logs).toEqual(["[lexware-webhook] NEW VOUCHER pending=1 added=true"]);
  });

  it("fails closed without a configured public key (503, nothing queued)", () => {
    const h = harness({ publicKey: undefined });
    const raw = payload();
    expect(await h.send(raw, sign(raw))).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a missing, wrong-key, wrong-algorithm, garbage or tampered signature (401, nothing queued)", () => {
    const h = harness();
    const raw = payload();
    expect(await h.send(raw, undefined)).toBe(401);
    expect(await h.send(raw, "")).toBe(401);
    expect(await h.send(raw, sign(raw, other.privateKey))).toBe(401);
    expect(await h.send(raw, sign(raw, privateKey, "RSA-SHA256"))).toBe(401);
    expect(await h.send(raw, "not-base64-%%%")).toBe(401);
    expect(await h.send(payload({ resourceId: "00000000-0000-4000-8000-0000000000c2" }), sign(raw))).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a body that is not the raw Buffer (400), before any parsing", () => {
    const h = harness();
    expect(await h.send({ organizationId: ORG }, "sig")).toBe(400);
    expect(await h.send("text", "sig")).toBe(400);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("rejects malformed signed bodies with 400 and a fixed reason code (input never logged)", () => {
    const h = harness();
    for (const raw of [Buffer.from("null"), Buffer.from("{bad"), payload({ resourceId: "x\n[lexware-webhook] NEW VOUCHER forged" })]) {
      expect(await h.send(raw, sign(raw))).toBe(400);
    }
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.logs).toEqual([
      "[lexware-webhook] rejected reason=invalid_shape",
      "[lexware-webhook] rejected reason=invalid_json",
      "[lexware-webhook] rejected reason=invalid_shape",
    ]);
  });

  it("passes the configured organization through: a foreign organization is acknowledged (204) but not queued or logged", () => {
    const h = harness();
    const raw = payload({ organizationId: FOREIGN });
    expect(await h.send(raw, sign(raw))).toBe(204);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.logs).toEqual(["[lexware-webhook] ignored reason=foreign_organization"]);
    expect(h.logs.join("\n")).not.toContain(FOREIGN);
  });

  it("queues any organization only when no binding is configured", () => {
    const h = harness({ organizationId: undefined });
    const raw = payload({ organizationId: FOREIGN });
    expect(await h.send(raw, sign(raw))).toBe(204);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("acknowledges unsupported event types without queueing (204)", () => {
    const h = harness();
    const raw = payload({ eventType: "contact.changed" });
    expect(await h.send(raw, sign(raw))).toBe(204);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.logs).toEqual(["[lexware-webhook] ignored reason=unsupported_event event=contact.changed"]);
  });

  it("never logs Lexware resource ids or event dates (FINANCIAL per data classification)", () => {
    const h = harness();
    for (const raw of [payload(), payload({ eventType: "contact.changed" }), payload({ organizationId: FOREIGN })]) {
      await h.send(raw, sign(raw));
    }
    const all = h.logs.join("\n");
    expect(all).not.toContain(RESOURCE);
    expect(all).not.toContain("2026-10-07");
    expect(all).not.toContain(ORG);
  });

  it("returns 503 and a fixed log line when the verified event cannot be durably queued", async () => {
    const logs: string[] = [];
    const enqueue = vi.fn(async () => {
      throw new Error("sensitive database detail");
    });
    const handler = createLexwareWebhookHandler({
      getPublicKey: () => PUBLIC_PEM,
      organizationId: ORG,
      enqueue,
      droppedTotal: () => 0,
      log: (line) => logs.push(line),
    });
    const raw = payload();
    let status = 0;
    await handler(
      { body: raw, get: (name) => (name.toLowerCase() === "x-lxo-signature" ? sign(raw) : undefined) },
      { sendStatus: (code) => (status = code) },
    );
    expect(status).toBe(503);
    expect(logs).toEqual(["[lexware-webhook] queue unavailable"]);
    expect(logs.join("\n")).not.toContain("sensitive database detail");
  });

  it("warns with counts when the bounded queue had to drop events", async () => {
    const h = harness({ queue: { dropped: 1, count: 1000 } });
    const raw = payload();
    expect(await h.send(raw, sign(raw))).toBe(204);
    expect(h.logs).toEqual([
      "[lexware-webhook] NEW VOUCHER pending=1000 added=true",
      "[lexware-webhook] WARNING queue full: dropped 1 oldest event(s), 7 since start — run reconcile-recent-vouchers",
    ]);
  });
});

describe("verifyLexwareWebhookSignature", () => {
  it("is true only for an RSA-SHA512 signature of the exact bytes with the matching key", () => {
    const raw = payload();
    expect(verifyLexwareWebhookSignature(raw, sign(raw), PUBLIC_PEM)).toBe(true);
    expect(verifyLexwareWebhookSignature(Buffer.concat([raw, Buffer.from(" ")]), sign(raw), PUBLIC_PEM)).toBe(false);
    expect(verifyLexwareWebhookSignature(raw, sign(raw), "not a pem")).toBe(false);
  });
});
