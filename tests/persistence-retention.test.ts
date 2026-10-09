import { describe, expect, it } from "vitest";
import {
  AUDIT_RETENTION_DAYS,
  WEBHOOK_RETENTION_DAYS,
  retentionCutoffs,
} from "../src/persistence/retention.js";

describe("persistence retention", () => {
  it("uses the owner-approved v1 retention windows", () => {
    expect(WEBHOOK_RETENTION_DAYS).toBe(30);
    expect(AUDIT_RETENTION_DAYS).toBe(365);
  });

  it("computes stable UTC cutoffs", () => {
    const cutoffs = retentionCutoffs(new Date("2026-10-09T08:00:00.000Z"));
    expect(cutoffs.webhookBefore).toBe("2026-09-09T08:00:00.000Z");
    expect(cutoffs.auditBefore).toBe("2025-10-09T08:00:00.000Z");
  });

  it("fails closed for an invalid clock", () => {
    expect(() => retentionCutoffs(new Date(Number.NaN))).toThrow(/Invalid/);
  });
});
