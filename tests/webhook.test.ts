import { describe, expect, it } from "vitest";
import type { McpServer } from "skybridge/server";
import { evaluateLexwareWebhook } from "../src/lexware/webhook.js";
import { registerPendingVoucherEventReadTools } from "../src/tools/pending-voucher-events.js";
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

  // One field changed at a time, so a widened pattern for a single field cannot hide behind another field.
  const SINGLE_FIELD_BAD: ReadonlyArray<unknown> = [
    "",
    " ",
    "\n",
    "a b",
    "a<b",
    "a/b",
    "a\\b",
    "a\nb",
    "a\rb",
    "a\u2028b",
    "a\u0000b",
    ["x"],
    { x: 1 },
    1,
    true,
    null,
  ];
  for (const field of ["organizationId", "resourceId", "eventType", "eventDate"] as const) {
    it(`rejects every malformed single-field value of ${field}`, () => {
      for (const value of SINGLE_FIELD_BAD) {
        expect(evaluateLexwareWebhook(body(event({ [field]: value })), ORG), `${field}=${JSON.stringify(value)}`).toEqual({
          action: "reject",
          reason: "invalid_shape",
        });
      }
    });
  }

  it("rejects prefix and suffix garbage around otherwise valid values (anchored patterns)", () => {
    const cases: Array<[string, string]> = [
      ["resourceId", `x ${RESOURCE}`],
      ["resourceId", `${RESOURCE} x`],
      ["resourceId", `${RESOURCE}.x`],
      ["eventType", "Voucher.created"],
      ["eventType", "1voucher.created"],
      ["eventType", "voucher.created\n"],
      ["eventType", " voucher.created"],
      ["eventType", "voucher.created<"],
      ["eventType", "voucher.Created"],
      ["eventDate", "x2026-10-07T10:00:00Z"],
      ["eventDate", "2026-10-07T10:00:00Zx"],
      ["eventDate", "2026-10-07T10:00:00Z\n"],
      ["eventDate", "2026-10-07Tab"],
      ["eventDate", "2026-10-07\nT10:00"],
      ["organizationId", `${ORG} `],
      ["organizationId", `${ORG}_x`],
      ["organizationId", `${ORG}.x`],
    ];
    for (const [field, value] of cases) {
      expect(evaluateLexwareWebhook(body(event({ [field]: value })), ORG).action, `${field}=${JSON.stringify(value)}`).toBe("reject");
    }
  });

  it("enforces exact length bounds per field", () => {
    expect(evaluateLexwareWebhook(body(event({ resourceId: "a".repeat(128) })), ORG).action).toBe("accept");
    expect(evaluateLexwareWebhook(body(event({ resourceId: "a".repeat(129) })), ORG).action).toBe("reject");
    expect(evaluateLexwareWebhook(body(event({ resourceId: "a" })), ORG).action).toBe("accept");
    expect(evaluateLexwareWebhook(body(event({ eventType: `v${"a".repeat(63)}` })), ORG).action).toBe("ignore");
    expect(evaluateLexwareWebhook(body(event({ eventType: `v${"a".repeat(64)}` })), ORG).action).toBe("reject");
    expect(evaluateLexwareWebhook(body(event({ eventDate: `2026-10-07T${"0".repeat(30)}` })), ORG).action).toBe("accept");
    expect(evaluateLexwareWebhook(body(event({ eventDate: `2026-10-07T${"0".repeat(31)}` })), ORG).action).toBe("reject");
    const org64 = "a".repeat(64);
    expect(evaluateLexwareWebhook(body(event({ organizationId: org64 })), org64).action).toBe("accept");
    expect(evaluateLexwareWebhook(body(event({ organizationId: "a".repeat(65) })), undefined).action).toBe("reject");
  });

  it("binds the organization by full, case-insensitive equality only", () => {
    // An event id that extends or truncates the configured id is foreign.
    expect(evaluateLexwareWebhook(body(event({ organizationId: `${ORG}0` })), ORG).action).toBe("ignore");
    expect(evaluateLexwareWebhook(body(event({ organizationId: ORG.slice(0, -1) })), ORG).action).toBe("ignore");
    // A configured id in upper case still matches the lower-case event id.
    expect(evaluateLexwareWebhook(body(event()), ORG.toUpperCase()).action).toBe("accept");
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
    expect(MAX_PENDING_VOUCHER_EVENTS).toBe(1000);
    expect(list.length).toBe(MAX_PENDING_VOUCHER_EVENTS);
    expect(droppedPendingVoucherEvents() - before).toBe(25);
    const ids = new Set(list.map((e) => e.resourceId));
    expect(ids.has(`cap-${String(total - 1).padStart(5, "0")}`)).toBe(true);
    expect(ids.has("cap-00000")).toBe(false);
  });

  it("deduplicates a redelivered event without counting it twice", () => {
    const first = addPendingVoucherEvent({ resourceId: "dup-1", eventDate: "2026-10-07T10:00:00.000Z" });
    const droppedBefore = droppedPendingVoucherEvents();
    const again = addPendingVoucherEvent({ resourceId: "dup-1", eventDate: "2026-10-07T10:00:00.000Z" });
    expect(first.added).toBe(true);
    // The queue is full here, so the first insert had to drop exactly one event; a duplicate drops none.
    expect(first.dropped).toBe(1);
    expect(again.added).toBe(false);
    expect(again.dropped).toBe(0);
    expect(droppedPendingVoucherEvents()).toBe(droppedBefore);
    expect(again.count).toBe(first.count);
  });
});

describe("get-pending-voucher-events reports an incomplete queue", () => {
  it("states the number of dropped events and points to reconcile-recent-vouchers", async () => {
    let handler: (() => Promise<{ structuredContent: { droppedSinceStart: number }; content: Array<{ text: string }> }>) | undefined;
    const server = {
      registerTool(cfg: { name: string }, h: typeof handler) {
        if (cfg.name === "get-pending-voucher-events") handler = h;
        return server;
      },
    } as unknown as McpServer;
    registerPendingVoucherEventReadTools(server);
    // Earlier tests in this file overflowed the queue.
    const res = await handler!();
    expect(res.structuredContent.droppedSinceStart).toBe(droppedPendingVoucherEvents());
    expect(res.structuredContent.droppedSinceStart).toBeGreaterThan(0);
    expect(res.content[0].text).toContain("incomplete");
    expect(res.content[0].text).toContain("reconcile-recent-vouchers");
  });
});

