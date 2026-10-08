/**
 * The Lexware webhook receiver (`POST /webhooks/lexware`), as a factory so the complete request handling —
 * signature, validation, organization binding, queueing and log lines — is testable without starting the server.
 *
 * Order (fail closed): public key configured → signature header present → raw body → RSA-SHA512 signature over the
 * raw bytes → body validation and organization binding (`evaluateLexwareWebhook`) → queue.
 * Log lines carry no Lexware ids or dates (FINANCIAL per ai-company/security/data-classification.md), only fixed
 * reason codes and counts.
 */
import { createHash, createVerify } from "node:crypto";

import { evaluateLexwareWebhook } from "./lexware/webhook.js";

/** Minimal request/response surface (Express satisfies it). */
export interface WebhookRequest {
  readonly body: unknown;
  get(name: string): string | undefined;
}
export interface WebhookResponse {
  sendStatus(status: number): unknown;
}

export interface WebhookQueueResult {
  readonly added: boolean;
  readonly count: number;
  /** Events dropped from the queue to make room for this one. */
  readonly dropped: number;
}

export interface WebhookReceiverDeps {
  /** PEM public key, read per request so a rotated env value applies without restart in tests. */
  readonly getPublicKey: () => string | undefined;
  /** When set, events of any other Lexware organization are ignored. */
  readonly organizationId?: string;
  readonly enqueue: (event: {
    resourceId: string;
    eventDate: string;
    payloadChecksum: string;
  }) => Promise<WebhookQueueResult>;
  /** Total events dropped since start (for the overflow warning). */
  readonly droppedTotal: () => number;
  readonly log: (line: string) => void;
}

/** RSA-SHA512 over the exact raw bytes. Any error (malformed key or signature) means "not valid". */
export function verifyLexwareWebhookSignature(rawBody: Buffer, signatureBase64: string, publicKey: string): boolean {
  try {
    const verifier = createVerify("RSA-SHA512");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export function createLexwareWebhookHandler(
  deps: WebhookReceiverDeps,
): (req: WebhookRequest, res: WebhookResponse) => Promise<void> {
  return async (req, res) => {
    const publicKey = deps.getPublicKey();
    if (!publicKey) {
      deps.log("[lexware-webhook] LEXWARE_WEBHOOK_PUBLIC_KEY missing");
      res.sendStatus(503);
      return;
    }

    const signature = req.get("x-lxo-signature");
    if (!signature) {
      deps.log("[lexware-webhook] missing X-Lxo-Signature");
      res.sendStatus(401);
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      deps.log("[lexware-webhook] body is not raw Buffer");
      res.sendStatus(400);
      return;
    }
    const rawBody = req.body;

    if (!verifyLexwareWebhookSignature(rawBody, signature, publicKey)) {
      deps.log("[lexware-webhook] invalid signature");
      res.sendStatus(401);
      return;
    }

    // A valid signature proves Lexware signed it, not that it concerns OUR organization.
    const decision = evaluateLexwareWebhook(rawBody, deps.organizationId);

    if (decision.action === "reject") {
      deps.log(`[lexware-webhook] rejected reason=${decision.reason}`);
      res.sendStatus(400);
      return;
    }

    if (decision.action === "ignore") {
      // eventType passed a strict pattern; foreign organization ids and resource ids are never logged.
      deps.log(
        decision.reason === "foreign_organization"
          ? "[lexware-webhook] ignored reason=foreign_organization"
          : `[lexware-webhook] ignored reason=unsupported_event event=${decision.event.eventType}`,
      );
      res.sendStatus(204);
      return;
    }

    const payloadChecksum = createHash("sha256").update(rawBody).digest("hex");
    let pending: WebhookQueueResult;
    try {
      pending = await deps.enqueue({
        resourceId: decision.event.resourceId,
        eventDate: decision.event.eventDate,
        payloadChecksum,
      });
    } catch {
      // Returning 503 is deliberate: Lexware may retry; a verified event is
      // never acknowledged as accepted before the queue commit succeeds.
      deps.log("[lexware-webhook] queue unavailable");
      res.sendStatus(503);
      return;
    }

    deps.log(`[lexware-webhook] NEW VOUCHER pending=${pending.count} added=${pending.added}`);
    if (pending.dropped > 0) {
      deps.log(
        `[lexware-webhook] WARNING queue full: dropped ${pending.dropped} oldest event(s), ${deps.droppedTotal()} since start — run reconcile-recent-vouchers`,
      );
    }
    res.sendStatus(204);
  };
}
