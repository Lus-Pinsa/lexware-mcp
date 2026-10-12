import postgres from "postgres";
import type {
  MigrationDatabase,
  StaticMigrationExecutor,
} from "./migration-types.js";
import type {
  PersistenceDatabase,
  QueryResult,
  SqlExecutor,
} from "./repository.js";
import { PersistenceValidationError } from "./types.js";

export type PersistenceDatabaseErrorKind =
  | "QUERY_FAILED"
  | "TRANSACTION_FAILED"
  | "CLOSE_FAILED";

export class PersistenceDatabaseError extends Error {
  readonly kind: PersistenceDatabaseErrorKind;

  constructor(kind: PersistenceDatabaseErrorKind) {
    super(
      kind === "QUERY_FAILED"
        ? "Persistence query failed."
        : kind === "TRANSACTION_FAILED"
          ? "Persistence transaction failed."
          : "Persistence database close failed.",
    );
    this.name = "PersistenceDatabaseError";
    this.kind = kind;
  }
}

export type PostgresTlsMode = "verify-full" | "require";

export interface PostgresDriverSettings {
  readonly connectionString: string;
  readonly tlsMode?: PostgresTlsMode;
  readonly maxConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly applicationName?: string;
}

export interface ManagedPersistenceDatabase extends PersistenceDatabase {
  close(): Promise<void>;
}

export interface ManagedMigrationDatabase extends MigrationDatabase {
  close(): Promise<void>;
}

interface DriverResult extends Array<Record<string, unknown>> {
  readonly count: number;
}

interface DriverTransaction {
  unsafe(
    statement: string,
    values?: readonly unknown[],
    options?: { readonly prepare?: boolean },
  ): Promise<DriverResult>;
}

interface DriverClient extends DriverTransaction {
  begin<T>(work: (tx: DriverTransaction) => Promise<T>): Promise<T>;
  end(options?: { readonly timeout?: number }): Promise<void>;
}

type DriverFactory = (
  connectionString: string,
  options: Readonly<Record<string, unknown>>,
) => DriverClient;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return resolved;
}

/** Session settings sent at connect time; they take precedence over role and database defaults. */
export const PINNED_SESSION_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  search_path: "public, pg_temp",
  TimeZone: "UTC",
  DateStyle: "ISO, MDY",
  IntervalStyle: "postgres",
  bytea_output: "hex",
  extra_float_digits: "1",
  default_transaction_isolation: "read committed",
  // A 204 to Lexware promises a durable commit; string literals and row-level security must behave as designed.
  synchronous_commit: "on",
  standard_conforming_strings: "on",
  row_security: "on",
});

function PINNED_SESSION_SETTINGS_WITH(applicationName: string): Record<string, string> {
  return { application_name: applicationName, ...PINNED_SESSION_SETTINGS };
}

function normalizedConnectionString(raw: string): string {
  if (raw.trim() !== raw || raw.length < 1 || raw.length > 4096) {
    throw new PersistenceValidationError("Invalid persistence database URL.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PersistenceValidationError("Invalid persistence database URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new PersistenceValidationError("Persistence database URL must use PostgreSQL.");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new PersistenceValidationError("Persistence database URL is incomplete.");
  }

  // Driver options below enforce certificate verification. Remove URL-level SSL
  // hints so a supplied query string can never weaken or conflict with that policy.
  for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }
  // Any other query parameter would be sent as a session setting AFTER the pinned ones below and override them
  // (search_path, TimeZone, DateStyle, isolation, options=-c …). Fail instead of silently accepting or dropping it.
  if ([...url.searchParams.keys()].length > 0) {
    throw new PersistenceValidationError("Persistence database URL contains unsupported parameters.");
  }
  return url.toString();
}

function createExecutor(tx: DriverTransaction): SqlExecutor {
  return Object.freeze({
    async query<Row = Record<string, unknown>>(statement: {
      readonly text: string;
      readonly values: readonly unknown[];
    }): Promise<QueryResult<Row>> {
      try {
        const result = await tx.unsafe(statement.text, statement.values, { prepare: true });
        return Object.freeze({
          rows: result as unknown as readonly Row[],
          rowCount: result.count,
        });
      } catch {
        throw new PersistenceDatabaseError("QUERY_FAILED");
      }
    },
  });
}

