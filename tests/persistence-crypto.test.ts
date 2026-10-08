import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "../src/persistence/crypto.js";

describe("persistence crypto", () => {
  it("round-trips AES-256-GCM and binds ciphertext to AAD", () => {
    const key = { id: "k1", key: Buffer.alloc(32, 7) };
    const encrypted = encryptString("resource-123", key, "tenant-a:event-1");
    const keys = new Map([[key.id, key.key]]);
    expect(decryptString(encrypted, keys, "tenant-a:event-1")).toBe("resource-123");
    expect(() => decryptString(encrypted, keys, "tenant-b:event-1")).toThrow();
  });

  it("uses a fresh nonce for every encryption", () => {
    const key = { id: "k1", key: Buffer.alloc(32, 8) };
    const a = encryptString("same", key, "aad");
    const b = encryptString("same", key, "aad");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails closed for missing or malformed keys", () => {
    const key = { id: "k1", key: Buffer.alloc(32, 9) };
    const encrypted = encryptString("x", key, "aad");
    expect(() => decryptString(encrypted, new Map(), "aad")).toThrow(/unavailable/);
    expect(() => encryptString("x", { id: "bad id", key: Buffer.alloc(32) }, "aad")).toThrow();
    expect(() => encryptString("x", { id: "k", key: Buffer.alloc(31) }, "aad")).toThrow();
  });
});
