import type { McpServer } from "skybridge/server";

import { type BuildInfo, SERVER_NAME, SERVER_VERSION, resolveBuildInfo } from "../build-info.js";
import type { Config } from "../config.js";
import { LOCAL_RO, text } from "./shared.js";

/** One registered tool as seen by `registerTools` (name + whether it is annotated read-only). */
export interface RegisteredToolInfo {
  readonly name: string;
  readonly readOnly: boolean;
}

export interface ServerRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly startedAt: Date;
  readonly now?: () => Date;
}

/**
 * Wrap the MCP server so every `registerTool` call is recorded. Only `registerTool` is intercepted; all other
 * members are forwarded to the real server (bound to it, so private state keeps working).
 */
export function trackToolRegistrations(server: McpServer, sink: RegisteredToolInfo[]): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (config: { name: string; annotations?: { readOnlyHint?: boolean } }, ...rest: unknown[]) => {
          sink.push({ name: config.name, readOnly: config.annotations?.readOnlyHint === true });
          return (target.registerTool as (...args: unknown[]) => unknown).call(target, config, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface ServerInfo {
  readonly mode: "read-only-introspection";
  readonly server: { readonly name: string; readonly version: string };
  readonly build: BuildInfo;
  readonly capabilities: {
    readonly tiers: ReadonlyArray<"read" | "drafts" | "finalize">;
    readonly effectiveReadOnly: boolean;
  };
  readonly tools: {
    readonly registeredCount: number;
    readonly names: ReadonlyArray<string>;
    /** Registered tools NOT annotated read-only (empty in read-only mode). */
    readonly writeCapable: ReadonlyArray<string>;
  };
  readonly auth: {
    readonly mode: "oauth" | "static" | "none";
    /** Number of configured OAuth email-domain allowlist entries (values are not disclosed); null outside OAuth. */
    readonly oauthEmailDomainAllowlistEntries: number | null;
  };
  /** `organizationBindingConfigured`: webhooks of other Lexware organizations are ignored (id not disclosed). */
  readonly webhook: { readonly publicKeyConfigured: boolean; readonly organizationBindingConfigured: boolean };
  readonly runtime: { readonly nodeVersion: string; readonly startedAt: string; readonly uptimeSeconds: number };
  readonly secretsIncluded: false;
}

/** Build the server-info payload. Contains no secrets: only presence flags, counts, names and versions. */
export function buildServerInfo(
  config: Config,
  tools: ReadonlyArray<RegisteredToolInfo>,
  runtime: ServerRuntime,
): ServerInfo {
  const tiers: Array<"read" | "drafts" | "finalize"> = ["read"];
  if (config.capabilities.drafts) tiers.push("drafts");
  if (config.capabilities.finalize) tiers.push("finalize");
  const names = [...new Set(tools.map((t) => t.name))].sort();
  const writeCapable = [...new Set(tools.filter((t) => !t.readOnly).map((t) => t.name))].sort();
  const now = (runtime.now ?? (() => new Date()))();
  return {
    mode: "read-only-introspection",
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    build: resolveBuildInfo(runtime.env),
    capabilities: { tiers, effectiveReadOnly: !config.capabilities.drafts && !config.capabilities.finalize },
    tools: { registeredCount: names.length, names, writeCapable },
    auth: {
      mode: config.auth.mode,
      oauthEmailDomainAllowlistEntries: config.auth.mode === "oauth" ? config.auth.allowedEmailDomains.length : null,
    },
    webhook: {
      publicKeyConfigured: Boolean(runtime.env.LEXWARE_WEBHOOK_PUBLIC_KEY?.trim()),
      organizationBindingConfigured: config.webhookOrganizationId !== undefined,
    },
    runtime: {
      nodeVersion: process.version,
      startedAt: runtime.startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - runtime.startedAt.getTime()) / 1000)),
    },
    secretsIncluded: false,
  };
}

/**
 * `get-server-info`: purely local, read-only introspection. Answers "which build, which tiers, which tools
 * is this server really exposing?" — e.g. to tell a stale client tool list from a misconfigured deployment.
 * It does not call Lexware.
 */
export function registerServerInfoTool(
  server: McpServer,
  config: Config,
  registered: () => ReadonlyArray<RegisteredToolInfo>,
  runtime: ServerRuntime,
): void {
  server.registerTool(
    {
      name: "get-server-info",
      description:
        "READ-ONLY, local: report this MCP server's build commit, active capability tiers, and the exact list " +
        "and count of registered tools (incl. which are write-capable). Use it to verify what a deployment " +
        "really exposes. Never returns secrets and does not call Lexware.",
      annotations: LOCAL_RO,
    },
    async () => {
      const info = buildServerInfo(config, registered(), runtime);
      const summary = [
        `server: ${info.server.name} ${info.server.version}`,
        `build: ${info.build.sha ?? info.build.status}`,
        `tiers: [${info.capabilities.tiers.join(", ")}] effectiveReadOnly=${info.capabilities.effectiveReadOnly}`,
        `registered tools: ${info.tools.registeredCount} (write-capable: ${info.tools.writeCapable.length})`,
      ].join("\n");
      return { structuredContent: info as unknown as Record<string, unknown>, content: text(summary) };
    },
  );
}
