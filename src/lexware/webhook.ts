/**
 * Validation of a Lexware webhook body AFTER its signature was verified.
 *
 * A valid signature proves the body was signed by Lexware — not that it is about OUR organization: any Lexware
 * customer can subscribe their own organization to a public callback URL. So the body is still untrusted input:
 * shape, types and lengths are checked before anything is queued or logged, and (when configured) the
 * `organizationId` must match. Pure; no I/O.
 */
import { ORGANIZATION_ID_PATTERN } from "../config.js";

/** Lexware resource ids (UUIDs in practice); bounded so a signed body cannot flood queue or logs. */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
/**
 * Date-time as Lexware sends it (e.g. `2026-10-07T10:00:00.000+02:00`). Deliberately loose about the time part
 * (an unexpected but harmless variant must not drop a real event); it only bounds length and characters.
 */
const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]{0,30})?$/;

export interface LexwareWebhookEvent {
  readonly organizationId: string;
  readonly eventType: string;
  readonly resourceId: string;
  readonly eventDate: string;
}

export type WebhookDecision =
  | { readonly action: "accept"; readonly event: LexwareWebhookEvent }
  /** Acknowledge (2xx) but do not process: well-formed, just not for us. */
  | { readonly action: "ignore"; readonly reason: "foreign_organization" | "unsupported_event"; readonly event: LexwareWebhookEvent }
  /** Malformed: answer 400. `reason` is a fixed code, never echoed input. */
  | { readonly action: "reject"; readonly reason: "invalid_json" | "invalid_shape" };

/** Event types this server processes. */
export const SUPPORTED_WEBHOOK_EVENTS: ReadonlySet<string> = new Set(["voucher.created"]);

/**
 * Decide what to do with a signature-verified webhook body.
 *
 * @param rawBody - the exact bytes whose signature was verified
 * @param expectedOrganizationId - when set, events of any other organization are ignored
 */
export function evaluateLexwareWebhook(rawBody: Buffer, expectedOrganizationId?: string): WebhookDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { action: "reject", reason: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "reject", reason: "invalid_shape" };

  const body = parsed as Record<string, unknown>;
  const { organizationId, eventType, resourceId, eventDate } = body;
  if (
    typeof organizationId !== "string" ||
    typeof eventType !== "string" ||
    typeof resourceId !== "string" ||
    typeof eventDate !== "string" ||
    !ORGANIZATION_ID_PATTERN.test(organizationId) ||
    !EVENT_TYPE_PATTERN.test(eventType) ||
    !RESOURCE_ID_PATTERN.test(resourceId) ||
    !EVENT_DATE_PATTERN.test(eventDate)
  ) {
    return { action: "reject", reason: "invalid_shape" };
  }

  const event: LexwareWebhookEvent = { organizationId, eventType, resourceId, eventDate };
  if (expectedOrganizationId !== undefined && organizationId.toLowerCase() !== expectedOrganizationId.toLowerCase()) {
    return { action: "ignore", reason: "foreign_organization", event };
  }
  if (!SUPPORTED_WEBHOOK_EVENTS.has(eventType)) return { action: "ignore", reason: "unsupported_event", event };
  return { action: "accept", event };
}
