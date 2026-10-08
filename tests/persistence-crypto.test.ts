import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEncryptionKeyring,
  decryptField,
  encryptField,
  hashAuditActor,
  sha256Hex,
} from "../src/persistence/crypto.js";
import { parseTenantId } from "../src/persistence/types.js";

const TENANT_A = parseTenantId("00000000-0000-4000-8000-0000000000aa");
const TENANT_B = parseTenantId("00000000-0000-4000-8000-0000000000bb");

const context = (tenantId = TENANT_A) => ({
  tenantId,
  table: "webhook_events",
  field: "resource_id",
  recordId: sha256Hex("event-1"),
});

describe("persistence crypto", () => {
  it("round-trips AES-256-GCM and stores no plaintext in the envelope", () => {
    const ring = createEncryptionKeyring({ k1: randomBytes(32) }, "k1");
    const plaintext = "TEST-RESOURCE-123";
    const encrypted = encryptField(ring, plaintext, context());

    expect(encrypted.keyId).toBe("k1");
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain(plaintext);
    expect(decryptField(ring, encrypted, context())).toBe(plaintext);
  });

  it("uses a fresh nonce for every encryption", () => {
    const ring = createEncryptionKeyring({ k1: randomBytes(32) }, "k1");
    const a = encryptField(ring, "same", context());
    const b = encryptField(ring, "same", context());
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("binds ciphertext to tenant/table/field/record through AAD", () => {
    const ring = createEncryptionKeyring({ k1: randomBytes(32) }, "k1");
    const encrypted = encryptField(ring, "secret", context(TENANT_A));
    expect(() => decryptField(ring, encrypted, context(TENANT_B))).toThrow();
    expect(() =>
      decryptField(ring, encrypted, { ...context(TENANT_A), recordId: sha256Hex("different") }),
    ).toThrow();
  });

  it("supports key rotation: old key stays readable while new writes use the current key", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldRing = createEncryptionKeyring({ old: oldKey }, "old");
    const oldCiphertext = encryptField(oldRing, "before-rotation", context());

    const rotated = createEncryptionKeyring({ old: oldKey, current: newKey }, "current");
    expect(decryptField(rotated, oldCiphertext, context())).toBe("before-rotation");
    expect(encryptField(rotated, "after-rotation", context()).keyId).toBe("current");
  });

  it("fails closed for malformed keyrings and missing decryption keys", () => {
    expect(() => createEncryptionKeyring({ bad: randomBytes(31) }, "bad")).toThrow(/32 bytes/);
    expect(() => createEncryptionKeyring({ k1: randomBytes(32) }, "missing")).toThrow(/not present/);

    const ring = createEncryptionKeyring({ k1: randomBytes(32) }, "k1");
    const encrypted = encryptField(ring, "x", context());
    const other = createEncryptionKeyring({ k2: randomBytes(32) }, "k2");
    expect(() => decryptField(other, encrypted, context())).toThrow(/unavailable/);
  });

  it("hashes audit actors with a secret salt and never returns the actor text", () => {
    const actor = "synthetic-principal@example.test";
    const a = hashAuditActor(actor, Buffer.alloc(32, 1));
    const b = hashAuditActor(actor, Buffer.alloc(32, 2));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(actor);
    expect(a).not.toBe(b);
  });
});
