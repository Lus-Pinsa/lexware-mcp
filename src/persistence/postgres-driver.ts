import postgres from "postgres";
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

export interface PostgresDriverSettings {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly applicationName?: string;
}

export interface ManagedPersistenceDatabase extends PersistenceDatabase {
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

export function createPostgresDatabase(
  settings: PostgresDriverSettings,
  factory: DriverFactory = postgres as unknown as DriverFactory,
): ManagedPersistenceDatabase {
  const connectionString = normalizedConnectionString(settings.connectionString);
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

  const client = factory(connectionString, {
    ssl: "verify-full",
    max,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: true,
    fetch_types: false,
    onnotice: false,
    debug: false,
    connection: { application_name: applicationName },
  });

  return Object.freeze({
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      try {
        return await client.begin(async (tx) => work(createExecutor(tx)));
      } catch (error) {
        if (error instanceof PersistenceDatabaseError) throw error;
        throw new PersistenceDatabaseError("TRANSACTION_FAILED");
      }
    },

    async close(): Promise<void> {
      try {
        await client.end({ timeout: 5 });
      } catch {
        throw new PersistenceDatabaseError("CLOSE_FAILED");
      }
    },
  });
}
