import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { SERVER_NAME, SERVER_VERSION, buildLogLabel, resolveBuildInfo } from "../src/build-info.js";
import { type Config, loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerTools } from "../src/tools/index.js";
import { buildServerInfo, trackToolRegistrations } from "../src/tools/server-info.js";

type Handler = (input: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown>; content: Array<{ text: string }> }>;
interface Registered {
  name: string;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  handler: Handler;
}

const SECRETS = {
  LEXWARE_API_KEY: "SECRET-LEXWARE-KEY-0123456789",
  MCP_AUTH_TOKEN: "SECRET-STATIC-TOKEN-abcdefghijklmnopqrstuvwxyz0123",
  LEXWARE_WEBHOOK_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----SECRETKEYMATERIAL-----END PUBLIC KEY-----",
};

function capture(config: Config, env: NodeJS.ProcessEnv) {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(cfg: Omit<Registered, "handler">, handler: Handler) {
      tools.set(cfg.name, { ...cfg, handler });
      return server;
    },
  } as unknown as McpServer;
  const client = new Proxy(
    {},
    {
      get() {
        throw new Error("get-server-info must not touch the Lexware client");
      },
    },
  ) as LexwareClient;
  registerTools(server, client, config, { env, startedAt: new Date("2026-10-06T10:00:00.000Z"), now: () => new Date("2026-10-06T10:01:30.000Z") });
  return tools;
}

const cfg = (extra: Record<string, string>) => loadConfig({ ...SECRETS, ...extra } as NodeJS.ProcessEnv);

describe("get-server-info", () => {
  it("reports read-only mode truthfully: 46 tools, none write-capable", async () => {
    const env = { ...SECRETS, LEXWARE_READ_ONLY: "true", RENDER_GIT_COMMIT: "ABCDEF1234567890abcdef1234567890ABCDEF12" };
    const tools = capture(cfg({ LEXWARE_READ_ONLY: "true" }), env);
    const tool = tools.get("get-server-info");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const out = await tool!.handler({});
    const info = out.structuredContent as unknown as ReturnType<typeof buildServerInfo>;
    expect(info.server).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(info.build).toEqual({ sha: "abcdef1234567890abcdef1234567890abcdef12", shaSource: "RENDER_GIT_COMMIT", status: "KNOWN" });
    expect(info.capabilities).toEqual({ tiers: ["read"], effectiveReadOnly: true });
    expect(info.tools.registeredCount).toBe(tools.size);
    expect(info.tools.registeredCount).toBe(46);
    expect(info.tools.writeCapable).toEqual([]);
    expect(info.tools.names).toContain("get-server-info");
    expect(info.tools.names).not.toContain("acknowledge-voucher-event");
    expect(info.runtime).toMatchObject({ startedAt: "2026-10-06T10:00:00.000Z", uptimeSeconds: 90 });
    expect(info.webhook.publicKeyConfigured).toBe(true);
    expect(info.secretsIncluded).toBe(false);
    expect(out.content[0].text).toContain("registered tools: 46 (write-capable: 0)");
  });

  it("lists exactly the registered write-capable tools in the drafts configuration", async () => {
    const tools = capture(cfg({ LEXWARE_ENABLE_DRAFTS: "true" }), { ...SECRETS });
    const info = (await tools.get("get-server-info")!.handler({})).structuredContent as unknown as ReturnType<typeof buildServerInfo>;
    const expectedWrites = [...tools.values()].filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(info.capabilities).toEqual({ tiers: ["read", "drafts"], effectiveReadOnly: false });
    expect(info.tools.writeCapable).toEqual(expectedWrites);
    expect(info.tools.writeCapable).toHaveLength(16);
    expect(info.tools.registeredCount).toBe(62);
  });

  it("never contains secret values (API key, token, webhook key)", async () => {
    for (const extra of [{ LEXWARE_READ_ONLY: "true" }, { LEXWARE_ENABLE_FINALIZE: "true" }] as Array<Record<string, string>>) {
      const tools = capture(cfg(extra), { ...SECRETS });
      const out = await tools.get("get-server-info")!.handler({});
      const serialized = JSON.stringify(out);
      for (const secret of Object.values(SECRETS)) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("SECRETKEYMATERIAL");
    }
  });

  it("reports the OAuth allowlist size, never its entries", () => {
    const config = loadConfig({
      LEXWARE_API_KEY: "k",
      OAUTH_ISSUER: "https://auth.example.test",
      OAUTH_RESOURCE: "https://mcp.example.test",
      OAUTH_ALLOWED_EMAIL_DOMAINS: "example.test,second.example.test",
    } as NodeJS.ProcessEnv);
    const info = buildServerInfo(config, [], { env: {}, startedAt: new Date() });
    expect(info.auth).toEqual({ mode: "oauth", oauthEmailDomainAllowlistEntries: 2 });
    expect(JSON.stringify(info)).not.toContain("second.example.test");
    expect(info.webhook.publicKeyConfigured).toBe(false);
  });
});

describe("resolveBuildInfo", () => {
  it("accepts only hex commit ids and never echoes anything else", () => {
    expect(resolveBuildInfo({})).toEqual({ sha: null, shaSource: null, status: "UNKNOWN" });
    expect(resolveBuildInfo({ RENDER_GIT_COMMIT: "  " })).toEqual({ sha: null, shaSource: null, status: "UNKNOWN" });
    const bad = resolveBuildInfo({ RENDER_GIT_COMMIT: "$(curl evil) <script>" });
    expect(bad).toEqual({ sha: null, shaSource: "RENDER_GIT_COMMIT", status: "INVALID_FORMAT" });
    expect(resolveBuildInfo({ SOURCE_COMMIT: "abc1234" })).toEqual({ sha: "abc1234", shaSource: "SOURCE_COMMIT", status: "KNOWN" });
    expect(resolveBuildInfo({ GIT_COMMIT_SHA: "abc123" }).status).toBe("INVALID_FORMAT"); // too short
  });

  it("the startup log label is the SHA, 'unknown' or 'invalid_format' — never the raw value", () => {
    expect(buildLogLabel(resolveBuildInfo({ RENDER_GIT_COMMIT: "abc1234" }))).toBe("abc1234");
    expect(buildLogLabel(resolveBuildInfo({}))).toBe("unknown");
    expect(buildLogLabel(resolveBuildInfo({ RENDER_GIT_COMMIT: "$(evil)" }))).toBe("invalid_format");
  });
});

describe("trackToolRegistrations", () => {
  it("records registrations and forwards other members bound to the real server", () => {
    class FakeServer {
      #secret = 41;
      registered: string[] = [];
      registerTool(cfg: { name: string }) {
        this.registered.push(cfg.name);
        return this;
      }
      answer() {
        return this.#secret + 1;
      }
    }
    const real = new FakeServer();
    const sink: Array<{ name: string; readOnly: boolean }> = [];
    const tracked = trackToolRegistrations(real as unknown as McpServer, sink) as unknown as FakeServer;
    tracked.registerTool({ name: "a", annotations: { readOnlyHint: true } } as never);
    tracked.registerTool({ name: "b" } as never);
    expect(sink).toEqual([
      { name: "a", readOnly: true },
      { name: "b", readOnly: false },
    ]);
    expect(real.registered).toEqual(["a", "b"]);
    expect(tracked.answer()).toBe(42);
    expect(vi.isMockFunction(tracked.registerTool)).toBe(false);
  });
});
