/**
 * Write guard, audit trail and failed-auth throttling.
 *
 * LEXWARE_WRITE_TOOLS narrows the write surface below the tiers, LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY keeps
 * booked vouchers out of reach, and every write-tool call leaves one hash-chained audit line.
 */
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { FailedAuthLimiter, bearerAuthMiddleware, clientKey } from "../src/auth.js";
import { type Config, loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerTools } from "../src/tools/index.js";
import { type AuditEvent, WriteAuditLog } from "../src/write-audit.js";

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

function capture(config: Config, client: Partial<LexwareClient> = {}) {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(c: Omit<Registered, "handler">, handler: Handler) {
      tools.set(c.name, { ...c, handler });
      return server;
    },
  } as unknown as McpServer;
  const lines: string[] = [];
  const audit = new WriteAuditLog((l) => lines.push(l));
  const { skippedWriteTools } = registerTools(
    server,
    client as LexwareClient,
    config,
    { env: {}, startedAt: new Date(0) },
    audit,
  );
  const events = () => lines.map((l) => JSON.parse(l) as AuditEvent);
  return { tools, skippedWriteTools, events, lines };
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

  it("'none' registers no write tool at all", () => {
    expect(writes(capture(cfg({ LEXWARE_WRITE_TOOLS: "none" })).tools)).toEqual([]);
  });

  it("cannot re-enable a tool of a disabled tier", () => {
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher,create-finalized-invoice,delete-article" }));
    expect(writes(c.tools)).toEqual(["update-voucher"]);
  });

  it("rejects malformed tool names instead of guessing", () => {
    expect(() => cfg({ LEXWARE_WRITE_TOOLS: "update-voucher;rm" })).toThrow(/Invalid tool name/);
  });

  it("is reported by get-server-info", async () => {
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher", LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY: "true" }));
    const info = (await c.tools.get("get-server-info")!.handler({})).structuredContent as Record<string, unknown>;
    expect(info.writePolicy).toEqual({
      writeToolAllowlist: ["update-voucher"],
      updateVoucherUncheckedOnly: true,
      auditTrail: "stdout-jsonl-hash-chain",
    });
    expect((info.tools as { writeCapable: string[] }).writeCapable).toEqual(["update-voucher"]);
  });
});

const VOUCHER = {
  id: "v1",
  version: 3,
  type: "purchaseinvoice",
  voucherStatus: "unchecked",
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

describe("update-voucher audit + unchecked-only", () => {
  const env = { LEXWARE_WRITE_TOOLS: "update-voucher", LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY: "true" };
  const extra = { authInfo: undefined };

  it("logs who/when/what with before and after, without free text in clear", async () => {
    const client = voucherClient(VOUCHER);
    const c = capture(cfg(env), client as unknown as LexwareClient);
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
    const [e] = c.events();
    expect(e).toMatchObject({
      audit: "lexware-write",
      seq: 1,
      tool: "update-voucher",
      target: "v1",
      outcome: "ok",
      prevHash: "genesis",
      actor: `static-token#${createHash("sha256").update(TOKEN).digest("hex").slice(0, 8)}`,
    });
    expect(e.detail?.before).toMatchObject({ voucherStatus: "unchecked", version: 3, totalGrossAmount: null });
    expect(e.detail?.after).toMatchObject({ voucherStatus: "open", version: 4, totalGrossAmount: 11.9 });
    expect(e.detail?.changed).toEqual(["taxType", "totalGrossAmount", "totalTaxAmount", "voucherItems", "voucherStatus"]);
    expect(c.lines[0]).not.toContain("private note");
    expect(c.lines[0]).not.toContain("Some Person");
    expect(c.lines[0]).not.toContain(TOKEN);
    expect(res.content?.at(-1)?.text).toMatch(/^Audit: #1 [0-9a-f]{12}$/);
  });

  it("refuses an already booked voucher and logs the refusal", async () => {
    const client = voucherClient({ ...VOUCHER, voucherStatus: "open" });
    const c = capture(cfg(env), client as unknown as LexwareClient);
    await expect(c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow(
      /only updates vouchers with status "unchecked"/,
    );
    expect(client.request).not.toHaveBeenCalled();
    expect(c.events()[0]).toMatchObject({ outcome: "refused", target: "v1" });
  });

  it("allows booked vouchers when the switch is off (default)", async () => {
    const client = voucherClient({ ...VOUCHER, voucherStatus: "open" });
    const c = capture(cfg({ LEXWARE_WRITE_TOOLS: "update-voucher" }), client as unknown as LexwareClient);
    await c.tools.get("update-voucher")!.handler({ id: "v1", remark: "x" }, extra);
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("logs Lexware errors and chains consecutive events", async () => {
    const client = voucherClient(VOUCHER);
    client.request.mockRejectedValueOnce(new Error("boom"));
    const c = capture(cfg(env), client as unknown as LexwareClient);
    const tool = c.tools.get("update-voucher")!;
    await expect(tool.handler({ id: "v1", remark: "x" }, extra)).rejects.toThrow("boom");
    await tool.handler({ id: "v1", remark: "y" }, extra);
    const [a, b] = c.events();
    expect(a).toMatchObject({ seq: 1, outcome: "error", error: "Error: boom" });
    expect(b).toMatchObject({ seq: 2, outcome: "ok", prevHash: a.hash });
    const { hash, ...body } = b;
    expect(createHash("sha256").update(JSON.stringify(body)).digest("hex")).toBe(hash);
  });
});

describe("failed-auth throttling", () => {
  function call(mw: ReturnType<typeof bearerAuthMiddleware>, auth: string, xff = "1.2.3.4") {
    const req = { headers: { authorization: auth, "x-forwarded-for": xff } } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }) as unknown as Response);
    const res = { status, set: vi.fn() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    mw(req, res, next);
    return { status, next };
  }

  it("locks a client out after repeated invalid tokens, per client", () => {
    let t = 0;
    const mw = bearerAuthMiddleware(TOKEN, new FailedAuthLimiter(3, 60_000, 60_000, 100, () => t));
    for (let i = 0; i < 3; i++) expect(call(mw, "Bearer wrong").status).toHaveBeenCalledWith(401);
    expect(call(mw, `Bearer ${TOKEN}`).status).toHaveBeenCalledWith(429);
    // Another client (the real connector) is unaffected.
    expect(call(mw, `Bearer ${TOKEN}`, "5.6.7.8").next).toHaveBeenCalled();
    t = 61_000;
    expect(call(mw, `Bearer ${TOKEN}`).next).toHaveBeenCalled();
  });

  it("keys on the right-most X-Forwarded-For entry (the one the proxy appended)", () => {
    const req = { headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" } } as unknown as Request;
    expect(clientKey(req)).toBe("1.2.3.4");
  });
});
