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

const { openDurablePersistence, runPersistenceStartupGates } = await import("../src/persistence/startup-gates.js");

const db = { transaction: async <T>(work: (tx: never) => Promise<T>) => work({} as never) };
const config = {
  enabled: true,
  expectedRuntimeRole: "lus_runtime",
  tenantId: "t",
  tlsMode: "verify-full",
  secrets: { getDatabaseUrl: () => "postgres://synthetic", keyring: {} },
} as never;
const factories = () => ({
  createDatabase: vi.fn(() => {
    calls.push("connect");
    return db as never;
  }),
  createStore: vi.fn(() => {
    calls.push("store");
    return { mode: "postgres" } as never;
  }),
});
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

  it("openDurablePersistence connects, runs every gate, and only then builds the durable store", async () => {
    const f = factories();
    const opened = await openDurablePersistence(config, READ_ONLY, f);
    expect(calls).toEqual(["connect", ...ORDER, "store"]);
    expect(f.createStore).toHaveBeenCalledTimes(1);
    expect(opened.store).toEqual({ mode: "postgres" });
  });

  it.each(ORDER)("openDurablePersistence never builds a store when the %s gate fails", async (gate) => {
    fail.at = gate;
    const f = factories();
    await expect(openDurablePersistence(config, READ_ONLY, f)).rejects.toThrow(`gate failed: ${gate}`);
    expect(f.createStore).not.toHaveBeenCalled();
    expect(calls).not.toContain("store");
  });

  it("src/server.ts delegates the enabled-persistence start to openDurablePersistence and has no private copy", () => {
    // Static wiring check (server.ts runs the whole server on import). The behaviour itself is tested above.
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const branch = server.slice(server.indexOf("if (persistenceConfig.enabled) {"));
    const body = branch.slice(0, branch.indexOf("\n}\n") + 3);
    expect(body).toMatch(/^if \(persistenceConfig\.enabled\) \{\n(?:\s*\/\/.*\n)*\s*const durable = await openDurablePersistence\(/);
    expect(body).toContain("pendingVoucherStore = durable.store;");
    for (const direct of [
      "runPersistenceStartupGates",
      "createDurablePendingVoucherEventStore",
      "createPostgresDatabase",
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
