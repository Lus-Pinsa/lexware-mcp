import type { TenantId } from "./types.js";

export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface SqlSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlDatabase extends SqlSession {
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>;
}

/**
 * Sets the PostgreSQL RLS tenant context inside one transaction.
 * set_config(..., true) scopes the setting to the current transaction only.
 */
export async function withTenantTransaction<T>(
  db: SqlDatabase,
  tenantId: TenantId,
  work: (session: SqlSession) => Promise<T>,
): Promise<T> {
  return db.transaction(async (session) => {
    await session.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return work(session);
  });
}
