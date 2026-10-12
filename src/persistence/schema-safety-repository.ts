import { createHash } from "node:crypto";
import { loadKnownMigrations } from "./migration-runner.js";
import { PINNED_SESSION_SETTINGS } from "./postgres-driver.js";
import type { SqlExecutor } from "./repository.js";
import { PersistenceValidationError } from "./types.js";

/**
 * Structural safety of the persistence schema, checked at start-up and on both sides of a restore.
 *
 * The migration ledger proves which scripts ran, not that their effects are still in place. A table owner or a
 * mis-restored dump can drop the append guard, disable or replace row-level security, add a permissive policy or
 * drop a guard index while the ledger stays "current". Each of those silently removes a tenant or integrity
 * boundary, so every one fails closed here. Fixed codes only; no identifiers or database text in errors.
 */
const TENANT_TABLES = ["tenants", "webhook_events", "audit_events", "audit_retention_anchors"] as const;

/** PostgreSQL's deparsed form of the tenant isolation expression from migrations 001 and 003. */
export const TENANT_ISOLATION_EXPRESSION =
  "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

/**
 * SHA-256 of the append guard's function body exactly as migration 008 defines it. Derived from the checksummed
 * migration file, so a replaced body (e.g. "BEGIN RETURN NEW; END") is detected.
 */
function expectedGuardBodyHash(): string {
  const migration = loadKnownMigrations().find((m) => m.name === "audit_append_guard");
  const body = migration === undefined ? null : /AS \$\$([\s\S]*?)\$\$;/.exec(migration.sql)?.[1];
  if (body === undefined || body === null) {
    throw new PersistenceValidationError("Persistence append guard definition unavailable.");
  }
  return createHash("sha256").update(body, "utf8").digest("hex");
}

const SQL_SCHEMA_SAFETY =
  "WITH t AS (" +
  "SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relpersistence FROM pg_class c " +
  "JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = 'public' AND c.relkind = 'r' " +
  "AND c.relname IN ('tenants', 'webhook_events', 'audit_events', 'audit_retention_anchors')" +
  "), " +
  "audit AS (SELECT oid, relowner FROM t WHERE relname = 'audit_events'), " +
  "pol AS (SELECT p.*, t.relname FROM pg_policy p JOIN t ON t.oid = p.polrelid) " +
  "SELECT " +
  "(SELECT count(*)::int FROM t) AS tables_present, " +
  "(SELECT count(*)::int FROM t WHERE relrowsecurity AND relforcerowsecurity) AS tables_forced_rls, " +
  // Crash-safe (not UNLOGGED/TEMP) tables; no rewrite rules; no inheritance children or parents (a child table
  // would take rows without the guard); no trigger besides the guard (a later BEFORE trigger could modify NEW).
  "(SELECT count(*)::int FROM t WHERE relpersistence = 'p') AS tables_permanent, " +
  "(SELECT count(*)::int FROM pg_rewrite w JOIN t ON t.oid = w.ev_class) AS rules, " +
  "(SELECT count(*)::int FROM pg_inherits h WHERE h.inhparent IN (SELECT oid FROM t) OR h.inhrelid IN (SELECT oid FROM t)) AS inheritance, " +
  "(SELECT count(*)::int FROM pg_trigger g JOIN t ON t.oid = g.tgrelid WHERE NOT g.tgisinternal) AS user_triggers, " +
  "(SELECT count(*)::int FROM pol) AS policies_total, " +
  "(SELECT count(*)::int FROM pol WHERE polname = 'tenant_isolation_' || relname AND polpermissive AND polcmd = '*' " +
  " AND polroles = ARRAY[0]::oid[] AND pg_get_expr(polqual, polrelid) = $1 AND pg_get_expr(polwithcheck, polrelid) = $1) " +
  "AS policies_expected, " +
  // Enabled ALWAYS ('A'): fires in every session_replication_role mode. Function owned by the table owner,
  // not SECURITY DEFINER.
  // tgtype 7 = ROW | BEFORE | INSERT; no WHEN clause, arguments or column list; the function body and settings
  // exactly as migration 008 defines them.
  "EXISTS (SELECT 1 FROM pg_trigger g JOIN audit a ON a.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid " +
  " JOIN pg_language l ON l.oid = p.prolang " +
  " WHERE g.tgname = 'audit_events_append_guard' AND NOT g.tgisinternal AND g.tgenabled = 'A' " +
  " AND g.tgtype = 7 AND g.tgqual IS NULL AND g.tgnargs = 0 AND g.tgattr::text = '' " +
  " AND p.proname = 'audit_events_append_guard' AND p.pronamespace = 'public'::regnamespace " +
  " AND p.proowner = a.relowner AND NOT p.prosecdef AND l.lanname = 'plpgsql' " +
  " AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[] " +
  " AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = $2) AS append_guard, " +
  "EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN audit a ON a.oid = i.indrelid " +
  " WHERE c.relname = 'audit_events_tenant_chain_seq_uniq' AND i.indisunique AND i.indisvalid AND i.indisready " +
  " AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts = 2 " +
  " AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = a.oid AND attname = 'tenant_id') " +
  " AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = a.oid AND attname = 'chain_seq')) AS seq_index, " +
  "EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN audit a ON a.oid = i.indrelid " +
  " WHERE c.relname = 'audit_events_tenant_previous_hash_uniq' AND i.indisunique AND i.indisvalid AND i.indisready " +
  " AND i.indimmediate AND i.indnullsnotdistinct AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnatts = 2 " +
  " AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = a.oid AND attname = 'tenant_id') " +
  " AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = a.oid AND attname = 'previous_hash')) AS predecessor_index";

