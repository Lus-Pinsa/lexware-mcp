import { describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  assertSafeMigrationSql,
  inspectMigrationState,
  loadKnownMigrations,
} from "../src/persistence/migration-runner.js";
import type {
  MigrationDatabase,
  MigrationRecord,
  StaticMigrationExecutor,
} from "../src/persistence/migration-types.js";
import type { QueryResult } from "../src/persistence/repository.js";

interface FakeState {
  applied: MigrationRecord[];
  staticScripts: string[];
  inserts: Array<{ version: number; name: string; checksum: string }>;
}

function migrationDb(
  initial: readonly MigrationRecord[] = [],
  options: { failFoundation?: boolean } = {},
): { db: MigrationDatabase; state: FakeState; transaction: ReturnType<typeof vi.fn> } {
  const state: FakeState = {
    applied: initial.map((row) => ({ ...row })),
    staticScripts: [],
    inserts: [],
  };

  const transaction = vi.fn(async <T>(work: (tx: StaticMigrationExecutor) => Promise<T>): Promise<T> => {
    const snapshot = {
      applied: state.applied.map((row) => ({ ...row })),
      staticScripts: [...state.staticScripts],
      inserts: state.inserts.map((row) => ({ ...row })),
    };

    const tx: StaticMigrationExecutor = {
      async query<Row = Record<string, unknown>>(statement: {
        readonly text: string;
        readonly values: readonly unknown[];
      }): Promise<QueryResult<Row>> {
        if (statement.text.startsWith("SELECT version::int")) {
          return {
            rows: state.applied.map((row) => ({ ...row })) as unknown as readonly Row[],
            rowCount: state.applied.length,
          };
        }

        if (statement.text.startsWith("INSERT INTO schema_migrations")) {
          const [version, name, checksum] = statement.values as readonly [number, string, string];
          if (state.applied.some((row) => row.version === version)) {
            throw new Error("duplicate migration version");
          }
          const record = { version, name, checksum };
          state.applied.push(record);
          state.inserts.push(record);
          return { rows: [] as readonly Row[], rowCount: 1 };
        }

        throw new Error("unexpected query");
      },

      async executeStatic(script: string): Promise<void> {
        state.staticScripts.push(script);
        if (options.failFoundation && script.includes("CREATE TABLE IF NOT EXISTS tenants")) {
          throw new Error("synthetic migration failure");
        }
      },
    };

    try {
      return await work(tx);
    } catch (error) {
      state.applied = snapshot.applied;
      state.staticScripts = snapshot.staticScripts;
      state.inserts = snapshot.inserts;
      throw error;
    }
  });

  return { db: { transaction } as MigrationDatabase, state, transaction };
}

describe("persistence migration runner", () => {
  it("loads the checked-in migration with a deterministic SHA-256 checksum", () => {
    const known = loadKnownMigrations();
    expect(known).toHaveLength(1);
    expect(known[0].version).toBe(1);
    expect(known[0].name).toBe("foundation");
    expect(known[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(known[0].sql).toContain("CREATE TABLE IF NOT EXISTS tenants");
  });

  it("rejects destructive SQL before it can reach a database", () => {
    for (const sql of [
      "DROP TABLE tenants;",
      "TRUNCATE audit_events;",
      "ALTER TABLE webhook_events DROP COLUMN event_type;",
    ]) {
      expect(() => assertSafeMigrationSql(sql)).toThrow(/Destructive migration/);
    }
    expect(assertSafeMigrationSql("CREATE TABLE safe_table (id bigint);")).toContain("safe_table");
  });

  it("reports a fresh database as having exactly migration 1 pending", async () => {
    const { db, state } = migrationDb();
    const result = await inspectMigrationState(db);
    expect(result.applied).toEqual([]);
    expect(result.pending.map((item) => item.version)).toEqual([1]);
    expect(state.staticScripts[0]).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
  });

  it("serializes and applies pending migrations atomically with ledger recording", async () => {
    const { db, state } = migrationDb();
    const result = await applyPendingMigrations(db);

    expect(result.appliedVersions).toEqual([1]);
    expect(state.applied).toHaveLength(1);
    expect(state.applied[0]).toMatchObject({ version: 1, name: "foundation" });
    expect(state.applied[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(state.staticScripts.some((script) => script === "LOCK TABLE schema_migrations IN EXCLUSIVE MODE")).toBe(true);
    expect(state.staticScripts.some((script) => script.includes("CREATE TABLE IF NOT EXISTS tenants"))).toBe(true);
    expect(state.inserts).toHaveLength(1);

    const after = await inspectMigrationState(db);
    expect(after.pending).toEqual([]);
    expect(after.applied).toHaveLength(1);
  });

  it("does not reapply an already recorded migration with the correct checksum", async () => {
    const known = loadKnownMigrations();
    const { db, state } = migrationDb([
      { version: 1, name: "foundation", checksum: known[0].checksum },
    ]);
    const result = await applyPendingMigrations(db);
    expect(result.appliedVersions).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("fails closed on checksum drift, name drift, gaps and unknown newer versions", async () => {
    const known = loadKnownMigrations();

    await expect(
      inspectMigrationState(
        migrationDb([{ version: 1, name: "foundation", checksum: "a".repeat(64) }]).db,
      ),
    ).rejects.toThrow(/checksum mismatch/);

    await expect(
      inspectMigrationState(
        migrationDb([{ version: 1, name: "changed", checksum: known[0].checksum }]).db,
      ),
    ).rejects.toThrow(/name mismatch/);

    await expect(
      inspectMigrationState(
        migrationDb([{ version: 2, name: "future", checksum: "b".repeat(64) }]).db,
      ),
    ).rejects.toThrow(/gap|unexpected version/);

    await expect(
      inspectMigrationState(
        migrationDb([
          { version: 1, name: "foundation", checksum: known[0].checksum },
          { version: 2, name: "future", checksum: "b".repeat(64) },
        ]).db,
      ),
    ).rejects.toThrow(/newer or unknown/);
  });

  it("rolls back the migration ledger when the migration script fails", async () => {
    const { db, state } = migrationDb([], { failFoundation: true });
    await expect(applyPendingMigrations(db)).rejects.toThrow(/synthetic migration failure/);
    expect(state.applied).toEqual([]);
    expect(state.inserts).toEqual([]);
    expect(state.staticScripts).toHaveLength(1);
    expect(state.staticScripts[0]).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
  });
});
