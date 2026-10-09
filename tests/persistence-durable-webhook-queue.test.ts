import { describe, expect, it, vi } from "vitest";

import { decryptString } from "../src/persistence/crypto.js";
import {
  enqueueVerifiedVoucherEvent,
  webhookResourceAad,
} from "../src/persistence/durable-webhook-queue.js";
import type { PersistenceRepository } from "../src/persistence/repository.js";
import { asTenantId, type PersistedWebhookEvent } from "../src/persistence/types.js";

const tenantId = asTenantId("550e8400-e29b-41d4-a716-446655440000");
const key = { id: "v1", key: Buffer.alloc(32, 11) };

function repositoryHarness(result: "inserted" | "duplicate" = "inserted") {
  let captured: Omit<PersistedWebhookEvent, "tenantId"> | null = null;
  const repository: PersistenceRepository = {
    insertWebhookEvent: vi.fn(async (_tenantId, event) => {
      captured = event;
      return result;
    }),
    acknowledgeWebhookEvent: vi.fn(async () => false),
    listPendingWebhookEvents: vi.fn(async () => []),
    appendAuditEvent: vi.fn(async () => undefined),
  };
  return { repository, captured: () => captured };
}

const input = () => ({
  organizationId: "00000000-0000-4000-8000-0000000000aa",
  resourceId: "00000000-0000-4000-8000-0000000000c1",
  eventDate: "2026-10-09T10:15:00.000+02:00",
  rawBody: Buffer.from('{"verified":true}'),
});

describe("durable verified webhook queue", () => {
  it("persists only hashed/encrypted identifiers", async () => {
    const h = repositoryHarness();
    await expect(
      enqueueVerifiedVoucherEvent(input(), {
        tenantId,
        encryptionKey: key,
        repository: h.repository,
        now: () => new Date("2026-10-09T08:16:00.000Z"),
      }),
    ).resolves.toBe("inserted");

    const event = h.captured();
    expect(event).not.toBeNull();
    if (!event) throw new Error("expected persisted event");

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(input().organizationId);
    expect(serialized).not.toContain(input().resourceId);
    expect(serialized).not.toContain(input().eventDate);
    expect(event.organizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.eventKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(event.receivedAt).toBe("2026-10-09T08:16:00.000Z");
    expect(event.quality).toBe("STRUCTURED");
    expect(event.source).toBe("lexware-webhook");

    const plaintext = decryptString(
      {
        keyId: event.resourceIdKeyId,
        nonce: event.resourceIdNonce,
        ciphertext: event.resourceIdCiphertext,
        authTag: event.resourceIdAuthTag,
      },
      new Map([[key.id, key.key]]),
      webhookResourceAad(tenantId, event.eventKeyHash),
    );
    expect(plaintext).toBe(input().resourceId);
  });

  it("builds a deterministic dedupe key for the same logical event", async () => {
    const first = repositoryHarness();
    const second = repositoryHarness("duplicate");

    await enqueueVerifiedVoucherEvent(input(), {
      tenantId,
      encryptionKey: key,
      repository: first.repository,
    });
    await expect(
      enqueueVerifiedVoucherEvent(input(), {
        tenantId,
        encryptionKey: key,
        repository: second.repository,
      }),
    ).resolves.toBe("duplicate");

    expect(first.captured()?.eventKeyHash).toBe(second.captured()?.eventKeyHash);
  });

  it("changes the event key when resource or event date changes", async () => {
    const a = repositoryHarness();
    const b = repositoryHarness();
    await enqueueVerifiedVoucherEvent(input(), {
      tenantId,
      encryptionKey: key,
      repository: a.repository,
    });
    await enqueueVerifiedVoucherEvent(
      { ...input(), eventDate: "2026-10-09T10:16:00.000+02:00" },
      { tenantId, encryptionKey: key, repository: b.repository },
    );
    expect(a.captured()?.eventKeyHash).not.toBe(b.captured()?.eventKeyHash);
  });

  it("binds payload checksum to the exact verified raw bytes", async () => {
    const a = repositoryHarness();
    const b = repositoryHarness();
    await enqueueVerifiedVoucherEvent(input(), {
      tenantId,
      encryptionKey: key,
      repository: a.repository,
    });
    await enqueueVerifiedVoucherEvent(
      { ...input(), rawBody: Buffer.from('{"verified":true }') },
      { tenantId, encryptionKey: key, repository: b.repository },
    );
    expect(a.captured()?.payloadSha256).not.toBe(b.captured()?.payloadSha256);
  });
});
