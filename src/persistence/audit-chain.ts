import { createHash } from "node:crypto";
import type { AuditEventInput } from "./types.js";

export interface AuditChainInput extends AuditEventInput {
  occurredAt: string;
  previousHash: string | null;
}

function field(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return `${Buffer.byteLength(text, "utf8")}:${text}`;
}

/**
 * Canonical, content-minimized hash for append-only audit tamper evidence.
 * It intentionally accepts only the structured audit fields from the contract.
 */
export function hashAuditEntry(input: AuditChainInput): string {
  const canonical = [
    field(input.previousHash),
    field(input.tenantId),
    field(input.actorHash),
    field(input.action),
    field(input.result),
    field(input.count),
    field(input.occurredAt),
  ].join("|");
  return createHash("sha256").update("lus-persistence-audit-v1\0", "utf8").update(canonical, "utf8").digest("hex");
}
