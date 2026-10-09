import { createHash } from "node:crypto";

import { encryptString, type EncryptionKey } from "./crypto.js";
import { sha256Identifier } from "./hash.js";
import type { PersistenceRepository } from "./repository.js";
import type { RequestBudgetStatus, TenantId } from "./types.js";

export interface VerifiedVoucherEventInput {
  organizationId: string;
  resourceId: string;
  eventDate: string;
  rawBody: Buffer;
  requestBudgetStatus?: RequestBudgetStatus;
}

export interface DurableWebhookQueueDeps {
  tenantId: TenantId;
  encryptionKey: EncryptionKey;
  repository: PersistenceRepository;
  now?: () => Date;
}

function payloadSha256(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Persist one already signature-verified and organization-validated
 * voucher.created event without storing raw Lexware identifiers in plaintext.
 *
 * This function does not verify webhook signatures. It belongs strictly after
 * the existing webhook verification/binding boundary.
 */
export async function enqueueVerifiedVoucherEvent(
  input: VerifiedVoucherEventInput,
  deps: DurableWebhookQueueDeps,
): Promise<"inserted" | "duplicate"> {
  const eventKeyHash = sha256Identifier(
    "lexware-webhook-event",
    ["voucher.created", input.resourceId, input.eventDate].join("\0"),
  );
  const organizationHash = sha256Identifier(
    "lexware-organization",
    input.organizationId,
  );
  const aad = ["lus-webhook-resource-v1", deps.tenantId, eventKeyHash].join(":");
  const encrypted = encryptString(input.resourceId, deps.encryptionKey, aad);
  const receivedAt = (deps.now ?? (() => new Date()))().toISOString();

  return deps.repository.insertWebhookEvent(deps.tenantId, {
    eventKeyHash,
    organizationHash,
    resourceIdCiphertext: encrypted.ciphertext,
    resourceIdNonce: encrypted.nonce,
    resourceIdAuthTag: encrypted.authTag,
    resourceIdKeyId: encrypted.keyId,
    eventType: "voucher.created",
    receivedAt,
    acknowledgedAt: null,
    payloadSha256: payloadSha256(input.rawBody),
    source: "lexware-webhook",
    quality: "STRUCTURED",
    requestBudgetStatus: input.requestBudgetStatus ?? "OK",
  });
}

/** AAD must be reconstructed exactly when reading an encrypted resource id. */
export function webhookResourceAad(
  tenantId: TenantId,
  eventKeyHash: string,
): string {
  return ["lus-webhook-resource-v1", tenantId, eventKeyHash].join(":");
}
