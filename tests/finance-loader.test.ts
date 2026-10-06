import { describe, expect, it, vi } from "vitest";
import { loadFinanceSnapshot } from "../src/finance/loader.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import type { PdfTextExtractor } from "../src/lexware/file-inspection.js";
import { FINANCE_READ_PATHS, createReadOnlyLexwareClient } from "../src/lexware/read-only-client.js";
import {
  id,
  invoiceDetail,
  invoicePayment,
  invoiceRow,
  page,
  paidDetail,
  paidPayment,
  paidRow,
  postingCategories,
  quotationRow,
  uncheckedDetail,
  uncheckedRow,
  uncheckedRowWithoutAmount,
} from "./fixtures/finance-fixtures.js";

type Route = (path: string, query?: Record<string, unknown>) => unknown;

/** A full fake client whose write methods throw; wrapped in the real GET-only facade like production. */
function fakeLexware(route: Route, binary?: (path: string) => { data: Buffer; contentType: string }) {
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`write method ${name} must never be called by the finance loader`);
    });
  const raw = {
    get: vi.fn(async (path: string, query?: Record<string, unknown>) => {
      calls.push({ path, query });
      const out = route(path, query);
      if (out instanceof Error) throw out;
      return out;
    }),
    getBinary: vi.fn(async (path: string) => {
      calls.push({ path });
      if (!binary) throw new Error("no binary route");
      return binary(path);
    }),
    post: forbidden("post"),
    postMultipart: forbidden("postMultipart"),
    request: forbidden("request"),
  };
  const client = createReadOnlyLexwareClient(raw as unknown as LexwareClient);
  return { client, raw, calls };
}

const WINDOW = { from: "2026-09-01", to: "2026-10-31", basis: "voucherDate" as const };
const NOW = () => new Date("2026-10-06T18:00:00.000Z");

function standardRoute(rows: unknown[]): Route {
  return (path) => {
    if (path === "/v1/voucherlist") return page(rows);
    if (path === "/v1/posting-categories") return postingCategories();
    if (path === `/v1/vouchers/${id(2)}`) return uncheckedDetail(2);
    if (path === `/v1/vouchers/${id(3)}`) return paidDetail(3);
    if (path === `/v1/vouchers/${id(1)}`) return uncheckedDetail(1, { voucherNumber: "TEST-INV-0001", totalGrossAmount: undefined });
    if (path === `/v1/invoices/${id(4)}`) return invoiceDetail(4);
    if (path === `/v1/payments/${id(3)}`) return paidPayment();
    if (path === `/v1/payments/${id(4)}`) return invoicePayment();
    return new LexwareApiError(404, `unexpected path ${path}`);
  };
}