function createMigrationExecutor(tx: DriverTransaction): StaticMigrationExecutor {
  const queryExecutor = createExecutor(tx);
  return Object.freeze({
    query: queryExecutor.query,
    async executeStatic(script: string): Promise<void> {
      if (script.length < 1 || script.length > 1024 * 1024) {
        throw new PersistenceValidationError("Invalid static migration script size.");
      }
      try {
        await tx.unsafe(script, [], { prepare: false });
      } catch {
        throw new PersistenceDatabaseError("QUERY_FAILED");
      }
    },
  });
}

function createDriver(
  settings: PostgresDriverSettings,
  factory: DriverFactory,
): DriverClient {
  const connectionString = normalizedConnectionString(settings.connectionString);
  const tlsMode = settings.tlsMode ?? "verify-full";
  if (tlsMode !== "verify-full" && tlsMode !== "require") {
    throw new PersistenceValidationError("Invalid database TLS mode.");
  }
  const max = boundedInteger(settings.maxConnections, 4, 1, 16, "database maxConnections");
  const connectTimeout = boundedInteger(
    settings.connectTimeoutSeconds,
    10,
    1,
    60,
    "database connectTimeoutSeconds",
  );
  const idleTimeout = boundedInteger(
    settings.idleTimeoutSeconds,
    20,
    1,
    300,
    "database idleTimeoutSeconds",
  );
  const applicationName = settings.applicationName ?? "lus-persistence";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(applicationName)) {
    throw new PersistenceValidationError("Invalid database applicationName.");
  }

  return factory(connectionString, {
    ssl: tlsMode,
    max,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: true,
    fetch_types: false,
    onnotice: false,
    debug: false,
    // Session parameters sent at connect time take precedence over role/database defaults (ALTER ROLE … SET):
    // - search_path: unqualified table names resolve to public only; pg_temp is listed last so a temporary or
    //   role-owned table can never shadow a persistence table.
    // - TimeZone UTC: timestamptz is printed in a form the driver parses back to the same instant.
    // - read committed: appends serialize on the tenant advisory lock and must see the latest committed head.
    // - DateStyle, IntervalStyle, bytea_output, extra_float_digits: the driver parses text output; a role default
    //   such as DateStyle 'SQL, DMY' or bytea_output 'escape' would make it misread timestamps and ciphertext.
    connection: PINNED_SESSION_SETTINGS_WITH(applicationName),
  });
}

async function closeDriver(client: DriverClient): Promise<void> {
  try {
    await client.end({ timeout: 5 });
  } catch {
    throw new PersistenceDatabaseError("CLOSE_FAILED");
  }
}

export function createPostgresDatabase(
  settings: PostgresDriverSettings,
  factory: DriverFactory = postgres as unknown as DriverFactory,
): ManagedPersistenceDatabase {
  const client = createDriver(settings, factory);

  return Object.freeze({
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      try {
        return await client.begin(async (tx) => work(createExecutor(tx)));
      } catch (error) {
        // Validation errors carry fixed, secret-free messages (e.g. "Audit chain integrity check failed.").
        // Keep them, like the migration database does, so an integrity failure is never reported as a generic
        // database failure. Anything else stays opaque.
        if (error instanceof PersistenceDatabaseError || error instanceof PersistenceValidationError) throw error;
        throw new PersistenceDatabaseError("TRANSACTION_FAILED");
      }
    },

    async close(): Promise<void> {
      return closeDriver(client);
    },
  });
}

export function createPostgresMigrationDatabase(
  settings: PostgresDriverSettings,
  factory: DriverFactory = postgres as unknown as DriverFactory,
): ManagedMigrationDatabase {
  const client = createDriver(settings, factory);

  return Object.freeze({
    async transaction<T>(work: (tx: StaticMigrationExecutor) => Promise<T>): Promise<T> {
      try {
        return await client.begin(async (tx) => work(createMigrationExecutor(tx)));
      } catch (error) {
        if (error instanceof PersistenceDatabaseError || error instanceof PersistenceValidationError) {
          throw error;
        }
        throw new PersistenceDatabaseError("TRANSACTION_FAILED");
      }
    },

    async close(): Promise<void> {
      return closeDriver(client);
    },
  });
}
