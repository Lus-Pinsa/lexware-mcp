import type { QueryResult, SqlExecutor } from "./repository.js";

export interface StaticMigrationExecutor extends SqlExecutor {
  executeStatic(script: string): Promise<void>;
}

export interface MigrationDatabase {
  transaction<T>(work: (tx: StaticMigrationExecutor) => Promise<T>): Promise<T>;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export type MigrationQueryResult<Row> = QueryResult<Row>;
