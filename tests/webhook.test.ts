import { describe, expect, it } from "vitest";
import { evaluateLexwareWebhook } from "../src/lexware/webhook.js";
import {
  MAX_PENDING_VOUCHER_EVENTS,
  addPendingVoucherEvent,
  droppedPendingVoucherEvents,
  listPendingVoucherEvents,
} from "../src/pending-voucher-events.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000bb";
const RESOURCE = "00000000-0000-4000-8000-0000000000c1";

const body = (payload: unknown): Buffer => Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
const event = (patch: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  eventType: "voucher.created",
  resourceId: RESOURCE,
  eventDate: "2026-10-07T10:00:00.000+02:00",
  ...patch,
});

describe("evaluateLexwareWebhook (after signature verification)", () => {
  it("accepts a well-formed voucher.created event of the expected organization", () => {
    expect(evaluateLexwareWebhook(body(event()), ORG)).toEqual({ action: "accept", event: event() });
    expect(evaluateLexwareWebhook(body(event({ organizationId: ORG.toUpperCase() })), ORG).action).toBe("accept");
  });

  it("accepts any organization only when no binding is configured", () => {
    expect(evaluateLexwareWebhook(body(event({ organizationId: OTHER_ORG })), undefined).action).toBe("accept");
  });

  it("ignores events of a foreign organization when a binding is configured", () => {
    const d = evaluateLexwareWebhook(body(event({ organizationId: OTHER_ORG })), ORG);
    expect(d).toMatchObject({ action: "ignore", reason: "foreign_organization" });
  });

  it("ignores unsupported event types (well-formed)", () => {
    expect(evaluateLexwareWebhook(body(event({ eventType: "contact.changed" })), ORG)).toMatchObject({
      action: "ignore",
      reason: "unsupported_event",
    });
  });

  it("checks the organization before the event type, so foreign events never reach type-specific logging", () => {
    const d = evaluateLexwareWebhook(body(event({ organizationId: OTHER_ORG, eventType: "contact.changed" })), ORG);
    expect(d).toMatchObject({ action: "ignore", reason: "foreign_organization" });
  });

  it.each([
    ["invalid JSON", "{bad", "invalid_json"],
    ["null body", "null", "invalid_shape"],
    ["array body", "[]", "invalid_shape"],
    ["string body", '"x"', "invalid_shape"],
    ["number body", "1", "invalid_shape"],
  ])("rejects %s", (_label, raw, reason) => {
    expect(evaluateLexwareWebhook(body(raw), ORG)).toEqual({ action: "reject", reason });
  });

  it.each([
    ["missing organizationId", { organizationId: undefined }],
    ["missing resourceId", { resourceId: undefined }],
    ["missing eventDate", { eventDate: undefined }],
    ["missing eventType", { eventType: undefined }],
    ["non-string resourceId", { resourceId: { $gt: "" } }],
    ["numeric organizationId", { organizationId: 42 }],
    ["array eventType", { eventType: ["voucher.created"] }],
    ["oversized resourceId", { resourceId: "a".repeat(129) }],
    ["newline in resourceId (log forging)", { resourceId: `${RESOURCE}\n[lexware-webhook] NEW VOUCHER resourceId=x` }],
    ["path characters in resourceId", { resourceId: "../../v1/contacts" }],
    ["newline in eventDate", { eventDate: "2026-10-07\nforged" }],
    ["free text eventDate", { eventDate: "yesterday" }],
    ["oversized eventDate", { eventDate: `2026-10-07T${"0".repeat(40)}` }],
    ["markup in eventType", { eventType: "<script>" }],
    ["control character in organizationId", { organizationId: `${ORG}\u0000` }],
    ["empty strings", { organizationId: "", resourceId: "", eventDate: "", eventType: "" }],
  ])("rejects %s with a fixed reason code (input never echoed)", (_label, patch) => {
    const d = evaluateLexwareWebhook(body(event(patch)), ORG);
    expect(d).toEqual({ action: "reject", reason: "invalid_shape" });
  });

  it("accepts realistic date-time variants", () => {
    for (const eventDate of ["2026-10-07T10:00:00.000+02:00", "2026-10-07T08:00:00Z", "2026-10-07T10:00:00+0200", "2026-10-07"]) {
      expect(evaluateLexwareWebhook(body(event({ eventDate })), ORG).action).toBe("accept");
    }
  });
});

describe("pending voucher event queue bound", () => {
  it("never grows beyond its cap and drops the oldest events first", () => {
    const before = droppedPendingVoucherEvents();
    const total = MAX_PENDING_VOUCHER_EVENTS + 25;
    for (let i = 0; i < total; i++) {
      addPendingVoucherEvent({ resourceId: `cap-${String(i).padStart(5, "0")}`, eventDate: "2026-10-07T10:00:00.000Z" });
    }
    const list = listPendingVoucherEvents();
    expect(list.length).toBe(MAX_PENDING_VOUCHER_EVENTS);
    expect(droppedPendingVoucherEvents() - before).toBeGreaterThanOrEqual(25);
    const ids = new Set(list.map((e) => e.resourceId));
    expect(ids.has(`cap-${String(total - 1).padStart(5, "0")}`)).toBe(true);
    expect(ids.has("cap-00000")).toBe(false);
  });

  it("deduplicates a redelivered event without counting it twice", () => {
    const first = addPendingVoucherEvent({ resourceId: "dup-1", eventDate: "2026-10-07T10:00:00.000Z" });
    const again = addPendingVoucherEvent({ resourceId: "dup-1", eventDate: "2026-10-07T10:00:00.000Z" });
    expect(first.added).toBe(true);
    expect(again.added).toBe(false);
    expect(again.count).toBe(first.count);
  });
});
