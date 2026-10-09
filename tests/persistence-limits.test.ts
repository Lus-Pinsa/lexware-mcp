import { describe, expect, it } from "vitest";
import { PERSISTENCE_LIMITS, assertWithinPersistenceLimit } from "../src/persistence/limits.js";

describe("persistence limits", () => {
  it("defines explicit per-tenant/event bounds", () => {
    expect(PERSISTENCE_LIMITS.pendingWebhookEventsPerTenant).toBe(1_000);
    expect(PERSISTENCE_LIMITS.encryptedResourceIdBytes).toBe(4_096);
    expect(PERSISTENCE_LIMITS.auditEventsPerTenant).toBe(100_000);
  });

  it("rejects overflow visibly rather than silently dropping it", () => {
    expect(() => assertWithinPersistenceLimit("pendingWebhookEventsPerTenant", 1_000)).not.toThrow();
    expect(() => assertWithinPersistenceLimit("pendingWebhookEventsPerTenant", 1_001)).toThrow(/exceeded/);
  });

  it("rejects malformed counters", () => {
    expect(() => assertWithinPersistenceLimit("auditEventsPerTenant", -1)).toThrow(/Invalid/);
    expect(() => assertWithinPersistenceLimit("auditEventsPerTenant", 1.5)).toThrow(/Invalid/);
  });
});
