import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Append-only audit trail for every state-changing tool call.
 *
 * Each call emits exactly one JSON line on stdout (`{"audit":"lexware-write",...}`): who (auth mode +
 * actor), when, which tool and target, the outcome and — for update-voucher — the booking-relevant fields
 * before and after. Lines are hash-chained (`prevHash` → `hash`) so a missing or edited line is detectable
 * within one process lifetime; a restart starts a new chain (`seq` 1, `prevHash` = "genesis").
 *
 * Free text that may carry personal data (contactName, remark) is never written in clear — only a short
 * SHA-256 fingerprint and its length. Secrets are never part of an event.
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
  outcome: "ok" | "error" | "refused";
  error?: string;
  durationMs: number;
  detail?: AuditDetail;
  prevHash: string;
  hash: string;
}

type Sink = (line: string) => void;

const store = new AsyncLocalStorage<{ detail?: AuditDetail }>();

/** Fingerprint of a free-text value: never the text itself. */
export function fingerprint(value: unknown): { sha256: string; length: number } | null {
  if (typeof value !== "string" || value === "") return null;
  return { sha256: createHash("sha256").update(value).digest("hex").slice(0, 16), length: value.length };
}

/** Reduce a Lexware voucher to the fields that matter for a booking change. */
export function voucherSnapshot(v: Record<string, unknown>): VoucherSnapshot {
  const items = Array.isArray(v.voucherItems) ? v.voucherItems : [];
  return {
    version: v.version ?? null,
    type: v.type ?? null,
    voucherStatus: v.voucherStatus ?? null,
    voucherNumber: v.voucherNumber ?? null,
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

export class WriteAuditLog {
  private seq = 0;
  private prevHash = "genesis";

  constructor(
    private readonly sink: Sink = (line) => process.stdout.write(`${line}\n`),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Run a write handler inside an audit context and emit one chained event for it. */
  async run<T>(
    meta: { tool: string; actor: string; target: string | null },
    handler: () => Promise<T>,
  ): Promise<{ result: T; event: AuditEvent }> {
    const ctx: { detail?: AuditDetail } = {};
    const started = this.now().getTime();
    try {
      const result = await store.run(ctx, handler);
      return { result, event: this.emit(meta, "ok", started, ctx.detail) };
    } catch (err) {
      const outcome = err instanceof WriteRefusedError ? "refused" : "error";
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const event = this.emit(meta, outcome, started, ctx.detail, message.slice(0, 500));
      throw Object.assign(err instanceof Error ? err : new Error(message), { auditSeq: event.seq });
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
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    this.prevHash = hash;
    const event: AuditEvent = { ...body, hash };
    this.sink(JSON.stringify(event));
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
