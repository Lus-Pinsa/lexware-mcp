import { describe, expect, it, vi } from "vitest";
import { LexwareClient } from "../src/lexware/client.js";
import { ResponseTooLargeError, UnsafeRequestPathError } from "../src/lexware/errors.js";
import {
  FINANCE_READ_PATHS,
  assertReadPathAllowed,
  createReadOnlyLexwareClient,
} from "../src/lexware/read-only-client.js";

function spyClient() {
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`write method ${name} must never be reached`);
    });
  return {
    get: vi.fn(async () => ({ ok: true })),
    getBinary: vi.fn(async () => ({ data: Buffer.from("x"), contentType: "application/pdf" })),
    post: forbidden("post"),
    postMultipart: forbidden("postMultipart"),
    request: forbidden("request"),
  };
}

describe("createReadOnlyLexwareClient — GET-only facade", () => {
  it("exposes exactly get and getBinary, frozen, without a path to the full client", () => {
    const ro = createReadOnlyLexwareClient(spyClient() as unknown as LexwareClient);
    expect(Object.keys(ro).sort()).toEqual(["get", "getBinary"]);
    expect(Object.isFrozen(ro)).toBe(true);
    expect("post" in ro).toBe(false);
    expect("request" in ro).toBe(false);
    expect("postMultipart" in ro).toBe(false);
    expect(() => {
      (ro as unknown as Record<string, unknown>).post = () => undefined;
    }).toThrow();
  });

  it("forwards allowlisted reads", async () => {
    const c = spyClient();
    const ro = createReadOnlyLexwareClient(c as unknown as LexwareClient);
    await ro.get("/v1/voucherlist", { voucherType: "any" });
    await ro.get("/v1/vouchers/abc-1");
    await ro.getBinary("/v1/files/f-1", "application/pdf", { maxBytes: 10 });
    expect(c.get).toHaveBeenCalledWith("/v1/voucherlist", { voucherType: "any" });
    expect(c.get).toHaveBeenCalledWith("/v1/vouchers/abc-1", undefined);
    expect(c.getBinary).toHaveBeenCalledWith("/v1/files/f-1", "application/pdf", { maxBytes: 10 });
    expect(c.post).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
  });

  it.each([
    "/v1/articles",
    "/v1/voucherlistX",
    "/v1/vouchers-evil/1",
    "/v1/event-subscriptions",
    "/v1/files/../vouchers/1",
    "/v1/files/%2e%2e/vouchers",
    "/v1/files/%2E%2E",
    "/v1/files/./x",
    "/v1/files/a?x=1",
    "/v1/files/a#frag",
    "/v1/files/a\\b",
    "/v1/files//a",
    "v1/files/a",
    "",
  ])("rejects %j before any request is made", async (path) => {
    const c = spyClient();
    const ro = createReadOnlyLexwareClient(c as unknown as LexwareClient);
    await expect(ro.get(path)).rejects.toBeInstanceOf(UnsafeRequestPathError);
    await expect(ro.getBinary(path)).rejects.toBeInstanceOf(UnsafeRequestPathError);
    expect(c.get).not.toHaveBeenCalled();
    expect(c.getBinary).not.toHaveBeenCalled();
  });

  it("the default allowlist contains only read resources needed by the finance pipeline", () => {
    expect([...FINANCE_READ_PATHS].sort()).toEqual(
      [
        "/v1/contacts",
        "/v1/credit-notes",
        "/v1/down-payment-invoices",
        "/v1/files",
        "/v1/invoices",
        "/v1/payments",
        "/v1/posting-categories",
        "/v1/profile",
        "/v1/voucherlist",
        "/v1/vouchers",
      ].sort(),
    );
    expect(Object.isFrozen(FINANCE_READ_PATHS)).toBe(true);
    expect(() => assertReadPathAllowed("/v1/articles", ["/v1/articles"])).not.toThrow();
  });
});

function makeClient(fetchFn: typeof fetch) {
  return new LexwareClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetchFn,
    sleep: async () => undefined,
    maxRetries: 0,
  });
}

describe("LexwareClient — dot-segment guard", () => {
  it.each(["/v1/files/..", "/v1/files/%2e%2e", "/v1/files/.", "/v1/files/%2E", `/v1/files/${encodeURIComponent("..")}`])(
    "refuses %j without sending a request",
    async (path) => {
      const fetchFn = vi.fn();
      const client = makeClient(fetchFn as unknown as typeof fetch);
      await expect(client.get(path)).rejects.toBeInstanceOf(UnsafeRequestPathError);
      await expect(client.getBinary(path)).rejects.toBeInstanceOf(UnsafeRequestPathError);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("still allows dots inside a segment", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const client = makeClient(fetchFn as unknown as typeof fetch);
    await client.get("/v1/files/report.v2");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("LexwareClient.getBinary — size limit", () => {
  it("refuses a declared oversize body before reading it", async () => {
    const body = new ReadableStream({
      pull() {
        throw new Error("body must not be read");
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { headers: { "content-length": "11", "content-type": "application/pdf" } }));
    const err = await makeClient(fetchFn as unknown as typeof fetch)
      .getBinary("/v1/files/a", "application/pdf", { maxBytes: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err.declaredBytes).toBe(11);
  });

  it("aborts a streamed body as soon as it passes the limit (no content-length)", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(6));
        if (pulls > 100) controller.close();
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { headers: { "content-type": "application/pdf" } }));
    const err = await makeClient(fetchFn as unknown as typeof fetch)
      .getBinary("/v1/files/a", "application/pdf", { maxBytes: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err.declaredBytes).toBeNull();
    expect(pulls).toBeLessThan(5);
  });

  it("returns the exact bytes within the limit", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }));
    const { data, contentType } = await makeClient(fetchFn as unknown as typeof fetch).getBinary("/v1/files/a", "application/pdf", {
      maxBytes: 3,
    });
    expect([...data]).toEqual([1, 2, 3]);
    expect(contentType).toBe("application/pdf");
  });

  it("keeps the unlimited behaviour when no limit is given", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(50), { headers: { "content-type": "application/pdf" } }));
    const { data } = await makeClient(fetchFn as unknown as typeof fetch).getBinary("/v1/files/a");
    expect(data.length).toBe(50);
  });
});
