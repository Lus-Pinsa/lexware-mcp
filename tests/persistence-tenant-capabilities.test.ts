import { describe, expect, it } from "vitest";
import {
  assertTenantCapabilityBoundary,
  assertTenantCapabilityTier,
} from "../src/persistence/tenant-capabilities.js";

describe("per-tenant capability boundary", () => {
  it("defaults conceptually to the strict read-only tier", () => {
    expect(assertTenantCapabilityTier("read_only")).toBe("read_only");
    expect(() =>
      assertTenantCapabilityBoundary("read_only", {
        drafts: false,
        finalize: false,
      }),
    ).not.toThrow();
  });

  it("never allows runtime drafts to exceed a read-only tenant", () => {
    expect(() =>
      assertTenantCapabilityBoundary("read_only", {
        drafts: true,
        finalize: false,
      }),
    ).toThrow(/exceeds tenant policy/);
  });

  it("allows drafts for a drafts tenant but never finalize", () => {
    expect(() =>
      assertTenantCapabilityBoundary("drafts", {
        drafts: true,
        finalize: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertTenantCapabilityBoundary("drafts", {
        drafts: true,
        finalize: true,
      }),
    ).toThrow(/finalize capability exceeds/);
  });

  it("allows a finalize tenant to run at any lower effective tier", () => {
    for (const effective of [
      { drafts: false, finalize: false },
      { drafts: true, finalize: false },
      { drafts: true, finalize: true },
    ]) {
      expect(() =>
        assertTenantCapabilityBoundary("finalize", effective),
      ).not.toThrow();
    }
  });

  it("fails closed on unknown policy and impossible runtime combinations", () => {
    expect(() => assertTenantCapabilityTier("admin")).toThrow(/Invalid/);
    expect(() =>
      assertTenantCapabilityBoundary("finalize", {
        drafts: false,
        finalize: true,
      }),
    ).toThrow(/Invalid runtime/);
  });

  it("evaluates each tenant policy independently", () => {
    const tenantA = () =>
      assertTenantCapabilityBoundary("read_only", {
        drafts: true,
        finalize: false,
      });
    const tenantB = () =>
      assertTenantCapabilityBoundary("drafts", {
        drafts: true,
        finalize: false,
      });

    expect(tenantA).toThrow();
    expect(tenantB).not.toThrow();
    expect(tenantA).toThrow();
  });
});
