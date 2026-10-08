import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { hardenApp, isLexwareWebhookPath, isMcpPath, preAuthDebugLine } from "../src/http-hardening.js";

describe("deferred-body path checks match Express routing (case-insensitive)", () => {
  it("treats every case variant of /mcp and /webhooks/lexware as the deferred route", () => {
    for (const p of ["/mcp", "/MCP", "/Mcp", "/mcp/", "/MCP/x"]) expect(isMcpPath(p), p).toBe(true);
    for (const p of ["/webhooks/lexware", "/WEBHOOKS/LEXWARE", "/Webhooks/lexware/x"]) expect(isLexwareWebhookPath(p), p).toBe(true);
    for (const p of ["/mcpx", "/status", "/", "/webhooks/lexwarex", "/x/mcp"]) {
      expect(isMcpPath(p) || isLexwareWebhookPath(p), p).toBe(false);
    }
  });
});

describe("hardenApp", () => {
  it("removes the X-Powered-By header from real Express responses", async () => {
    const app = express();
    hardenApp(app);
    app.get("/status", (_req, res) => {
      res.json({ status: "ok" });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-powered-by")).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe("preAuthDebugLine", () => {
  it("contains only method, quoted path and auth presence — no header text", () => {
    expect(preAuthDebugLine("POST", "/mcp", true)).toBe('[debug] POST "/mcp" auth=yes');
    expect(preAuthDebugLine("GET", "/mcp", false)).toBe('[debug] GET "/mcp" auth=no');
  });

  it("cannot be used to forge log lines", () => {
    const line = preAuthDebugLine("GET\n[x]", '/mcp\r\n[lexware-mcp] FORGED "x"', false);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.startsWith("[debug] ? ")).toBe(true);
    expect(preAuthDebugLine("GET", `/mcp/${"a".repeat(5000)}`, false).length).toBeLessThan(260);
  });
});
