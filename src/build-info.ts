/**
 * Server identity and build provenance, shared by the MCP server and the `get-server-info` tool.
 *
 * The build SHA comes from the deployment environment (Render sets RENDER_GIT_COMMIT for Git-based
 * services). Only a well-formed hex commit id is ever reported; anything else is UNKNOWN or
 * INVALID_FORMAT and the raw value is never echoed.
 */

export const SERVER_NAME = "lexware-office";
export const SERVER_VERSION = "0.1.7";

/** Environment variables checked, in order, for the deployed commit. */
export const BUILD_SHA_ENV_VARS = ["RENDER_GIT_COMMIT", "SOURCE_COMMIT", "GIT_COMMIT_SHA"] as const;

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export interface BuildInfo {
  readonly sha: string | null;
  readonly shaSource: (typeof BUILD_SHA_ENV_VARS)[number] | null;
  readonly status: "KNOWN" | "UNKNOWN" | "INVALID_FORMAT";
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv): BuildInfo {
  for (const name of BUILD_SHA_ENV_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    return SHA_PATTERN.test(value)
      ? { sha: value.toLowerCase(), shaSource: name, status: "KNOWN" }
      : { sha: null, shaSource: name, status: "INVALID_FORMAT" };
  }
  return { sha: null, shaSource: null, status: "UNKNOWN" };
}

/** Process start, captured once at module load (used for uptime reporting). */
export const PROCESS_STARTED_AT = new Date();
