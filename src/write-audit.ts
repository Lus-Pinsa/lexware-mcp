import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import { LexwareApiError } from "./lexware/errors.js";

/**
 * Append-only audit trail for every state-changing tool call.
 *
 * Each call emits two JSON lines on stdout (`{"audit":"lexware-write",...}`): an `attempt` line BEFORE the
 * handler runs (so a crash mid-write still leaves a trace) and a result line (`ok` / `refused` / `error`)
 * afterwards with — for update-voucher — the booking-relevant fields before and after. Lines are
 * hash-chained (`prevHash` → `hash`) so a missing or edited line is detectable within one process lifetime;
 * a restart starts a new chain (`seq` 1, `prevHash` = "genesis").
 *
 * With an audit key (`LEXWARE_AUDIT_KEY`, or derived from the static MCP token) the chain and every
 * fingerprint are HMAC-SHA256: a log reader cannot recompute a consistent chain after editing a line, and a
 * fingerprint of a low-entropy value (a supplier name) cannot be reversed with a dictionary. Without a key
 * both fall back to plain SHA-256 and the server warns at start-up.
 *
 * The trail is PSEUDONYMISED, not free of business data: ids, dates and amounts are written in clear so a
 * change can be reconstructed; free text (contactName, remark, voucherNumber) only as fingerprint + length.
 * Upstream error text is never copied verbatim. Secrets are never part of an event.
 */

/** Booking-relevant snapshot of a voucher (no free text in clear). */
export type VoucherSnapshot = Record<string, unknown>;

export interface AuditDetail {
  before?: VoucherSnapshot;
  after?: VoucherSnapshot;
  changed?: string[];
}

export interface AuditEvent {
  audit: "lexware-write";
  seq: number;
  ts: string;
  tool: string;
  actor: string;
  target: string | null;
  outcome: "attempt" | "ok" | "error" | "refused";
  error?: string;
  durationMs: number;
  detail?: AuditDetail;
  prevHash: string;
  hash: string;
}

export interface AuditFingerprint {
  sha256: string;
  length: number;
}

type Sink = (line: string) => void;

interface AuditContext {
  detail?: AuditDetail;
  key: Buffer | null;
}

const store = new AsyncLocalStorage<AuditContext>();

function digest(key: Buffer | null, value: string): string {
  return key ? createHmac("sha256", key).update(value).digest("hex") : createHash("sha256").update(value).digest("hex");
}

/**
 * Fingerprint of a free-text value: never the text itself. Keyed (HMAC) when called inside an audited
 * handler of a log that has a key; the field name stays `sha256` for log readers.
 */
export function fingerprint(value: unknown, key: Buffer | null = store.getStore()?.key ?? null): AuditFingerprint | null {
  if (typeof value !== "string" || value === "") return null;
  return { sha256: digest(key, value).slice(0, 16), length: value.length };
}

/** Reduce a Lexware voucher to the fields that matter for a booking change. */
export function voucherSnapshot(v: Record<string, unknown>): VoucherSnapshot {
  const items = Array.isArray(v.voucherItems) ? v.voucherItems : [];
  return {
    version: v.version ?? null,
    type: v.type ?? null,
    voucherStatus: v.voucherStatus ?? null,
    voucherNumber: fingerprint(v.voucherNumber),
    voucherDate: v.voucherDate ?? null,
    taxType: v.taxType ?? null,
    totalGrossAmount: v.totalGrossAmount ?? null,
    totalTaxAmount: v.totalTaxAmount ?? null,
    contactId: v.contactId ?? null,
    useCollectiveContact: v.useCollectiveContact ?? null,
    contactName: fingerprint(v.contactName),
    remark: fingerprint(v.remark),
    files: Array.isArray(v.files) ? v.files.length : 0,
    voucherItems: items.map((i: Record<string, unknown>) => ({
      amount: i?.amount ?? null,
      taxAmount: i?.taxAmount ?? null,
      taxRatePercent: i?.taxRatePercent ?? null,
      categoryId: i?.categoryId ?? null,
    })),
  };
}