describe("loadFinanceSnapshot — read-only, budgeted, honest about completeness", () => {
  it("loads, enriches and normalizes a window using only allowlisted GETs", async () => {
    const rows = [uncheckedRowWithoutAmount(1), uncheckedRow(2), paidRow(3), invoiceRow(4), quotationRow(5)];
    const { client, raw, calls } = fakeLexware(standardRoute(rows));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW });

    expect(raw.post).not.toHaveBeenCalled();
    expect(raw.postMultipart).not.toHaveBeenCalled();
    expect(raw.request).not.toHaveBeenCalled();
    for (const c of calls) expect(FINANCE_READ_PATHS.some((p) => c.path === p || c.path.startsWith(`${p}/`))).toBe(true);

    // 1 list + 1 categories + 4 details (quotation needs none) + 2 payments (unchecked ones are skipped).
    expect(snap.completeness.budget.used).toBe(8);
    expect(calls[0]).toEqual({
      path: "/v1/voucherlist",
      query: { voucherType: "any", voucherStatus: "any", voucherDateFrom: "2026-09-01", voucherDateTo: "2026-10-31", page: 0, size: 250 },
    });
    expect(snap.completeness).toMatchObject({
      list: "COMPLETE",
      categories: "LOADED",
      details: { needed: 4, fetched: 4, failed: 0, skippedBudget: 0 },
      payments: { needed: 2, fetched: 2, failed: 0, skippedBudget: 0, notApplicable: 2 },
      attachments: { needed: 0 },
      budget: { exhausted: false },
    });
    expect(snap.errors).toEqual([]);
    // Newest voucher date first: 10-06, 10-01, 09-29, 09-20, 09-12.
    expect(snap.records.map((r) => r.id)).toEqual([id(1), id(2), id(4), id(5), id(3)]);

    const byId = new Map(snap.records.map((r) => [r.id, r]));
    expect(byId.get(id(1))?.grossCents.value).toBeNull();
    expect(byId.get(id(2))?.taxCents.quality).toBe("PLACEHOLDER");
    expect(byId.get(id(3))?.lineItems.value?.[0].categoryName.value).toBe("Wareneingang Test");
    expect(byId.get(id(3))?.payment.availability).toBe("AVAILABLE");
    expect(byId.get(id(4))?.netCents.value).toBe(18900);
    expect(byId.get(id(2))?.payment.availability).toBe("SKIPPED");
    expect(byId.get(id(5))?.kind).toBe("NON_FINANCIAL");
    expect(snap.quality).toMatchObject({ records: 5, financialRecords: 4, unreviewedRecords: 2 });
    expect(snap.generatedAt).toBe("2026-10-06T18:00:00.000Z");
  });

  it("orders records newest first (by window basis), then by id", async () => {
    const rows = [paidRow(3), uncheckedRow(2), invoiceRow(4)];
    const { client } = fakeLexware(standardRoute(rows));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, includeDetails: false, includePayments: false });
    expect(snap.records.map((r) => r.voucherDate.value)).toEqual(["2026-10-01", "2026-09-29", "2026-09-12"]);
  });

  it("stops at the request budget and reports what was not fetched", async () => {
    const rows = [uncheckedRow(2), paidRow(3), invoiceRow(4)];
    const { client } = fakeLexware(standardRoute(rows));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, maxRequests: 3 });
    expect(snap.completeness.budget).toEqual({ maxRequests: 3, used: 3, exhausted: true });
    expect(snap.completeness.details).toMatchObject({ needed: 3, fetched: 1, skippedBudget: 2 });
    const notFetched = snap.records.filter((r) => r.provenance.detail === "NOT_FETCHED");
    expect(notFetched).toHaveLength(2);
    for (const r of notFetched) expect(r.issues.map((i) => i.code)).toContain("DETAIL_NOT_FETCHED");
  });

  it("a failing first list page yields list FAILED and no records — never an exception or an empty-but-'complete' result", async () => {
    const { client } = fakeLexware(() => new LexwareApiError(500, "upstream"));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW });
    expect(snap.completeness).toMatchObject({ list: "FAILED", listReason: "ERROR" });
    expect(snap.records).toHaveLength(0);
    expect(snap.errors[0]).toMatchObject({ stage: "list", status: 500, kind: "upstream" });
  });

  it("an invalid list response is FAILED/INVALID_RESPONSE", async () => {
    const { client } = fakeLexware(() => ({ nope: true }));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW });
    expect(snap.completeness).toMatchObject({ list: "FAILED", listReason: "INVALID_RESPONSE" });
  });

  it("paginates, drops duplicate rows across pages and reports a page limit as PARTIAL", async () => {
    const route: Route = (path, query) => {
      if (path !== "/v1/voucherlist") return new LexwareApiError(404, "x");
      return query?.page === 0 ? page([paidRow(3)], 0, 3) : page([paidRow(3), invoiceRow(4)], Number(query?.page), 3);
    };
    const { client } = fakeLexware(route);
    const full = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, includeDetails: false, includePayments: false });
    // page 0: [3]; pages 1 and 2: [3, 4] -> 3 duplicate rows (3, 3, 4).
    expect(full.completeness).toMatchObject({ list: "COMPLETE", duplicateRowsDropped: 3 });
    expect(full.records).toHaveLength(2);

    const limited = await loadFinanceSnapshot(fakeLexware(route).client, {
      window: WINDOW,
      now: NOW,
      maxListPages: 1,
      includeDetails: false,
      includePayments: false,
    });
    expect(limited.completeness).toMatchObject({ list: "PARTIAL", listReason: "PAGE_LIMIT" });
  });

  it("drops rows outside the window that Lexware still returned, and counts them", async () => {
    const outside = paidRow(9, { voucherDate: "2026-08-15T00:00:00.000+02:00" });
    const { client } = fakeLexware(standardRoute([paidRow(3), outside]));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, includeDetails: false, includePayments: false });
    expect(snap.records.map((r) => r.id)).toEqual([id(3)]);
    expect(snap.completeness.outsideWindowDropped).toBe(1);
  });

  it("records rejected rows instead of dropping them silently", async () => {
    const { client } = fakeLexware(standardRoute([{ voucherType: "purchaseinvoice" }, paidRow(3)]));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, includeDetails: false, includePayments: false });
    expect(snap.rejectedRows).toEqual([{ index: 0, code: "ROW_ID_INVALID" }]);
  });

  it("a 404 detail and a 500 payment are recorded per record; the load continues", async () => {
    const route: Route = (path) => {
      if (path === "/v1/voucherlist") return page([paidRow(3), invoiceRow(4)]);
      if (path === "/v1/posting-categories") return postingCategories();
      if (path === `/v1/vouchers/${id(3)}`) return new LexwareApiError(404, "gone");
      if (path === `/v1/invoices/${id(4)}`) return invoiceDetail(4);
      if (path === `/v1/payments/${id(3)}`) return paidPayment();
      if (path === `/v1/payments/${id(4)}`) return new LexwareApiError(500, "boom");
      return new LexwareApiError(404, "x");
    };
    const snap = await loadFinanceSnapshot(fakeLexware(route).client, { window: WINDOW, now: NOW });
    const byId = new Map(snap.records.map((r) => [r.id, r]));
    expect(byId.get(id(3))?.provenance.detail).toBe("FAILED");
    expect(byId.get(id(3))?.issues.map((i) => i.code)).toContain("DETAIL_FETCH_FAILED");
    expect(byId.get(id(4))?.payment.availability).toBe("FETCH_FAILED");
    expect(snap.errors.map((e) => [e.stage, e.recordId, e.status])).toEqual([
      ["detail", id(3), 404],
      ["payment", id(4), 500],
    ]);
  });

  it("treats a 406 payment answer as 'no payment information', not as a failure", async () => {
    const route: Route = (path) => {
      if (path === "/v1/voucherlist") return page([paidRow(3)]);
      if (path === `/v1/payments/${id(3)}`) return new LexwareApiError(406, "No payment information");
      return new LexwareApiError(404, "x");
    };
    const snap = await loadFinanceSnapshot(fakeLexware(route).client, { window: WINDOW, now: NOW, includeDetails: false });
    expect(snap.records[0].payment.availability).toBe("NOT_AVAILABLE");
    expect(snap.errors).toEqual([]);
  });

  it("sanitizes upstream error messages (untrusted text)", async () => {
    const msg = `boom ${String.fromCodePoint(0x1b)}[31m <img src=x> ${"x".repeat(500)}`;
    const { client } = fakeLexware(() => new LexwareApiError(500, msg));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW });
    expect(snap.errors[0].message).not.toMatch(/[<>]/);
    expect(snap.errors[0].message).not.toContain(String.fromCodePoint(0x1b));
    expect(Array.from(snap.errors[0].message).length).toBeLessThanOrEqual(200);
  });

  it("inspects attachments on request (hash + cleaned text) within the budget", async () => {
    const extractor: PdfTextExtractor = () => ({ result: Promise.resolve({ text: "Rechnung TEST", total: 1 }), destroy: async () => undefined });
    const pdf = Buffer.from("%PDF-1.4 test");
    const { client, calls } = fakeLexware(standardRoute([paidRow(3)]), () => ({ data: pdf, contentType: "application/pdf" }));
    const snap = await loadFinanceSnapshot(client, { window: WINDOW, now: NOW, inspectAttachments: true, extractor });
    expect(calls.some((c) => c.path === `/v1/files/${id(9003)}`)).toBe(true);
    const insp = snap.records[0].attachments.value?.[0].inspection;
    expect(insp).toMatchObject({ status: "text_extracted", text: "Rechnung TEST" });
    expect(insp?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.records[0].provenance.attachments).toBe("FETCHED");
    expect(snap.completeness.attachments).toMatchObject({ needed: 1, fetched: 1 });
  });

  it.each([
    [{ from: "2026-10-31", to: "2026-09-01", basis: "voucherDate" }],
    [{ from: "2026-02-30", to: "2026-03-01", basis: "voucherDate" }],
    [{ from: "2026-09-01", to: "2026-10-31", basis: "updatedDate" }],
    [{ from: "yesterday", to: "2026-10-31", basis: "voucherDate" }],
  ])("refuses an invalid window %j", async (window) => {
    const { client, calls } = fakeLexware(standardRoute([]));
    await expect(loadFinanceSnapshot(client, { window: window as never, now: NOW })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("supports a createdDate window (e.g. 'new since yesterday')", async () => {
    const { client, calls } = fakeLexware(standardRoute([uncheckedRow(2)]));
    const snap = await loadFinanceSnapshot(client, {
      window: { from: "2026-10-05", to: "2026-10-06", basis: "createdDate" },
      now: NOW,
      includeDetails: false,
      includePayments: false,
    });
    expect(calls[0].query).toMatchObject({ createdDateFrom: "2026-10-05", createdDateTo: "2026-10-06" });
    expect(snap.records.map((r) => r.id)).toEqual([id(2)]);
  });
});
