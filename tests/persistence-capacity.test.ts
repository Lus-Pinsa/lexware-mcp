import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AUDIT_EVENTS,
  DEFAULT_MAX_PERSISTENCE_BYTES,
  DEFAULT_MAX_WEBHOOK_EVENTS,
  MAX_PERSISTED_SNAPSHOTS,
  assertTenantStorageWithinPolicy,
} from "../src/persistence/capacity.js";

describe("tenant persistence capacity policy", () => {
  it("defines explicit v1 ceilings and persists no snapshots", () => {
    expect(DEFAULT_MAX_WEBHOOK_EVENTS).toBe(10_000);
    expect(DEFAULT_MAX_AUDIT_EVENTS).toBe(100_000);
    expect(DEFAULT_MAX_PERSISTENCE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_PERSISTED_SNAPSHOTS).toBe(0);
  });

  it("accepts usage exactly at every ceiling", () => {
    expect(() =>
      assertTenantStorageWithinPolicy(
        {
          maxWebhookEvents: 10,
          maxAuditEvents: 20,
          maxPersistenceBytes: 30,
        },
        {
          webhookEvents: 10,
          auditEvents: 20,
          persistenceBytes: 30,
        },
      ),
    ).not.toThrow();
  });

  it("fails visibly on every exceeded dimension", () => {
    expect(() =>
      assertTenantStorageWithinPolicy(
        { maxWebhookEvents: 10, maxAuditEvents: 20, maxPersistenceBytes: 30 },
        { webhookEvents: 11, auditEvents: 0, persistenceBytes: 0 },
      ),
    ).toThrow(/webhook storage capacity/);

    expect(() =>
      assertTenantStorageWithinPolicy(
        { maxWebhookEvents: 10, maxAuditEvents: 20, maxPersistenceBytes: 30 },
        { webhookEvents: 0, auditEvents: 21, persistenceBytes: 0 },
      ),
    ).toThrow(/audit storage capacity/);

    expect(() =>
      assertTenantStorageWithinPolicy(
        { maxWebhookEvents: 10, maxAuditEvents: 20, maxPersistenceBytes: 30 },
        { webhookEvents: 0, auditEvents: 0, persistenceBytes: 31 },
      ),
    ).toThrow(/byte capacity/);
  });

  it("fails closed on malformed counters and policies", () => {
    expect(() =>
      assertTenantStorageWithinPolicy(
        { maxWebhookEvents: -1, maxAuditEvents: 1, maxPersistenceBytes: 1 },
        { webhookEvents: 0, auditEvents: 0, persistenceBytes: 0 },
      ),
    ).toThrow(/Invalid/);
    expect(() =>
      assertTenantStorageWithinPolicy(
        { maxWebhookEvents: 1, maxAuditEvents: 1, maxPersistenceBytes: 1 },
        { webhookEvents: 1.5, auditEvents: 0, persistenceBytes: 0 },
      ),
    ).toThrow(/Invalid/);
  });
});
