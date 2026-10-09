import { describe, expect, it } from "vitest";
import { hmacActorHash, sha256Identifier } from "../src/persistence/hash.js";

describe("persistence hashes", () => {
  it("domain-separates non-secret identifiers", () => {
    const value = "same-external-id";
    const org = sha256Identifier("lexware-organization", value);
    const event = sha256Identifier("lexware-webhook-event", value);
    expect(org).toMatch(/^[a-f0-9]{64}$/);
    expect(event).toMatch(/^[a-f0-9]{64}$/);
    expect(org).not.toBe(event);
  });

  it("is deterministic within one hash domain", () => {
    expect(sha256Identifier("d", "v")).toBe(sha256Identifier("d", "v"));
  });

  it("rejects empty hash inputs", () => {
    expect(() => sha256Identifier("", "v")).toThrow();
    expect(() => sha256Identifier("d", " ")).toThrow();
  });

  it("pseudonymizes audit actors with a secret pepper", () => {
    const pepperA = Buffer.alloc(32, 1);
    const pepperB = Buffer.alloc(32, 2);
    const a1 = hmacActorHash("issuer|subject", pepperA);
    const a2 = hmacActorHash("issuer|subject", pepperA);
    const b = hmacActorHash("issuer|subject", pepperB);
    expect(a1).toMatch(/^[a-f0-9]{64}$/);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toContain("subject");
  });

  it("fails closed on a weak or missing actor pepper", () => {
    expect(() => hmacActorHash("principal", Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => hmacActorHash("", Buffer.alloc(32))).toThrow();
  });
});
