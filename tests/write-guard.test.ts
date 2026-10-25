/**
 * Write guard, audit trail and failed-auth throttling.
 *
 * LEXWARE_WRITE_TOOLS narrows the write surface below the tiers, LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY keeps
 * booked vouchers out of reach, every write-tool call leaves an `attempt` and a result line in the
 * HMAC-chained audit trail, and failed-auth throttling can never lock out a request that carries the valid
 * token.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { FailedAuthLimiter, bearerAuthMiddleware, clientKey, normalizeAddress } from "../src/auth.js";
import { type Config, loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import { registerTools } from "../src/tools/index.js";
import { KNOWN_WRITE_TOOLS } from "../src/write-tools.js";
import { type AuditEvent, WriteAuditLog, WriteRefusedError, summarizeError } from "../src/write-audit.js";

type Handler = (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; structuredContent?: unknown }>;
interface Registered {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  handler: Handler;
}

const TOKEN = "a".repeat(40);
const PRODUCTION = { LEXWARE_ENABLE_DRAFTS: "true", LEXWARE_ENABLE_FINALIZE: "false", LEXWARE_READ_ONLY: "false" };
const cfg = (extra: Record<string, string>): Config =>
  loadConfig({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: TOKEN, ...PRODUCTION, ...extra } as NodeJS.ProcessEnv);

function capture(config: Config, client: Partial<LexwareClient> = {}, sink?: (line: string) => void) {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(c: Omit<Registered, "handler">, handler: Handler) {
      tools.set(c.name, { ...c, handler });
      return server;
    },
  } as unknown as McpServer;
  const lines: string[] = [];
  const audit = new WriteAuditLog({ sink: sink ?? ((l) => lines.push(l)), key: config.auditKey });
  const { skippedWriteTools } = registerTools(
    server,
    client as LexwareClient,
    config,
    { env: {}, startedAt: new Date(0) },
    audit,
  );
  const events = () => lines.map((l) => JSON.parse(l) as AuditEvent);
  return { tools, skippedWriteTools, events, lines, audit };
}

const writes = (tools: Map<string, Registered>) =>
  [...tools.values()].filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);

describe("LEXWARE_WRITE_TOOLS", () => {
  it("registers only the listed write tools and keeps every read tool", () => {
    const all = capture(cfg({}));
    const narrowed = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher" }));
    expect(writes(narrowed.tools)).toEqual(["update-voucher"]);
    const reads = (t: Map<string, Registered>) => [...t.keys()].filter((n) => !writes(t).includes(n)).sort();
    expect(reads(narrowed.tools)).toEqual(reads(all.tools));
    expect(narrowed.skippedWriteTools).toContain("create-voucher");
    expect(narrowed.skippedWriteTools).not.toContain("update-voucher");
  });

  it("'none' registers no write tool at all (any casing, surrounding whitespace)", () => {
    expect(writes(capture(cfg({ LEXWARE_WRITE_TOOLS: "none" })).tools)).toEqual([]);
    expect(writes(capture(cfg({ LEXWARE_WRITE_TOOLS: " NONE " })).tools)).toEqual([]);
  });

  it("cannot re-enable a tool of a disabled tier", () => {
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher,create-finalized-invoice,delete-article" }));
    expect(writes(c.tools)).toEqual(["update-voucher"]);
  });

  it("also filters and audits the finalize tier when it is enabled", async () => {
    const c = capture(cfg({ LEXWARE_ENABLE_FINALIZE: "true", LEXWARE_WRITE_TOOLS: "delete-article" }));
    expect(writes(c.tools)).toEqual(["delete-article"]);
    expect(c.skippedWriteTools).toContain("create-finalized-invoice");
    expect(c.skippedWriteTools).toContain("create-event-subscription");
    await c.tools.get("delete-article")!.handler({ id: "a1", confirm_delete: true }, { authInfo: undefined }).catch(() => undefined);
    expect(c.events().map((e) => e.tool)).toEqual(["delete-article", "delete-article"]);
  });

  it("rejects malformed, unknown, uppercase and mixed-with-none names at start-up (fail closed)", () => {
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "update-voucher;rm" })).toThrow(/Invalid tool name/);
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "updatevoucher" })).toThrow(/Unknown write tool "updatevoucher"/);
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "Update-Voucher" })).toThrow(/Invalid tool name/);
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "none,update-voucher" })).toThrow(/cannot be combined/);
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "update-voucher,update-vöucher" })).toThrow(/Invalid tool name/);
    // Trailing comma and duplicates are harmless.
    expect(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher,update-voucher," }).writeToolAllowlist).toEqual(["update-voucher"]);
  });

  it("KNOWN_WRITE_TOOLS equals the set of write tools registered with every tier enabled", () => {
    const all = capture(cfg({ LEXWARE_ENABLE_FINALIZE: "true" }));
    expect(writes(all.tools).sort()).toEqual([...KNOWN_WRITE_TOOLS].sort());
  });

  it("warns at start-up when drafts are enabled without an allowlist, and not when one is set", () => {
    expect(cfg({}).warnings.join(" ")).toMatch(/LEXWARE_WRITE_TOOLS is not set/);
    expect(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher" }).warnings).toEqual([]);
    expect(cfg({ LEXWARE_ENABLE_DRAFTS: "false" }).warnings).toEqual([]);
  });

  it("is reported by get-server-info", async () => {
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher", LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY: "true" }));
    const info = (await c.tools.get("get-server-info")!.handler({})).structuredContent as Record<string, unknown>;
    expect(info.writePolicy).toEqual({
      writeToolAllowlist: ["update-voucher"],
      updateVoucherUncheckedOnly: true,
      auditTrail: "stdout-jsonl-hash-chain",
      auditChain: "hmac-sha256",
      trustProxy: false,
    });
    expect((info.tools as { writeCapable: string[] }).writeCapable).toEqual(["update-voucher"]);
  });

  it("the guard does not trust readOnlyHint: a mis-annotated tool on the write path is still filtered and audited", async () => {
    const config = cfg({ LEXWARE_WRITE_TOOLS: "none" });
    const { guardWriteTools } = await import("../src/tools/write-guard.js");
    const tools = new Map<string, Registered>();
    const server = {
      registerTool(c: Omit<Registered, "handler">, handler: Handler) {
        tools.set(c.name, { ...c, handler });
        return server;
      },
    } as unknown as McpServer;
    const skipped: string[] = [];
    const guarded = guardWriteTools(server, config, new WriteAuditLog({ sink: () => undefined }), skipped);
    guarded.registerTool(
      { name: "sneaky-post", annotations: { readOnlyHint: true } } as never,
      (async () => ({ content: [] })) as never,
    );
    expect(tools.has("sneaky-post")).toBe(false);
    expect(skipped).toEqual(["sneaky-post"]);
  });

  it("structural: every module calling a client write method is registered through writeServer and never read-only annotated", () => {
    const dir = join(process.cwd(), "src/tools");
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    // Generic call sites look like `client.post<{ id: string }>(`; delete registrars reach the API through
    // `deleteIdempotent` (shared.ts). Both must count as write calls, or this test goes vacuous.
    const writeCall = /client\.(post|put|request|delete|postMultipart)\b|deleteIdempotent\(/;
    const inspected: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || ["index.ts", "write-guard.ts", "schemas.ts", "shared.ts"].includes(file)) continue;
      const source = readFileSync(join(dir, file), "utf8");
      if (!writeCall.test(source)) continue;
      // Every exported registrar of this module that reaches a write call must be invoked with writeServer.
      const registrars = [...source.matchAll(/export function (register\w+)\(/g)].map((m) => m[1]);
      for (const fn of registrars) {
        const calls = [...index.matchAll(new RegExp(`${fn}\\(\\s*(\\w+)`, "g"))].map((m) => m[1]);
        const bodyStart = source.indexOf(`export function ${fn}(`);
        const bodyEnd = source.indexOf("\nexport function ", bodyStart + 1);
        const body = source.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
        if (!writeCall.test(body)) continue;
        inspected.push(fn);
        expect(calls, `${file}:${fn} must register via writeServer`).not.toHaveLength(0);
        for (const target of calls) expect(target, `${file}:${fn}`).toBe("writeServer");
        expect(body, `${file}:${fn} must not be annotated read-only`).not.toMatch(/readOnlyHint:\s*true/);
      }
    }
    // The heuristic must actually have looked at every write registrar (guards against a regex regression).
    expect(inspected.sort()).toEqual([
      "registerArticleDeleteTools",
      "registerArticleWriteTools",
      "registerContactDraftTools",
      "registerDocumentDraftTools",
      "registerDocumentFinalizeTools",
      "registerEventSubscriptionDeleteTools",
      "registerEventSubscriptionWriteTools",
      "registerFileWriteTools",
      "registerLusVoucherWebhookTools",
      "registerVoucherWriteTools",
    ]);
  });
});

const VOUCHER = {
  id: "v1",
  version: 3,
  type: "purchaseinvoice",
  voucherStatus: "unchecked",
  voucherNumber: "RE-2026-0001",
  remark: "private note",
  contactName: "Some Person",
  files: ["f1"],
  voucherItems: [],
};

function voucherClient(current: Record<string, unknown>) {
  return {
    get: vi.fn(async () => structuredClone(current)),
    request: vi.fn(async () => ({ id: current.id, version: (current.version as number) + 1 })),
  };
}

const extra = { authInfo: undefined };
const hmac = (key: Buffer, value: string) => createHmac("sha256", key).update(value).digest("hex");

describe("update-voucher audit + unchecked-only", () => {
  const env = { LEXWARE_WRITE_TOOLS: "update-voucher", LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY: "true" };

  it("logs an attempt line before and a result line after, with before/after and no free text in clear", async () => {
    const client = voucherClient(VOUCHER);
    const config = cfg(env);
    const c = capture(config, client as unknown as LexwareClient);
    const res = await c.tools.get("update-voucher")!.handler(
      {
        id: "v1",
        voucherStatus: "open",
        totalGrossAmount: 11.9,
        totalTaxAmount: 1.9,
        taxType: "gross",
        voucherItems: [{ amount: 11.9, taxAmount: 1.9, taxRatePercent: 19, categoryId: "cat" }],
      },
      extra,
    );
    const [attempt, e] = c.events();
    const actor = `static-token#${createHash("sha256").update(TOKEN).digest("hex").slice(0, 8)}`;
    expect(attempt).toMatchObject({ seq: 1, tool: "update-voucher", target: "v1", outcome: "attempt", prevHash: "genesis", actor });
    expect(attempt.detail).toBeUndefined();
    expect(e).toMatchObject({ audit: "lexware-write", seq: 2, tool: "update-voucher", target: "v1", outcome: "ok", prevHash: attempt.hash, actor });
    expect(e.detail?.before).toMatchObject({ voucherStatus: "unchecked", version: 3, totalGrossAmount: null });
    expect(e.detail?.after).toMatchObject({ voucherStatus: "open", version: 4, totalGrossAmount: 11.9 });
    expect(e.detail?.changed).toEqual(["taxType", "totalGrossAmount", "totalTaxAmount", "voucherItems", "voucherStatus"]);
    for (const line of c.lines) {
      expect(line).not.toContain("private note");
      expect(line).not.toContain("Some Person");
      expect(line).not.toContain("RE-2026-0001");
      expect(line).not.toContain(TOKEN);
    }
    // Fingerprints are keyed: the plain SHA-256 of the name must NOT appear (dictionary-reversible otherwise).
    const plain = createHash("sha256").update("Some Person").digest("hex").slice(0, 16);
    expect(c.lines[1]).not.toContain(plain);
    const before = e.detail?.before as { contactName: { sha256: string; length: number }; voucherNumber: { sha256: string } };
    expect(before.contactName).toEqual({ sha256: hmac(config.auditKey!, "Some Person").slice(0, 16), length: 11 });
    expect(before.voucherNumber.sha256).toBe(hmac(config.auditKey!, "RE-2026-0001").slice(0, 16));
    expect(res.content?.at(-1)?.text).toMatch(/^Audit: #2 [0-9a-f]{12}$/);
  });

  it.each([
    ["open", "open"],
    ["paid", "paid"],
    ["voided", "voided"],
    ["Unchecked (wrong case)", "Unchecked"],
    [" unchecked (whitespace)", " unchecked"],
    ["missing", undefined],
    ["null", null],
  ])("refuses a voucher whose status is %s and logs the refusal without a PUT", async (_label, status) => {
    const current: Record<string, unknown> = { ...VOUCHER };
    if (status === undefined) delete current.voucherStatus;
    else current.voucherStatus = status;
    const client = voucherClient(current);
    const c = capture(cfg(env), client as unknown as LexwareClient);
    await expect(c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow(
      /only updates vouchers with status "unchecked"/,
    );
    expect(client.request).not.toHaveBeenCalled();
    expect(c.events().map((e) => e.outcome)).toEqual(["attempt", "refused"]);
  });

  it("never writes an unknown status, type or tax type in clear (refusal text and snapshots)", async () => {
    const client = voucherClient({ ...VOUCHER, voucherStatus: "weird Some Person status", type: "odd Some Person type", taxType: "tax Some Person" });
    const c = capture(cfg(env), client as unknown as LexwareClient);
    await expect(c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow(/status "unknown"/);
    expect(c.lines.join("\n")).not.toContain("Some Person");
    const [, refused] = c.events();
    expect(refused.detail?.before).toMatchObject({ voucherStatus: "other", type: "other", taxType: "other" });
  });

  it("fingerprints a target that does not look like an id (free text, oversized)", async () => {
    const client = voucherClient(VOUCHER);
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher" }), client as unknown as LexwareClient);
    await c.tools.get("update-voucher")!.handler({ id: "Some Person said hello ".repeat(10), remark: "x" }, extra).catch(() => undefined);
    const [attempt] = c.events();
    expect(attempt.target).toMatch(/^id#[0-9a-f]{16}$/);
    expect(c.lines.join("\n")).not.toContain("Some Person");
  });

  it("fails closed when the status read fails: no PUT, outcome error without the upstream text", async () => {
    const client = voucherClient(VOUCHER);
    client.get.mockRejectedValueOnce(new LexwareApiError(503, 'upstream said: contactName "Some Person"'));
    const c = capture(cfg(env), client as unknown as LexwareClient);
    await expect(c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
    const [, e] = c.events();
    expect(e).toMatchObject({ outcome: "error", error: "LexwareApiError status=503 kind=upstream" });
    expect(c.lines.join("\n")).not.toContain("Some Person");
  });

  it("allows booked vouchers when the switch is off (default)", async () => {
    const client = voucherClient({ ...VOUCHER, voucherStatus: "open" });
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher" }), client as unknown as LexwareClient);
    await c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra);
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("chains consecutive events with HMAC-SHA256 and never copies a generic error message", async () => {
    const client = voucherClient(VOUCHER);
    client.request.mockRejectedValueOnce(new Error('boom contactName "Some Person"'));
    const config = cfg(env);
    const c = capture(config, client as unknown as LexwareClient);
    const tool = c.tools.get("update-voucher")!;
    await expect(tool.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow("boom");
    await tool.handler({ id: "v1", remark: "y" }, extra);
    const [a1, a, b1, b] = c.events();
    expect(a).toMatchObject({ seq: 2, outcome: "error", prevHash: a1.hash });
    expect(a.error).toMatch(/^Error msg#[0-9a-f]{16}$/);
    expect(c.lines.join("\n")).not.toContain("Some Person");
    expect(b1).toMatchObject({ seq: 3, outcome: "attempt", prevHash: a.hash });
    expect(b).toMatchObject({ seq: 4, outcome: "ok", prevHash: b1.hash });
    for (const ev of [a1, a, b1, b]) {
      const { hash, ...body } = ev;
      expect(hmac(config.auditKey!, JSON.stringify(body))).toBe(hash);
      // Not the plain hash: a log editor without the key cannot recompute the chain.
      expect(createHash("sha256").update(JSON.stringify(body)).digest("hex")).not.toBe(hash);
    }
  });

  it("falls back to plain SHA-256 (with a start-up warning) when no key can be derived", () => {
    const config = loadConfig({ LEXWARE_API_KEY: "k", MCP_ALLOW_UNAUTHENTICATED: "true", ...PRODUCTION, LEXWARE_WRITE_TOOLS: "update-voucher" } as NodeJS.ProcessEnv);
    expect(config.auditKey).toBeNull();
    expect(config.warnings.join(" ")).toMatch(/LEXWARE_AUDIT_KEY is not set/);
    const explicit = loadConfig({ LEXWARE_API_KEY: "k", MCP_ALLOW_UNAUTHENTICATED: "true", LEXWARE_AUDIT_KEY: "b".repeat(32), ...PRODUCTION, LEXWARE_WRITE_TOOLS: "update-voucher" } as NodeJS.ProcessEnv);
    expect(explicit.auditKey).toHaveLength(32);
    expect(explicit.warnings).toEqual([]);
    expect(() => loadConfig({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: TOKEN, LEXWARE_AUDIT_KEY: "short" } as NodeJS.ProcessEnv)).toThrow(/too weak/);
  });

  it("keeps the chain linear under concurrent writes and each result carries its own call's detail", async () => {
    const client = voucherClient(VOUCHER);
    const c = capture(cfg(env), client as unknown as LexwareClient);
    const tool = c.tools.get("update-voucher")!;
    await Promise.all(Array.from({ length: 6 }, (_, i) => tool.handler({ id: "v1", remark: `r${i}` }, extra)));
    const events = c.events();
    expect(events).toHaveLength(12);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(e.prevHash).toBe(i === 0 ? "genesis" : events[i - 1].hash);
    });
    const results = events.filter((e) => e.outcome === "ok");
    expect(results).toHaveLength(6);
    for (const r of results) expect(r.detail?.after).toMatchObject({ version: 4 });
  });

  it("a failing sink never turns a completed write into a tool error, and the chain stays consistent", async () => {
    const client = voucherClient(VOUCHER);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const kept: string[] = [];
    const c = capture(cfg(env), client as unknown as LexwareClient, (line) => {
      calls += 1;
      if (calls === 2) throw new Error("EPIPE");
      kept.push(line);
    });
    const tool = c.tools.get("update-voucher")!;
    await expect(tool.handler({ id: "v1", remark: "x" }, extra)).resolves.toBeDefined();
    expect(client.request).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/audit: sink failed for seq 2/));
    await tool.handler({ id: "v1", remark: "y" }, extra);
    const next = JSON.parse(kept[1]) as AuditEvent;
    expect(next.seq).toBe(3);
    expect(next.prevHash).toMatch(/^[0-9a-f]{64}$/);
    stderr.mockRestore();
  });

  it("summarizeError keeps our own refusals, reduces Lexware errors to status/kind and hashes anything else", () => {
    expect(summarizeError(new WriteRefusedError("Voucher v1 has status \"open\""), null)).toBe('WriteRefusedError: Voucher v1 has status "open"');
    expect(summarizeError(new LexwareApiError(409, "conflict body with Some Person"), null)).toBe("LexwareApiError status=409 kind=validation");
    expect(summarizeError(new TypeError("Some Person"), null)).toMatch(/^TypeError msg#[0-9a-f]{16}$/);
    const odd = new Error("x");
    odd.name = "Error for Some Person";
    expect(summarizeError(odd, null)).toMatch(/^Error\(name#[0-9a-f]{8}\) msg#[0-9a-f]{16}$/);
    expect(summarizeError(odd, null)).not.toContain("Some Person");
    expect(summarizeError("raw string Some Person", null)).toMatch(/^string msg#[0-9a-f]{16}$/);
  });
});

describe("failed-auth throttling", () => {
  function call(mw: ReturnType<typeof bearerAuthMiddleware>, auth: string, xff = "1.2.3.4", remote = "10.0.0.1") {
    const req = { headers: { authorization: auth, "x-forwarded-for": xff }, socket: { remoteAddress: remote } } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }) as unknown as Response);
    const res = { status, set: vi.fn() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    return { status, next };
  }

  it("never answers a valid token with 429, even from a client key that is locked (shared egress)", () => {
    let t = 0;
    const mw = bearerAuthMiddleware(TOKEN, { trustProxy: true, limiter: new FailedAuthLimiter(3, 60_000, 60_000, 100, () => t) });
    for (let i = 0; i < 3; i++) expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(401);
    // Same key, wrong token: locked.
    expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(429);
    // Same key, valid token: passes (the legitimate connector behind the same egress is unaffected).
    expect(call(mw, `Bearer ${TOKEN}`).next).toHaveBeenCalled();
    // ... and the active lockout for wrong tokens from that key is kept, not cleared by the valid token.
    expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(429);
    // Another client is unaffected either way.
    expect(call(mw, `Bearer ${TOKEN}`, "5.6.7.8").next).toHaveBeenCalled();
    expect(call(mw, "Bearer wrong", "5.6.7.8").status).toHaveBeenCalledWith(401);
    t = 61_000;
    expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(401);
  });

  it("defaults: 10 failures within 15 minutes lock for 15 minutes; the window resets", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(undefined, undefined, undefined, undefined, () => t);
    for (let i = 0; i < 9; i++) expect(limiter.fail("c")).toBe(false);
    t = 16 * 60_000; // window expired: the 10th failure starts a new window, no lock
    expect(limiter.fail("c")).toBe(false);
    for (let i = 0; i < 8; i++) expect(limiter.fail("c")).toBe(false);
    expect(limiter.fail("c")).toBe("client");
    expect(limiter.blockedFor("c")).toBe(15 * 60);
    t += 15 * 60_000 - 1;
    expect(limiter.blockedFor("c")).toBe(1);
    t += 1;
    expect(limiter.blockedFor("c")).toBe(0);
  });

  it("a valid token does not reset the client's failure window (no recycling of the window via a shared egress)", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(3, 60_000, 60_000, 100, () => t);
    const mw = bearerAuthMiddleware(TOKEN, { trustProxy: true, limiter });
    call(mw, "Bearer wrong");
    call(mw, "Bearer wrong");
    expect(call(mw, `Bearer ${TOKEN}`).next).toHaveBeenCalled();
    expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(401); // 3rd failure of the window → lock
    expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(429);
    expect(call(mw, `Bearer ${TOKEN}`).next).toHaveBeenCalled();
  });

  it("the global window resets after windowMs without a trip, and fail() reports which lock tripped", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(100, 60_000, 60_000, 1000, () => t, 20);
    for (let i = 0; i < 19; i++) expect(limiter.fail(`p${i}`)).toBe(false);
    t = 61_000;
    expect(limiter.fail("p-late")).toBe(false); // new window: 1/20
    for (let i = 0; i < 18; i++) expect(limiter.fail(`q${i}`)).toBe(false);
    expect(limiter.fail("q-last")).toBe("global");
    expect(limiter.globalTrips).toBe(1);
    const per = new FailedAuthLimiter(2, 60_000, 60_000, 1000, () => t, 1_000_000);
    expect(per.fail("c")).toBe(false);
    expect(per.fail("c")).toBe("client");
  });

  it("logs a distinct line when the global budget trips", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mw = bearerAuthMiddleware(TOKEN, { trustProxy: true, limiter: new FailedAuthLimiter(100, 60_000, 60_000, 1000, () => 0, 3) });
    for (let i = 0; i < 3; i++) call(mw, "Bearer wrong", `203.0.113.${i}`);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/global failure budget exhausted/));
    stderr.mockRestore();
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY is on (rotating the header cannot bypass the lockout)", () => {
    let t = 0;
    const mw = bearerAuthMiddleware(TOKEN, { limiter: new FailedAuthLimiter(3, 60_000, 60_000, 100, () => t) });
    for (let i = 0; i < 3; i++) call(mw, "Bearer wrong", `203.0.113.${i}`);
    expect(call(mw, "Bearer wrong", "203.0.113.99").status).toHaveBeenCalledWith(429);
    // And a forged header cannot target a victim: a different TCP peer is a different key.
    expect(call(mw, "Bearer wrong", "203.0.113.99", "10.0.0.2").status).toHaveBeenCalledWith(401);
  });

  it("keys on the right-most X-Forwarded-For entry with TRUST_PROXY, on the socket otherwise, 'unknown' as last resort", () => {
    const req = { headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, socket: { remoteAddress: "10.0.0.1" } } as unknown as Request;
    expect(clientKey(req, true)).toBe("1.2.3.4");
    expect(clientKey(req, false)).toBe("10.0.0.1");
    expect(clientKey({ headers: {} } as unknown as Request, true)).toBe("unknown");
  });

  it("keys IPv6 clients by /64 and unmaps IPv4-mapped addresses", () => {
    expect(normalizeAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(normalizeAddress("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(normalizeAddress("::1")).toBe("0000:0000:0000:0000::/64");
    expect(normalizeAddress("::ffff:192.0.2.9")).toBe("192.0.2.9");
    expect(normalizeAddress("::FFFF:192.0.2.9")).toBe("192.0.2.9");
    expect(normalizeAddress("0:0:0:0:0:ffff:192.0.2.9")).toBe("192.0.2.9");
    expect(normalizeAddress("::ffff:c000:209")).toBe("192.0.2.9");
    expect(normalizeAddress("fe80::1%lo0")).toBe("fe80:0000:0000:0000::/64");
    expect(normalizeAddress("192.0.2.9")).toBe("192.0.2.9");
    expect(normalizeAddress("not-an-ip")).toBe("not-an-ip");
    // Non-IP values never become a Map key verbatim: hashed, bounded; empty → "unknown".
    const forged = { headers: { "x-forwarded-for": "x".repeat(100_000) } } as unknown as Request;
    expect(clientKey(forged, true)).toMatch(/^other#[0-9a-f]{16}$/);
    expect(clientKey({ headers: { "x-forwarded-for": "%" } } as unknown as Request, true)).toBe("unknown");
  });

  it("a global failure budget throttles a flood that rotates client keys (valid token still passes)", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(3, 60_000, 60_000, 1000, () => t, 20);
    const mw = bearerAuthMiddleware(TOKEN, { trustProxy: true, limiter });
    for (let i = 0; i < 19; i++) expect(call(mw, "Bearer wrong", `203.0.113.${i}`).status).toHaveBeenCalledWith(401);
    expect(call(mw, "Bearer wrong", "203.0.113.19").status).toHaveBeenCalledWith(401); // 20th trips the budget
    expect(call(mw, "Bearer wrong", "198.51.100.1").status).toHaveBeenCalledWith(429); // fresh key, still 429
    expect(call(mw, `Bearer ${TOKEN}`, "198.51.100.2").next).toHaveBeenCalled();
    t = 61_000;
    expect(call(mw, "Bearer wrong", "198.51.100.3").status).toHaveBeenCalledWith(401);
  });

  it("keeps the memory bound and the scan cost amortised under a flood of new keys", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(10, 60_000, 60_000, 1000, () => t, 1_000_000);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) limiter.fail(`peer-${i}`);
    const ms = performance.now() - started;
    expect(limiter.size).toBeLessThanOrEqual(1000);
    expect(ms).toBeLessThan(2_000);
    // Amortised: one scan frees 10 % (100 slots), so 19 000 insertions past the cap need ~190 scans, not 19 000.
    expect(limiter.evictionScans).toBeLessThanOrEqual(200);
    expect(limiter.evictionScans).toBeGreaterThan(0);
  });

  it("evicts expired and unlocked entries when full but never an active lockout", () => {
    let t = 0;
    const limiter = new FailedAuthLimiter(2, 60_000, 60_000, 3, () => t, 1_000_000);
    limiter.fail("locked");
    limiter.fail("locked"); // locked now
    limiter.fail("a");
    limiter.fail("b");
    expect(limiter.size).toBe(3);
    limiter.fail("c"); // full: must evict an unlocked entry, keep "locked"
    expect(limiter.size).toBe(3);
    expect(limiter.blockedFor("locked")).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) limiter.fail(`flood-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(3);
    expect(limiter.blockedFor("locked")).toBeGreaterThan(0);
  });
});
