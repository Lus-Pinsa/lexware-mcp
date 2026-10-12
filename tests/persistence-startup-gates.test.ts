/**
 * C-07: the persistence start-up gates exist exactly once (src/persistence/startup-gates.ts) and src/server.ts runs that
 * function before any persistence store is created. The real-PostgreSQL suite exercises the same function end to end;
 * this suite pins the call order and the server wiring without a database, so removing a gate fails locally too.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const fail: { at: string | null } = { at: null };
const step = (name: string) => {
  calls.push(name);
  if (fail.at === name) throw new Error("gate failed: " + name);
};

vi.mock("../src/persistence/migration-runner.js", () => ({
  assertMigrationStateCurrent: () => step("migrations"),
}));
vi.mock("../src/persistence/schema-safety-repository.js", () => ({
  verifySessionSettings: async () => step("session"),
  verifySchemaSafety: async () => step("schema"),
}));
vi.mock("../src/persistence/runtime-privileges.js", () => ({
  assertLeastPrivilegeRuntimeRole: () => step("privileges"),
}));
vi.mock("../src/persistence/tenant-binding.js", () => ({
  verifyConfiguredTenantBinding: async () => step("binding"),
}));
vi.mock("../src/persistence/repository.js", () => ({
  listAppliedSchemaMigrations: async () => [],
  inspectRuntimePrivileges: async () => ({}),
}));

const { runPersistenceStartupGates } = await import("../src/persistence/startup-gates.js");

const db = { transaction: async <T>(work: (tx: never) => Promise<T>) => work({} as never) };
const config = { enabled: true, expectedRuntimeRole: "lus_runtime" } as never;
const READ_ONLY = { drafts: false, finalize: false };
const ORDER = ["migrations", "session", "schema", "privileges", "binding"];

describe("persistence start-up gates (C-07)", () => {
  beforeEach(() => {
    calls.length = 0;
    fail.at = null;
  });

  it("runs every gate, in order", async () => {
    await runPersistenceStartupGates(db as never, config, READ_ONLY);
    expect(calls).toEqual(ORDER);
  });

  it.each(ORDER)("stops the start when the %s gate fails and runs no later gate", async (gate) => {
    fail.at = gate;
    await expect(runPersistenceStartupGates(db as never, config, READ_ONLY)).rejects.toThrow(`gate failed: ${gate}`);
    expect(calls).toEqual(ORDER.slice(0, ORDER.indexOf(gate) + 1));
  });

  it("src/server.ts runs the shared gates before creating the durable store and has no private copy of them", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const gates = server.indexOf("await runPersistenceStartupGates(");
    const store = server.indexOf("createDurablePendingVoucherEventStore({");
    const enabled = server.indexOf("if (persistenceConfig.enabled)");
    expect(enabled).toBeGreaterThan(-1);
    expect(gates).toBeGreaterThan(enabled);
    expect(store).toBeGreaterThan(gates);
    for (const direct of [
      "assertMigrationStateCurrent",
      "verifySessionSettings",
      "verifySchemaSafety",
      "assertLeastPrivilegeRuntimeRole",
      "verifyConfiguredTenantBinding",
    ]) {
      expect(server, direct).not.toContain(direct);
    }
  });
});
