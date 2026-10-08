#!/usr/bin/env node
/**
 * Dependency-free secret & business-data scanner for this PUBLIC repository.
 *
 * Scans every git-tracked text file (or the files given as arguments) for high-signal
 * credential patterns and for business data that must never be published (IBANs, German VAT
 * IDs, private keys, filled-in secret env assignments). Exits 1 on any finding.
 *
 * Usage: node ai-company/scripts/secret-scan.mjs [files...]
 * Allow a reviewed false positive by adding `secret-scan:allow` on the same line.
 */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

export const RULES = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "render-api-key", re: /\brnd_[A-Za-z0-9]{20,}\b/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "render-deploy-hook", re: /\bapi\.render\.com\/deploy\/srv-[A-Za-z0-9]+\?key=[A-Za-z0-9_-]{8,}/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-live-key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Credentials embedded in a URL authority, i.e. user and secret before the host (DB, proxy, git remotes).
  // Bounded scheme and a cheap pre-filter keep this linear (an unbounded scheme backtracks quadratically).
  { id: "url-credentials", re: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/'"]{1,256}:[^\s@/'"]{6,256}@[^\s/'"]+/i, pre: "://" },
  { id: "bearer-literal", re: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/ },
  {
    id: "filled-secret-env",
    re: /^\s*(?:export\s+)?(?:LEXWARE_API_KEY|MCP_AUTH_TOKEN|RENDER_API_KEY|ANTHROPIC_API_KEY|OAUTH_CLIENT_SECRET|DATABASE_URL|DB_PASSWORD|ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY|WHATSAPP_TOKEN|GITHUB_TOKEN)\s*=\s*['"]?[A-Za-z0-9_\-./+=:@]{12,}/,
  },
  { id: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/, validate: isValidIban },
  { id: "german-vat-id", re: /\bDE ?\d{9}\b/ },
];

const SKIP = [/^package-lock\.json$/, /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|zip|gz)$/i];

function isValidIban(raw) {
  const iban = raw.replace(/ /g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function scanText(file, text) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("secret-scan:allow")) return;
    for (const rule of RULES) {
      if (rule.pre && !line.includes(rule.pre)) continue;
      const m = rule.re.exec(line);
      if (m && (!rule.validate || rule.validate(m[0]))) findings.push({ file, line: i + 1, rule: rule.id });
    }
  });
  return findings;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : trackedFiles();
  const findings = [];
  for (const file of files) {
    if (SKIP.some((re) => re.test(file))) continue;
    let fd;
    try {
      // Size check and read go through the same descriptor (no check-then-use race).
      fd = openSync(file, "r");
      if (fstatSync(fd).size > 2_000_000) continue;
      findings.push(...scanText(file, readFileSync(fd, "utf8")));
    } catch {
      // deleted or unreadable file — nothing to scan
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}`); // never print the matched value
  console.error(`secret-scan: ${files.length} file(s) scanned, ${findings.length} finding(s).`);
  process.exit(findings.length > 0 ? 1 : 0);
}
