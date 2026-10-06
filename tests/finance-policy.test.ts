/**
 * Finance policy tests — the server-side write boundary of the Lexware MCP.
 *
 * These lock in what the LU'S production configuration can and cannot do, independent of any
 * prompt or agent instruction. Changing an expectation here changes the finance write boundary
 * and requires Security Board sign-off (see ai-company/policies/finance-write-gates.md).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import {
  acknowledgePendingVoucherEvent,
  addPendingVoucherEvent,
  listPendingVoucherEvents,
} from "../src/pending-voucher-events.js";
import { registerLusVoucherWebhookTools } from "../src/tools/event-subscriptions.js";
import { registerFileReadTools } from "../src/tools/files.js";
import { registerTools } from "../src/tools/index.js";
import {
  registerPendingVoucherEventReadTools,
  registerPendingVoucherEventWriteTools,
} from "../src/tools/pending-voucher-events.js";
import { registerVoucherReconciliationReadTools } from "../src/tools/reconciliation.js";

type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;
interface Registered {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: Record<string, unknown>;
  handler: Handler;
}

function capture(register: (s: McpServer) => void): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(cfg: Omit<Registered, "handler">, handler: Handler) {
      tools.set(cfg.name, { ...cfg, handler });
      return server;
    },
  } as unknown as McpServer;
  register(server);
  return tools;
}

const TOKEN = "a".repeat(40);
const cfg = (extra: Record<string, string>): Config =>
  loadConfig({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: TOKEN, ...extra } as NodeJS.ProcessEnv);

/** The LU'S production tiers as documented: drafts on, finalize off, read-only off. */
const PRODUCTION = { LEXWARE_ENABLE_DRAFTS: "true", LEXWARE_ENABLE_FINALIZE: "false", LEXWARE_READ_ONLY: "false" };

/** Every tool that can change state in the production configuration. Adding one is a policy change. */
const PRODUCTION_WRITE_TOOLS = [
  "acknowledge-voucher-event", // local RAM queue only — never Lexware
  "create-article",
  "create-contact",
  "create-draft-credit-note",
  "create-draft-delivery-note",
  "create-draft-dunning",
  "create-draft-invoice",
  "create-draft-order-confirmation",
  "create-draft-quotation",
  "create-voucher",
  "ensure-lus-voucher-webhook",
  "update-article",
  "update-contact",
  "update-voucher",
  "upload-file",
  "upload-voucher-file",
];

const READ_STACK = ["get-pending-voucher-events", "reconcile-recent-vouchers", "get-voucher-file-text", "get-voucher"];

/** A client whose every non-GET method fails the test if called. */
function readOnlyClient(overrides: Partial<Record<"get" | "getBinary", unknown>> = {}) {
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`write method ${name} must not be called by a read tool`);
    });
  return {
    get: vi.fn(),
    getBinary: vi.fn(),
    post: forbidden("post"),
    postMultipart: forbidden("postMultipart"),
    request: forbidden("request"),
    delete: forbidden("delete"),
    ...overrides,
  };
}