export interface SchemaSafetySnapshot {
  readonly tablesPresent: number;
  readonly tablesForcedRls: number;
  readonly tablesPermanent: number;
  readonly rules: number;
  readonly inheritance: number;
  readonly userTriggers: number;
  readonly policiesTotal: number;
  readonly policiesExpected: number;
  readonly appendGuard: boolean;
  readonly seqIndex: boolean;
  readonly predecessorIndex: boolean;
}

export async function inspectSchemaSafety(tx: SqlExecutor): Promise<SchemaSafetySnapshot> {
  const result = await tx.query<{
    tables_present: number;
    tables_forced_rls: number;
    tables_permanent: number;
    rules: number;
    inheritance: number;
    user_triggers: number;
    policies_total: number;
    policies_expected: number;
    append_guard: boolean;
    seq_index: boolean;
    predecessor_index: boolean;
  }>({ text: SQL_SCHEMA_SAFETY, values: [TENANT_ISOLATION_EXPRESSION, expectedGuardBodyHash()] });
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new PersistenceValidationError("Persistence schema safety could not be inspected.");
  }
  return Object.freeze({
    tablesPresent: row.tables_present,
    tablesForcedRls: row.tables_forced_rls,
    tablesPermanent: row.tables_permanent,
    rules: row.rules,
    inheritance: row.inheritance,
    userTriggers: row.user_triggers,
    policiesTotal: row.policies_total,
    policiesExpected: row.policies_expected,
    appendGuard: row.append_guard === true,
    seqIndex: row.seq_index === true,
    predecessorIndex: row.predecessor_index === true,
  });
}

export function assertSchemaSafety(snapshot: SchemaSafetySnapshot): void {
  const n = TENANT_TABLES.length;
  const violations: string[] = [];
  if (snapshot.tablesPresent !== n) violations.push("TABLE_MISSING");
  if (snapshot.tablesForcedRls !== n) violations.push("RLS_NOT_FORCED");
  if (snapshot.tablesPermanent !== n) violations.push("NOT_PERMANENT");
  if (snapshot.rules !== 0) violations.push("RULE");
  if (snapshot.inheritance !== 0) violations.push("INHERITANCE");
  if (snapshot.userTriggers !== 1) violations.push("EXTRA_TRIGGER");
  // Exactly one policy per table, each the expected one: an additional permissive policy would widen access.
  if (snapshot.policiesTotal !== n || snapshot.policiesExpected !== n) violations.push("RLS_POLICY");
  if (!snapshot.appendGuard) violations.push("APPEND_GUARD");
  if (!snapshot.seqIndex) violations.push("SEQ_INDEX");
  if (!snapshot.predecessorIndex) violations.push("PREDECESSOR_INDEX");
  if (violations.length > 0) {
    throw new PersistenceValidationError("Persistence schema safety verification failed: " + violations.join(",") + ".");
  }
}

export async function verifySchemaSafety(tx: SqlExecutor): Promise<void> {
  assertSchemaSafety(await inspectSchemaSafety(tx));
}

/**
 * The session settings the driver pins at connect time must actually be in effect (a connection pooler or proxy may
 * drop startup parameters). The driver parses text output, so a different DateStyle, bytea_output or TimeZone would
 * make it misread data silently.
 */
/**
 * Settings that cannot be pinned at connect time (superuser-only) but must hold: in replica mode ordinary triggers,
 * including foreign-key checks, do not fire.
 */
const ASSERTED_SESSION_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  session_replication_role: "origin",
});

export async function verifySessionSettings(tx: SqlExecutor): Promise<void> {
  const expected: Record<string, string> = { ...PINNED_SESSION_SETTINGS, ...ASSERTED_SESSION_SETTINGS };
  const names = Object.keys(expected);
  // One parameter per setting name (names are module constants; the driver does not serialize text[] parameters).
  const result = await tx.query<Record<string, string>>({
    text: "SELECT " + names.map((_, i) => `current_setting($${i + 1}) AS s${i}`).join(", "),
    values: names,
  });
  const row = result.rows[0];
  const mismatched = names.filter((name, i) => row?.["s" + i] !== expected[name]);
  if (result.rowCount !== 1 || mismatched.length > 0) {
    throw new PersistenceValidationError("Persistence session settings verification failed.");
  }
}
