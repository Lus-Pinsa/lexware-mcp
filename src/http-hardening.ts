/**
 * Small HTTP hardening helpers for the Express app, kept out of server.ts so they can be unit-tested.
 * No Lexware logic here.
 */

/** Minimal app surface used here (express.Express satisfies it). */
export interface DisableableApp {
  disable(setting: string): unknown;
}

/**
 * Path checks for routes whose body parsing is deferred. Express routing is case-insensitive, so these must be too:
 * otherwise `/MCP` would reach the global pre-auth JSON parser that `/mcp` skips.
 */
export function isMcpPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === "/mcp" || p.startsWith("/mcp/");
}

export function isLexwareWebhookPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === "/webhooks/lexware" || p.startsWith("/webhooks/lexware/");
}

/** Do not advertise the framework in every response. */
export function hardenApp(app: DisableableApp): void {
  app.disable("x-powered-by");
}

/**
 * The pre-auth request log line: method, path (JSON-quoted, capped) and whether an Authorization header was sent.
 * No client-controlled header text (user agent, accept, token) — those enable log forging and add noise.
 */
export function preAuthDebugLine(method: string, path: string, hasAuthorization: boolean): string {
  const safeMethod = /^[A-Z]{1,10}$/.test(method) ? method : "?";
  return `[debug] ${safeMethod} ${JSON.stringify(path.slice(0, 200))} auth=${hasAuthorization ? "yes" : "no"}`;
}
