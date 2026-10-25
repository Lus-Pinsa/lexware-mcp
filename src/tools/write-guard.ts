import { createHash } from "node:crypto";
import type { McpServer } from "skybridge/server";
import type { Config } from "../config.js";
import { WriteAuditLog } from "../write-audit.js";
export { KNOWN_WRITE_TOOLS } from "../write-tools.js";

type ToolConfig = { name: string };
type Handler = (...args: unknown[]) => Promise<unknown>;


/** Who is calling, without PII or secrets: auth mode plus a short fingerprint. */
export function describeActor(config: Config, extra: unknown): string {
  const authInfo = (extra as { authInfo?: { clientId?: string; extra?: Record<string, unknown> } } | undefined)
    ?.authInfo;
  if (config.auth.mode === "oauth") {
    const sub = authInfo?.extra?.sub;
    const subFp = typeof sub === "string" ? createHash("sha256").update(sub).digest("hex").slice(0, 12) : "unknown";
    return `oauth:sub#${subFp}${authInfo?.clientId ? ` client=${authInfo.clientId}` : ""}`;
  }
  if (config.auth.mode === "static") {
    // Fingerprint (not the token): tells calls before and after a token rotation apart.
    return `static-token#${createHash("sha256").update(config.auth.token).digest("hex").slice(0, 8)}`;
  }
  return "unauthenticated";
}

/**
 * Wrap the server for the write tiers: a state-changing tool is registered only if it passes
 * `LEXWARE_WRITE_TOOLS`, and every call of a registered one is written to the audit trail.
 *
 * The guard decides by registration path, not by annotation: EVERYTHING registered through the returned
 * server is treated as a write, including a tool that (wrongly) carries `readOnlyHint: true`. Read-only
 * tools are registered through the unguarded server (src/tools/index.ts), which a structural test enforces.
 */
export function guardWriteTools(
  server: McpServer,
  config: Config,
  audit: WriteAuditLog,
  skipped: string[],
): McpServer {
  const allow = config.writeToolAllowlist;
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (toolConfig: ToolConfig, ...rest: unknown[]) => {
          const register = target.registerTool as (...args: unknown[]) => unknown;
          if (allow !== null && !allow.includes(toolConfig.name)) {
            skipped.push(toolConfig.name);
            return receiver;
          }
          const handler = rest[rest.length - 1] as Handler;
          const audited: Handler = async (...args) => {
            const input = args.length > 1 ? (args[0] as Record<string, unknown> | undefined) : undefined;
            const id = input && typeof input.id === "string" ? input.id : null;
            const { result, event } = await audit.run(
              { tool: toolConfig.name, actor: describeActor(config, args[args.length - 1]), target: id },
              () => handler(...args),
            );
            const r = result as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (r && Array.isArray(r.content)) {
              r.content = [...r.content, { type: "text", text: `Audit: #${event.seq} ${event.hash.slice(0, 12)}` }];
            }
            return result;
          };
          return register.call(target, toolConfig, ...rest.slice(0, -1), audited);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
