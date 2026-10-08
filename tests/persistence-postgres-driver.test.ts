import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDatabase,
  createPostgresMigrationDatabase,
  PersistenceDatabaseError,
} from "../src/persistence/postgres-driver.js";
import { parseTenantId } from "../src/persistence/types.js";
import { withTenantTransaction } from "../src/persistence/repository.js";

function fakeFactory() {
  const calls: Array<{ connectionString: string; options: Readonly<Record<string, unknown>> }> = [];
  const unsafe = vi.fn(async () => Object.assign([{ ok: 1 }], { count: 1 }));
  const begin = vi.fn(async (work: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => work({ unsafe }));
  const end = vi.fn(async () => {});
  const factory = (connectionString: string, options: Readonly<Record<string, unknown>>) => {
    calls.push({ connectionString, options });
    return { unsafe, begin, end };
  };
  return { calls, unsafe, begin, end, factory };
}

describe("Postgres persistence driver", () => {
  it("defaults to TLS verify-full and strips URL-level SSL overrides", async () => {
    const fake = fakeFactory();
    const db = createPostgresDatabase(
      {
        connectionString:
          "postgresql://db.internal.example.test/lus?sslmode=disable&ssl=true",
      },
      fake.factory as never,
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].connectionString).not.toContain("sslmode");
    expect(fake.calls[0].connectionString).not.toContain("ssl=true");
    expect(fake.calls[0].options).toMatchObject({
      ssl: "verify-full",
      max: 4,
      connect_timeout: 10,
      idle_timeout: 20,
      prepare: true,
      fetch_types: false,
      onnotice: false,
      debug: false,
      connection: { application_name: "lus-persistence" },
    });

    await db.close();
    expect(fake.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("supports explicit TLS require without permitting plaintext fallback", async () => {
    const fake = fakeFactory();
    const db = createPostgresDatabase(
      {
        connectionString: "postgresql://db.internal.example.test/lus?sslmode=disable",
        tlsMode: "require",
      },
      fake.factory as never,
    );
    expect(fake.calls[0].connectionString).not.toContain("sslmode");
    expect(fake.calls[0].options.ssl).toBe("require");
    await db.close();
  });

  it("rejects an unknown TLS mode", () => {
    const fake = fakeFactory();
    expect(() =>
      createPostgresDatabase(
        {
          connectionString: "postgresql://db.example.test/lus",
          tlsMode: "disable" as never,
        },
        fake.factory as never,
      ),
    ).toThrow(/TLS mode/);
  });

  it("pins repository work to the transaction client and parameterizes values", async () => {
    const fake = fakeFactory();
    const db = createPostgresDatabase(
      { connectionString: "postgres://db.internal.example.test/lus" },
      fake.factory as never,
    );
    const tenant = parseTenantId("00000000-0000-4000-8000-0000000000aa");

    const result = await withTenantTransaction(tenant, db, async (tx) =>
      tx.query({ text: "SELECT $1::text AS value", values: ["synthetic"] }),
    );

    expect(fake.begin).toHaveBeenCalledTimes(1);
    expect(fake.unsafe).toHaveBeenCalledTimes(2);
    expect(fake.unsafe.mock.calls[0]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true) AS tenant_id",
      [tenant],
      { prepare: true },
    ]);
    expect(fake.unsafe.mock.calls[1]).toEqual([
      "SELECT $1::text AS value",
      ["synthetic"],
      { prepare: true },
    ]);
    expect(result.rowCount).toBe(1);
  });

  it("allows static multi-statement SQL only through the migration adapter with prepare=false", async () => {
    const fake = fakeFactory();
    const db = createPostgresMigrationDatabase(
      { connectionString: "postgres://db.internal.example.test/lus" },
      fake.factory as never,
    );

    await db.transaction(async (tx) => {
      await tx.executeStatic("CREATE TABLE synthetic_one (id bigint); CREATE TABLE synthetic_two (id bigint);");
      await tx.query({ text: "SELECT $1::int AS value", values: [1] });
    });

    expect(fake.unsafe.mock.calls[0]).toEqual([
      "CREATE TABLE synthetic_one (id bigint); CREATE TABLE synthetic_two (id bigint);",
      [],
      { prepare: false },
    ]);
    expect(fake.unsafe.mock.calls[1]).toEqual([
      "SELECT $1::int AS value",
      [1],
      { prepare: true },
    ]);
  });

  it("fails closed on malformed URLs and unsafe configuration bounds", () => {
    const fake = fakeFactory();
    for (const connectionString of [
      "",
      "https://db.example.test/lus",
      "postgres:///",
      "postgres://db.example.test/",
    ]) {
      expect(() => createPostgresDatabase({ connectionString }, fake.factory as never)).toThrow(
        /database URL|PostgreSQL/,
      );
    }
    expect(() =>
      createPostgresDatabase(
        { connectionString: "postgres://db.example.test/lus", maxConnections: 0 },
        fake.factory as never,
      ),
    ).toThrow(/maxConnections/);
  });

  it("never exposes driver query errors or connection-string secrets", async () => {
    const secret = "super-secret-password";
    const unsafe = vi.fn(async () => {
      throw new Error("driver leaked " + secret + " SELECT * FROM private");
    });
    const factory = () => ({
      unsafe,
      begin: async (work: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) => work({ unsafe }),
      end: async () => {},
    });
    const db = createPostgresDatabase(
      { connectionString: "postgres://user:" + secret + "@db.example.test/lus" },
      factory as never,
    );

    const error = await db
      .transaction((tx) => tx.query({ text: "SELECT $1", values: [secret] }))
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(PersistenceDatabaseError);
    expect((error as PersistenceDatabaseError).kind).toBe("QUERY_FAILED");
    expect(String((error as Error).message)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("wraps transaction and close failures into fixed error classes", async () => {
    const transactionFactory = () => ({
      unsafe: vi.fn(),
      begin: async () => {
        throw new Error("raw transaction detail");
      },
      end: async () => {
        throw new Error("raw close detail");
      },
    });
    const db = createPostgresDatabase(
      { connectionString: "postgres://db.example.test/lus" },
      transactionFactory as never,
    );

    await expect(db.transaction(async () => "x")).rejects.toMatchObject({
      kind: "TRANSACTION_FAILED",
      message: "Persistence transaction failed.",
    });
    await expect(db.close()).rejects.toMatchObject({
      kind: "CLOSE_FAILED",
      message: "Persistence database close failed.",
    });
  });
});
