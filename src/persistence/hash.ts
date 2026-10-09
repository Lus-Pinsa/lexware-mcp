import { createHash, createHmac } from "node:crypto";

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

/** Domain-separated SHA-256 for non-secret external identifiers. */
export function sha256Identifier(domain: string, value: string): string {
  const d = requireText(domain, "Hash domain");
  const v = requireText(value, "Identifier");
  return createHash("sha256").update(d, "utf8").update("\0").update(v, "utf8").digest("hex");
}

/**
 * Stable pseudonymous audit actor identifier.
 * The secret pepper lives in the platform secret store, never in the DB/repo.
 */
export function hmacActorHash(principal: string, pepper: Buffer): string {
  const p = requireText(principal, "Principal");
  if (pepper.length < 32) throw new Error("Audit actor pepper must be at least 32 bytes.");
  return createHmac("sha256", pepper).update("audit-actor\0", "utf8").update(p, "utf8").digest("hex");
}
