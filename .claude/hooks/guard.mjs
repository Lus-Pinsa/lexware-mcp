#!/usr/bin/env node
/**
 * LU'S AI-company PreToolUse guard (Claude Code hook).
 *
 * Technical safety gate that does not depend on prompts. Reads the hook payload
 * ({ tool_name, tool_input, ... }) from stdin and
 *   - exits 2 with a reason on stderr to BLOCK the tool call,
 *   - prints a JSON "ask" decision for actions that need a human click,
 *   - exits 0 silently to allow.
 *
 * Phase-1 rules (see ai-company/policies/security.md):
 *   1. No production finance writes through any Lexware MCP connector.
 *   2. No external publishing / messaging / payments / orders through MCP connectors.
 *   3. No merge, no push to main/master, no force push, no branch-protection/secret changes.
 *   4. No reading/printing secrets (.env files, secret env vars).
 *   5. No direct calls to the Lexware or Render APIs (bypassing the reviewed MCP tools).
 *   6. No edits to safety-gate files unless a human set AI_COMPANY_GATE_MAINTENANCE=1
 *      in the session environment.
 * Malformed input fails closed.
 */
import { readFileSync } from "node:fs";

const PROTECTED_PATH = /(^|[\s/'"=])(\.claude\/settings(\.local)?\.json|\.claude\/hooks\/|\.github\/workflows\/|CODEOWNERS)(\b|$)/;
const ENV_FILE = /(^|[\s/'"=<>])\.env(?!\.example)(\.[\w-]+)?(?=$|[\s'";&|)<>])/;
const SECRET_VARS = /\$\{?(LEXWARE_API_KEY|MCP_AUTH_TOKEN|LEXWARE_WEBHOOK_PUBLIC_KEY|RENDER_API_KEY|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OAUTH_CLIENT_SECRET)\b/;
const LEXWARE_WRITE_TOOL = /^(create|update|upload|delete|ensure|finalize|book|pay)/i;
const EXTERNAL_ACTION_VERB = /(^|[_-])(send|publish|post|pay|payment|transfer|order|purchase|checkout|buy)([_-]|$)/i;
const ORCHESTRATION_SERVERS = new Set(["github", "claude-code-remote"]);

function block(reason) {
  process.stderr.write(`BLOCKED by AI-company guard: ${reason}\n`);
  process.exit(2);
}

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

function checkMcp(toolName, input) {
  const [, server = "", ...rest] = toolName.split("__");
  const tool = rest.join("__");

  if (/lexware|lexoffice/i.test(server)) {
    if (/^acknowledge-voucher-event$/i.test(tool)) {
      ask("acknowledge-voucher-event removes an item from the pending queue — owner approval required in Phase 1.");
    }
    if (LEXWARE_WRITE_TOOL.test(tool)) {
      block(`"${tool}" writes to production Lexware. Finance writes are disabled in Phase 1 (policy: finance-write-gates.md).`);
    }
    return;
  }

  if (server.toLowerCase() === "github") {
    if (/^(merge_pull_request|enable_pr_auto_merge)$/.test(tool)) block("merging is reserved for the owner.");
    if (/^(create_or_update_file|push_files|delete_file)$/.test(tool)) {
      const branch = String(input.branch ?? "");
      if (/^(main|master)$/.test(branch) || branch === "") block(`direct write to "${branch || "default branch"}" — use a feature branch + PR.`);
    }
    return;
  }

  if (!ORCHESTRATION_SERVERS.has(server.toLowerCase()) && EXTERNAL_ACTION_VERB.test(tool)) {
    block(`"${toolName}" looks like an external publish/send/payment/order action — not allowed in Phase 1.`);
  }
}

function checkBash(command, env) {
  const cmd = String(command);
  if (/\bgit\s+push\b/.test(cmd)) {
    if (/\s(--force(?!-with-lease)|-f)(\s|$)/.test(cmd) || /\s--mirror\b/.test(cmd) || /\s\+[\w./-]+/.test(cmd)) {
      block("force/mirror push is forbidden.");
    }
    if (/\s(--delete|-d)\s/.test(cmd) && /\b(main|master)\b/.test(cmd)) block("deleting main/master is forbidden.");
    if (/\s([\w./-]+:)?(refs\/heads\/)?(main|master)(\s|$)/.test(cmd)) block("direct push to main/master is forbidden — open a PR.");
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) block("merging is reserved for the owner.");
  if (/\bgh\s+(secret|ruleset|variable)\b/.test(cmd) || /\bgh\s+api\b.*(protection|rulesets|secrets)/.test(cmd)) {
    block("changing repository secrets/rulesets/branch protection is reserved for the owner.");
  }
  if (/\bprintenv\b/.test(cmd) || /(^|[;&|(]\s*)(env|export\s+-p|set)\s*($|[;&|)>])/.test(cmd) || SECRET_VARS.test(cmd)) {
    block("printing environment secrets is forbidden.");
  }
  if (ENV_FILE.test(cmd)) block(".env files may contain secrets and are off-limits.");
  if (/api\.(lexware|lexoffice)\.io/i.test(cmd)) block("direct Lexware API calls bypass the reviewed MCP tools.");
  if (/api\.render\.com/i.test(cmd) || /\brender\s+(deploys?|services|env|restart)\b/.test(cmd)) {
    block("Render production changes are reserved for the owner.");
  }
  if (PROTECTED_PATH.test(cmd) && /(\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bchmod\b|\bperl\s+-p?i|\bpython3?\b|>)/.test(cmd)) {
    if (env.AI_COMPANY_GATE_MAINTENANCE !== "1") block("modifying safety-gate files (settings/hooks/workflows/CODEOWNERS) requires owner-approved maintenance.");
  }
}

function checkFile(toolName, input, env) {
  const path = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  if (ENV_FILE.test(` ${path}`)) block(".env files may contain secrets and are off-limits.");
  if (toolName !== "Read" && PROTECTED_PATH.test(` ${path}`) && env.AI_COMPANY_GATE_MAINTENANCE !== "1") {
    block(`"${path}" is a safety-gate file; changes require owner-approved maintenance (AI_COMPANY_GATE_MAINTENANCE=1).`);
  }
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  block("could not parse hook input (fail closed).");
}
if (!payload || typeof payload.tool_name !== "string") block("hook input has no tool_name (fail closed).");

const toolName = payload.tool_name;
const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

if (toolName.startsWith("mcp__")) checkMcp(toolName, input);
else if (toolName === "Bash") checkBash(input.command ?? "", process.env);
else if (["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"].includes(toolName)) checkFile(toolName, input, process.env);

process.exit(0);