describe("server-side write boundary (production tiers)", () => {
  const prod = capture((s) => registerTools(s, {} as LexwareClient, cfg(PRODUCTION)));

  it("registers no finalize, delete or arbitrary-webhook tool", () => {
    const names = [...prod.keys()];
    expect(names.filter((n) => n.startsWith("create-finalized-"))).toEqual([]);
    expect(names).not.toContain("delete-article");
    expect(names).not.toContain("create-event-subscription");
    expect(names).not.toContain("delete-event-subscription");
  });

  it("exposes exactly the reviewed set of state-changing tools", () => {
    const writes = [...prod.values()].filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual([...PRODUCTION_WRITE_TOOLS].sort());
  });

  it("keeps the expense read stack in the always-on read tier", () => {
    for (const name of READ_STACK) expect(prod.get(name)?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("read-only mode", () => {
  const ro = capture((s) =>
    registerTools(s, {} as LexwareClient, cfg({ ...PRODUCTION, LEXWARE_ENABLE_FINALIZE: "true", LEXWARE_READ_ONLY: "true" })),
  );

  it("overrides every enable flag and registers only read-only tools", () => {
    expect(ro.size).toBeGreaterThan(0);
    for (const t of ro.values()) expect({ name: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ name: t.name, readOnly: true });
    for (const w of PRODUCTION_WRITE_TOOLS) expect(ro.has(w)).toBe(false);
  });

  it("still serves the full expense read stack", () => {
    for (const name of READ_STACK) expect(ro.has(name)).toBe(true);
  });

  it("switching production to LEXWARE_READ_ONLY=true removes exactly the write tools and keeps every read tool", () => {
    const prod = capture((s) => registerTools(s, {} as LexwareClient, cfg(PRODUCTION)));
    const switched = capture((s) => registerTools(s, {} as LexwareClient, cfg({ ...PRODUCTION, LEXWARE_READ_ONLY: "true" })));
    const expected = [...prod.keys()].filter((n) => !PRODUCTION_WRITE_TOOLS.includes(n));
    expect([...switched.keys()].sort()).toEqual(expected.sort());
    expect(switched.has("list-event-subscriptions")).toBe(true);
  });

  it("keeps the signed webhook receiver independent of the capability tiers", () => {
    // The receiver lives in src/server.ts (not unit-testable: it starts the server on import), so this
    // is a structural check: the routes are registered unconditionally and the file never reads tiers.
    const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    expect(server).toMatch(/server\.express\.post\(\s*"\/webhooks\/lexware"/);
    expect(server).toMatch(/server\.express\.head\(\s*"\/webhooks\/lexware"/);
    expect(server).not.toMatch(/capabilities\.(read|drafts|finalize)|LEXWARE_READ_ONLY/);
  });
});

describe("reconcile-recent-vouchers is read-only", () => {
  it("only GETs the voucherlist and leaves the pending queue untouched", async () => {
    const before = JSON.stringify(listPendingVoucherEvents());
    const empty = { content: [], first: true, last: true, number: 0, numberOfElements: 0, size: 250, totalPages: 0, totalElements: 0 };
    const client = readOnlyClient({ get: vi.fn(async () => empty) });
    const tools = capture((s) => registerVoucherReconciliationReadTools(s, client as unknown as LexwareClient));

    const res = await tools.get("reconcile-recent-vouchers")!.handler({ createdDateFrom: "2026-10-01", maxPagesPerType: 1 });

    expect(res.structuredContent.mode).toBe("read-only");
    expect(client.get).toHaveBeenCalledTimes(4); // one page per bookkeeping voucher type
    for (const call of client.get.mock.calls) expect(call[0]).toBe("/v1/voucherlist");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
    expect(JSON.stringify(listPendingVoucherEvents())).toBe(before);
  });
});

describe("get-voucher-file-text is read-only and fingerprints the exact bytes", () => {
  it("returns the SHA-256 of the downloaded bytes and never writes", async () => {
    const bytes = Buffer.from("hello");
    const client = readOnlyClient({ getBinary: vi.fn(async () => ({ data: bytes, contentType: "text/plain" })) });
    const tools = capture((s) => registerFileReadTools(s, client as unknown as LexwareClient));

    const res = await tools.get("get-voucher-file-text")!.handler({ id: "file-1", maxCharacters: 1000 });

    expect(res.structuredContent.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(res.structuredContent.isPdf).toBe(false);
    // The download is size-limited (10 MiB) so a hostile or huge file cannot exhaust memory.
    expect(client.getBinary).toHaveBeenCalledWith("/v1/files/file-1", "application/pdf", { maxBytes: 10 * 1024 * 1024 });
    expect(client.post).not.toHaveBeenCalled();
    expect(client.postMultipart).not.toHaveBeenCalled();
  });
});

describe("pending voucher queue (local, idempotent)", () => {
  it("deduplicates a re-delivered webhook event", () => {
    const id = `policy-test-${Date.now()}-dedup`;
    const first = addPendingVoucherEvent({ resourceId: id, eventDate: "2026-10-06T10:00:00Z" });
    const second = addPendingVoucherEvent({ resourceId: id, eventDate: "2026-10-06T10:00:00Z" });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.count).toBe(first.count);
    acknowledgePendingVoucherEvent(id);
  });

  it("acknowledge removes only the given resource, needs no Lexware client, and is idempotent", async () => {
    const keep = `policy-test-${Date.now()}-keep`;
    const ack = `policy-test-${Date.now()}-ack`;
    addPendingVoucherEvent({ resourceId: keep, eventDate: "2026-10-06T10:00:00Z" });
    addPendingVoucherEvent({ resourceId: ack, eventDate: "2026-10-06T10:00:00Z" });

    // registerPendingVoucherEventWriteTools takes no client: acknowledging cannot reach Lexware.
    const tools = capture((s) => {
      registerPendingVoucherEventReadTools(s);
      registerPendingVoucherEventWriteTools(s);
    });
    const res = await tools.get("acknowledge-voucher-event")!.handler({ resourceId: ack });
    expect(res.structuredContent.removed).toBe(1);

    const remaining = listPendingVoucherEvents().map((e) => e.resourceId);
    expect(remaining).toContain(keep);
    expect(remaining).not.toContain(ack);
    expect(acknowledgePendingVoucherEvent(ack).removed).toBe(0);
    acknowledgePendingVoucherEvent(keep);
  });
});

describe("ensure-lus-voucher-webhook can only create the fixed subscription", () => {
  const FIXED = { eventType: "voucher.created", callbackUrl: "https://lus-lexware-mcp.onrender.com/webhooks/lexware" };

  it("accepts no input (no URL or event type can be injected)", () => {
    const tools = capture((s) => registerLusVoucherWebhookTools(s, readOnlyClient() as unknown as LexwareClient));
    const schema = tools.get("ensure-lus-voucher-webhook")!.inputSchema;
    expect(schema === undefined || Object.keys(schema).length === 0).toBe(true);
  });

  it("does not POST when the subscription already exists", async () => {
    const client = readOnlyClient({ get: vi.fn(async () => ({ content: [{ subscriptionId: "s1", ...FIXED }] })) });
    const tools = capture((s) => registerLusVoucherWebhookTools(s, client as unknown as LexwareClient));
    const res = await tools.get("ensure-lus-voucher-webhook")!.handler({});
    expect(res.structuredContent.created).toBe(false);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("POSTs exactly the fixed event type and callback when missing", async () => {
    const post = vi.fn(async () => ({ id: "s2" }));
    const client = { ...readOnlyClient({ get: vi.fn(async () => ({ content: [] })) }), post };
    const tools = capture((s) => registerLusVoucherWebhookTools(s, client as unknown as LexwareClient));
    await tools.get("ensure-lus-voucher-webhook")!.handler({});
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v1/event-subscriptions", FIXED);
  });
});

/*
 * Phase 2 truth layer (finance core). These tests pin that the new read path stays technically read-only:
 * no new write-capable tool, a GET-only client facade, and finance modules that cannot reach a write call.
 */
describe("Phase 2 finance truth layer stays read-only", () => {
  it("adds no write-capable tool: the production write set is unchanged and get-server-info is read-only and local", () => {
    const prod = capture((s) => registerTools(s, {} as LexwareClient, cfg(PRODUCTION)));
    const writes = [...prod.values()].filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes.sort()).toEqual([...PRODUCTION_WRITE_TOOLS].sort());
    const info = prod.get("get-server-info");
    expect(info?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("READ_ONLY still registers only read-only tools, including get-server-info", () => {
    const ro = capture((s) => registerTools(s, {} as LexwareClient, cfg({ ...PRODUCTION, LEXWARE_ENABLE_FINALIZE: "true", LEXWARE_READ_ONLY: "true" })));
    expect(ro.has("get-server-info")).toBe(true);
    for (const t of ro.values()) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("get-server-info reports zero write-capable tools in READ_ONLY and never touches the Lexware client", async () => {
    const ro = capture((s) => registerTools(s, readOnlyClient() as unknown as LexwareClient, cfg({ LEXWARE_READ_ONLY: "true" })));
    const res = await ro.get("get-server-info")!.handler({});
    const tools = res.structuredContent.tools as { writeCapable: string[]; registeredCount: number };
    expect(tools.writeCapable).toEqual([]);
    expect(tools.registeredCount).toBe(ro.size);
  });

  it("the finance client facade exposes only get/getBinary", async () => {
    const { createReadOnlyLexwareClient } = await import("../src/lexware/read-only-client.js");
    const facade = createReadOnlyLexwareClient(readOnlyClient() as unknown as LexwareClient);
    expect(Object.keys(facade).sort()).toEqual(["get", "getBinary"]);
    expect(Object.isFrozen(facade)).toBe(true);
  });

  it("finance modules contain no write path (structural scan of src/finance)", () => {
    const dir = join(process.cwd(), "src/finance");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const forbidden of [/\.post\s*\(/, /\.request\s*\(/, /postMultipart/, /\bfetch\s*\(/, /node:fs/, /child_process/, /\beval\s*\(/, /new Function/]) {
        expect({ file: f, match: forbidden.test(src) }).toEqual({ file: f, match: false });
      }
      // Only the GET-only facade type may be imported from the Lexware layer, never the full client class.
      expect({ file: f, importsClient: /from "\.\.\/lexware\/client\.js"/.test(src) }).toEqual({ file: f, importsClient: false });
    }
  });

  it("the finance loader runs end-to-end through the facade without any write call", async () => {
    const { loadFinanceSnapshot } = await import("../src/finance/loader.js");
    const { createReadOnlyLexwareClient } = await import("../src/lexware/read-only-client.js");
    const client = readOnlyClient({
      get: vi.fn(async (path: string) => {
        if (path === "/v1/voucherlist") return { content: [], totalPages: 0, last: true };
        throw new Error(`unexpected ${path}`);
      }),
    });
    const snap = await loadFinanceSnapshot(createReadOnlyLexwareClient(client as unknown as LexwareClient), {
      window: { from: "2026-09-01", to: "2026-09-30", basis: "voucherDate" },
    });
    expect(snap.completeness.list).toBe("COMPLETE");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.postMultipart).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});
