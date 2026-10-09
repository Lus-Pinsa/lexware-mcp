import { describe, expect, it } from "vitest";
import { requirePersistenceAvailable, type PersistenceState } from "../src/persistence/state.js";

describe("persistence availability semantics", () => {
  it("allows explicitly available persistence", () => {
    const state: PersistenceState = { status: "AVAILABLE", checkedAt: "2026-10-09T08:00:00.000Z" };
    expect(() => requirePersistenceAvailable(state)).not.toThrow();
  });

  it("never treats unavailable persistence as an empty data set", () => {
    const state: PersistenceState = {
      status: "UNAVAILABLE",
      checkedAt: "2026-10-09T08:00:00.000Z",
      reason: "DATABASE_UNREACHABLE",
    };
    expect(() => requirePersistenceAvailable(state)).toThrow(/DATABASE_UNREACHABLE/);
  });
});