/** Top-level keys whose snapshot value differs. */
export function changedKeys(before: VoucherSnapshot, after: VoucherSnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => k !== "version" && JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

/** Called from inside a write handler to attach before/after to the event of the current call. */
export function recordAuditDetail(detail: AuditDetail): void {
  const ctx = store.getStore();
  if (ctx) ctx.detail = { ...ctx.detail, ...detail };
}

/**
 * Error summary for the trail: our own refusals carry their (business-data-free) message; Lexware errors
 * only status and kind; anything else only its class name plus a fingerprint of the message. Upstream
 * bodies can contain contact names and remarks and are therefore never copied.
 */
export function summarizeError(err: unknown, key: Buffer | null): string {
  if (err instanceof WriteRefusedError) return `${err.name}: ${err.message}`.slice(0, 300);
  if (err instanceof LexwareApiError) return `LexwareApiError status=${err.status} kind=${err.kind}`;
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name} msg#${digest(key, message).slice(0, 16)}`;
}

export interface WriteAuditLogOptions {
  sink?: Sink;
  now?: () => Date;
  /** HMAC key for chain and fingerprints (≥ 16 bytes). `null` = unkeyed SHA-256. */
  key?: Buffer | null;
}

export class WriteAuditLog {
  private seq = 0;
  private prevHash = "genesis";
  private readonly sink: Sink;
  private readonly now: () => Date;
  readonly key: Buffer | null;

  constructor(options: WriteAuditLogOptions = {}) {
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.key = options.key ?? null;
  }

  /** `hmac-sha256` when keyed, else `sha256` (reported by get-server-info). */
  get chainAlgorithm(): "hmac-sha256" | "sha256" {
    return this.key ? "hmac-sha256" : "sha256";
  }

  /**
   * Run a write handler inside an audit context: one `attempt` event before, one result event after.
   * The returned `event` is the result event.
   */
  async run<T>(
    meta: { tool: string; actor: string; target: string | null },
    handler: () => Promise<T>,
  ): Promise<{ result: T; event: AuditEvent }> {
    const ctx: AuditContext = { key: this.key };
    const started = this.now().getTime();
    this.emit(meta, "attempt", started);
    try {
      const result = await store.run(ctx, handler);
      return { result, event: this.emit(meta, "ok", started, ctx.detail) };
    } catch (err) {
      const outcome = err instanceof WriteRefusedError ? "refused" : "error";
      const event = this.emit(meta, outcome, started, ctx.detail, summarizeError(err, this.key));
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { auditSeq: event.seq });
    }
  }

  private emit(
    meta: { tool: string; actor: string; target: string | null },
    outcome: AuditEvent["outcome"],
    started: number,
    detail?: AuditDetail,
    error?: string,
  ): AuditEvent {
    const ts = this.now();
    const body = {
      audit: "lexware-write" as const,
      seq: ++this.seq,
      ts: ts.toISOString(),
      tool: meta.tool,
      actor: meta.actor,
      target: meta.target,
      outcome,
      ...(error ? { error } : {}),
      durationMs: Math.max(0, ts.getTime() - started),
      ...(detail ? { detail } : {}),
      prevHash: this.prevHash,
    };
    const hash = digest(this.key, JSON.stringify(body));
    this.prevHash = hash;
    const event: AuditEvent = { ...body, hash };
    // A failing sink must never turn a completed Lexware write into a tool error (a client would retry a
    // non-idempotent request). Report it on stderr and keep the chain consistent.
    try {
      this.sink(JSON.stringify(event));
    } catch (sinkError) {
      console.error(
        `[lexware-mcp] audit: sink failed for seq ${event.seq} (${sinkError instanceof Error ? sinkError.name : "error"})`,
      );
    }
    return event;
  }
}

/** A write the server refuses by policy (not a Lexware error). */
export class WriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteRefusedError";
  }
}
