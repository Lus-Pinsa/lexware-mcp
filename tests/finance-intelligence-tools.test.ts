import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "skybridge/server";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import type { PdfTextExtractor } from "../src/lexware/file-inspection.js";
import { registerFinanceIntelligenceTools } from "../src/tools/finance-intelligence.js";
import { rid } from "./fixtures/intelligence-fixtures.js";

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: any; content: Array<{ type: string; text: string }>; isError?: boolean }>;

const NOW = new Date("2026-10-07T06:00:00.000Z"); // 08:00 in Europe/Berlin → asOf 2026-10-07
const TOOL_NAMES = ["get-finance-snapshot", "analyze-voucher-duplicates", "get-open-items", "compare-finance-periods", "get-finance-daily-brief"];

function listRow(n: number, o: Record<string, unknown> = {}) {
  return {
    id: rid(n),
    voucherType: "purchaseinvoice",
    voucherStatus: "paid",
    voucherNumber: `TEST-${1000 + n}`,
    voucherDate: "2026-10-02",
    createdDate: "2026-10-02T10:00:00.000+02:00",
    updatedDate: "2026-10-02T10:00:00.000+02:00",
    dueDate: "2026-10-16",
    contactName: "Testlieferant A",
    totalAmount: 100,
    openAmount: 0,
    currency: "EUR",
    archived: false,
    ...o,
  };
}

function salesDetail(n: number, o: Record<string, unknown> = {}) {
  return {
    id: rid(n),
    voucherStatus: "open",
    voucherNumber: `RE-TEST-${n}`,
    voucherDate: "2026-09-01",
    dueDate: "2026-09-01",
    address: { name: "Testkunde A" },
    lineItems: [],
    totalPrice: { currency: "EUR", totalNetAmount: 100, totalGrossAmount: 119, totalTaxAmount: 19 },
    taxConditions: { taxType: "net" },
    paymentConditions: { paymentTermDuration: 0 },
    ...o,
  };
}

const ROWS = [
  listRow(1, { voucherDate: "2026-10-02" }),
  listRow(2, { voucherNumber: "TEST-1001", voucherDate: "2026-10-02" }), // E2 duplicate of 1 (reviewed → ROT)
  listRow(3, { voucherDate: "2026-09-02", contactName: "Testlieferant B" }),
  listRow(4, { voucherType: "invoice", voucherStatus: "overdue", voucherNumber: "RE-TEST-4", voucherDate: "2026-09-01", dueDate: "2026-09-01", contactName: "Testkunde A", totalAmount: 119, openAmount: 119 }),
  listRow(5, { voucherStatus: "overdue", voucherNumber: "TEST-5005", voucherDate: "2026-09-10", dueDate: "2026-09-10", contactName: "Testlieferant C", totalAmount: 50, openAmount: 50 }),
  listRow(6, { voucherStatus: "unchecked", voucherNumber: "TEST-6006", contactName: "Testlieferant D", openAmount: undefined }),
];

function fake(options: { rows?: unknown[]; failList?: boolean; pages?: number } = {}) {
  const rows = options.rows ?? ROWS;
  const calls: Array<{ path: string; query?: Record<string, unknown> }> = [];
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`write method ${name} must never be called`);
    });
  const get = vi.fn(async (path: string, query?: Record<string, unknown>) => {
    calls.push({ path, query });
    if (path === "/v1/voucherlist") {
      if (options.failList) throw new LexwareApiError(500, "upstream down");
      const pages = options.pages ?? 1;
      const page = Number(query?.page ?? 0);
      return { content: page === 0 ? rows : [], first: page === 0, last: page + 1 >= pages, totalPages: pages, number: page, size: 250 };
    }
    if (path === `/v1/invoices/${rid(4)}`) return salesDetail(4);
    if (path.startsWith("/v1/vouchers/")) {
      const id = path.slice("/v1/vouchers/".length);
      return { id, voucherStatus: "paid", totalGrossAmount: 100, totalTaxAmount: 0, taxType: "gross", voucherItems: [], files: [`file-${id.slice(-2)}`] };
    }
    throw new LexwareApiError(404, `unexpected ${path}`);
  });
  const getBinary = vi.fn(async (path: string) => {
    calls.push({ path });
    return { data: Buffer.from("%PDF-1.4 identical synthetic file"), contentType: "application/pdf" };
  });
  const client = { get, getBinary, post: forbidden("post"), postMultipart: forbidden("postMultipart"), request: forbidden("request") };
  return { client: client as unknown as LexwareClient, raw: client, calls };
}

function tools(client: LexwareClient, extractor?: PdfTextExtractor, now: Date = NOW) {
  const handlers: Record<string, Handler> = {};
  const configs: Record<string, { annotations?: Record<string, boolean> }> = {};
  const server = {
    registerTool(cfg: { name: string; annotations?: Record<string, boolean> }, handler: Handler) {
      handlers[cfg.name] = handler;
      configs[cfg.name] = cfg;
    },
  } as unknown as McpServer;
  registerFinanceIntelligenceTools(server, client, { now: () => now, extractor });
  return { handlers, configs };
}

describe("finance intelligence tools — read-only surface", () => {
  it("registers exactly five tools, all annotated read-only and non-destructive", () => {
    const { configs } = tools(fake().client);
    expect(Object.keys(configs).sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) expect(configs[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("no tool ever reaches a write method, and only allowlisted GET paths are read", async () => {
    const f = fake();
    const { handlers } = tools(f.client);
    for (const name of TOOL_NAMES) await handlers[name]({});
    await handlers["analyze-voucher-duplicates"]({ verifyFileHashes: true });
    await handlers["get-open-items"]({ includePaymentInfo: true });
    expect(f.raw.post).not.toHaveBeenCalled();
    expect(f.raw.postMultipart).not.toHaveBeenCalled();
    expect(f.raw.request).not.toHaveBeenCalled();
    for (const c of f.calls) expect(c.path).toMatch(/^\/v1\/(voucherlist|vouchers|invoices|credit-notes|down-payment-invoices|payments|posting-categories|files)(\/|$)/);
  });
});

describe("get-finance-snapshot", () => {
  it("defaults to previous month start .. today and reports quality and completeness", async () => {
    const f = fake();
    const res = await tools(f.client).handlers["get-finance-snapshot"]({});
    expect(f.calls[0].query).toMatchObject({ voucherDateFrom: "2026-09-01", voucherDateTo: "2026-10-07", voucherType: "any", voucherStatus: "any" });
    const sc = res.structuredContent;
    expect(sc.window).toEqual({ from: "2026-09-01", to: "2026-10-07", basis: "voucherDate" });
    expect(sc.completeness.list).toBe("COMPLETE");
    expect(sc.rows).toHaveLength(ROWS.length);
    expect(sc.rows[0]).toHaveProperty("grossCents.quality");
    expect(sc.dataQuality.grade).toMatch(/GOOD|LIMITED|POOR|NO_DATA/);
    expect(f.calls.filter((c) => c.path !== "/v1/voucherlist")).toEqual([]); // list only by default
  });

  it("rejects an invalid or oversized window without calling Lexware", async () => {
    const f = fake();
    const { handlers } = tools(f.client);
    expect((await handlers["get-finance-snapshot"]({ from: "2026-10-10", to: "2026-10-01" })).isError).toBe(true);
    expect((await handlers["get-finance-snapshot"]({ from: "2026-02-30", to: "2026-03-01" })).isError).toBe(true);
    expect((await handlers["get-finance-snapshot"]({ from: "2020-01-01", to: "2026-10-01" })).isError).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("caps the returned rows", async () => {
    const res = await tools(fake().client).handlers["get-finance-snapshot"]({ maxRows: 2 });
    expect(res.structuredContent.rows).toHaveLength(2);
    expect(res.structuredContent.rowsOmitted).toBe(ROWS.length - 2);
  });
});

describe("analyze-voucher-duplicates", () => {
  it("finds the E2 duplicate from list data only", async () => {
    const f = fake();
    const res = await tools(f.client).handlers["analyze-voucher-duplicates"]({});
    const sc = res.structuredContent;
    expect(sc.analysis.counts.EXACT_DUPLICATE).toBe(1);
    expect(sc.analysis.findings[0]).toMatchObject({ rule: "E2", recordIds: [rid(1), rid(2)] });
    expect(sc.documents.map((d: { id: string }) => d.id).sort()).toEqual([rid(1), rid(2)]);
    expect(sc.hashVerification).toEqual({ performed: false, reason: "NOT_REQUESTED" });
    expect(f.calls[0].query).toMatchObject({ voucherDateFrom: "2026-07-09", voucherDateTo: "2026-10-07" });
  });

  it("verifyFileHashes reads details and files for candidates only and upgrades by hash", async () => {
    const rows = [
      listRow(1, { voucherNumber: "TEST-1111" }),
      listRow(2, { voucherNumber: undefined, voucherDate: "2026-10-05" }), // S1 candidate with 1 (same supplier + amount, 3 days)
      listRow(3, { voucherNumber: "TEST-3333", contactName: "Testlieferant Z", totalAmount: 7 }), // no candidate
    ];
    const f = fake({ rows });
    const extractor: PdfTextExtractor = () => ({ result: Promise.resolve({ text: "x", total: 1 }), destroy: async () => undefined });
    const res = await tools(f.client, extractor).handlers["analyze-voucher-duplicates"]({ verifyFileHashes: true });
    const detailPaths = f.calls.filter((c) => c.path.startsWith("/v1/vouchers/")).map((c) => c.path).sort();
    expect(detailPaths).toEqual([`/v1/vouchers/${rid(1)}`, `/v1/vouchers/${rid(2)}`]);
    expect(res.structuredContent.hashVerification).toMatchObject({ performed: true, candidates: 2 });
    expect(res.structuredContent.analysis.findings[0]).toMatchObject({ rule: "E1", classification: "EXACT_DUPLICATE" });
  });
});

describe("get-open-items", () => {
  it("verifies due dates of open sales documents only and classifies conservatively", async () => {
    const f = fake();
    const res = await tools(f.client).handlers["get-open-items"]({});
    expect(f.calls.filter((c) => c.path !== "/v1/voucherlist").map((c) => c.path)).toEqual([`/v1/invoices/${rid(4)}`]);
    const items = res.structuredContent.items as Array<{ recordId: string; status: string; direction: string }>;
    const byId = Object.fromEntries(items.map((i) => [i.recordId, i]));
    expect(byId[rid(4)]).toMatchObject({ status: "OVERDUE_CONFIRMED", direction: "RECEIVABLE" }); // payment term "sofort"
    expect(byId[rid(5)]).toMatchObject({ status: "POSSIBLY_OVERDUE", direction: "PAYABLE" }); // due = voucher date, no term
    expect(byId[rid(6)]).toMatchObject({ status: "STATUS_UNKNOWN" }); // unreviewed inbox document
    expect(items.some((i) => i.status === "PAID_CONFIRMED")).toBe(false);
    expect(res.structuredContent.counts.PAID_CONFIRMED).toBeGreaterThan(0);
    expect(res.structuredContent.coverage).toContain("2026-04-10");
  });

  it("without verification the sales invoice stays POSSIBLY_OVERDUE (never confirmed on a default due date)", async () => {
    const f = fake();
    const res = await tools(f.client).handlers["get-open-items"]({ verifyDueDates: false });
    expect(f.calls.every((c) => c.path === "/v1/voucherlist")).toBe(true);
    const item = (res.structuredContent.items as Array<{ recordId: string; status: string }>).find((i) => i.recordId === rid(4));
    expect(item?.status).toBe("POSSIBLY_OVERDUE");
  });

  it("filters by direction and can include paid items", async () => {
    const { handlers } = tools(fake().client);
    const payable = await handlers["get-open-items"]({ direction: "payable", includePaid: true });
    const items = payable.structuredContent.items as Array<{ direction: string; status: string }>;
    expect(items.every((i) => i.direction === "PAYABLE")).toBe(true);
    expect(items.some((i) => i.status === "PAID_CONFIRMED")).toBe(true);
  });
});

describe("compare-finance-periods", () => {
  it("compares MTD with the previous month and carries the revenue scope note", async () => {
    const f = fake();
    const res = await tools(f.client).handlers["compare-finance-periods"]({});
    expect(f.calls[0].query).toMatchObject({ voucherDateFrom: "2026-09-01", voucherDateTo: "2026-10-07" });
    const c = res.structuredContent.comparison;
    expect(c.periods.previousSamePeriod).toEqual({ from: "2026-09-01", to: "2026-09-07" });
    expect(c.revenueScopeNote).toContain("Nicht identisch mit dem Kassen-/POS-Umsatz");
    expect(res.content[0].text).toContain("Nicht identisch mit dem Kassen-/POS-Umsatz");
  });

  it("refuses a future reference day and invalid thresholds", async () => {
    const f = fake();
    const { handlers } = tools(f.client);
    expect((await handlers["compare-finance-periods"]({ asOf: "2026-10-08" })).isError).toBe(true);
    expect((await handlers["compare-finance-periods"]({ asOf: "2026-02-29" })).isError).toBe(true);
    expect((await handlers["compare-finance-periods"]({ minRelativeChangePercent: 30.001 })).isError).toBe(true);
  });
});

describe("get-finance-daily-brief", () => {
  it("renders the deterministic brief as text with status and reasons", async () => {
    const { handlers } = tools(fake().client);
    const a = await handlers["get-finance-daily-brief"]({});
    const b = await handlers["get-finance-daily-brief"]({});
    expect(a.content[0].text).toBe(b.content[0].text);
    expect(a.content[0].text.startsWith("LU'S FINANCE DAILY · 07.10.2026")).toBe(true);
    expect(a.structuredContent.status).toBe("ROT"); // exact duplicate between two reviewed documents
    expect(a.structuredContent.statusReasons).toContain("EXACT_DUPLICATE_REVIEWED");
    expect(a.content[0].text).not.toMatch(/wurde\s+(bezahlt|gebucht|gelöscht|überwiesen)/i);
  });

  it("is ROT with an explicit note when the list cannot be loaded (FAILED)", async () => {
    const res = await tools(fake({ failList: true }).client).handlers["get-finance-daily-brief"]({});
    expect(res.structuredContent.status).toBe("ROT");
    expect(res.structuredContent.completeness.list).toBe("FAILED");
    expect(res.content[0].text).toContain("Belegliste nicht geladen");
    expect(res.structuredContent.errors[0]).toMatchObject({ stage: "list", status: 500 });
  });

  it("is ROT when the request budget ends before the list is complete (PARTIAL)", async () => {
    const res = await tools(fake({ pages: 3 }).client).handlers["get-finance-daily-brief"]({ maxRequests: 1 });
    expect(res.structuredContent.completeness.list).toBe("PARTIAL");
    expect(res.structuredContent.status).toBe("ROT");
    expect(res.content[0].text).toContain("Untergrenzen");
  });
});

describe("review round 1: tool limits and wiring", () => {
  const sameSupplierInbox = (count: number) =>
    Array.from({ length: count }, (_, i) => listRow(100 + i, { voucherStatus: "unchecked", voucherNumber: undefined, openAmount: undefined, voucherDate: "2026-10-02" }));

  it("caps the returned duplicate findings and documents, keeping the counts complete", async () => {
    const res = await tools(fake({ rows: sameSupplierInbox(20) }).client).handlers["analyze-voucher-duplicates"]({ maxFindings: 5 });
    const sc = res.structuredContent;
    expect(sc.analysis.counts.POSSIBLE_DUPLICATE).toBe(190); // 20 × 19 / 2
    expect(sc.analysis.findings).toHaveLength(5);
    expect(sc.findingsOmitted).toBe(185);
    const listedIds = new Set(sc.analysis.findings.flatMap((f: { recordIds: string[] }) => f.recordIds));
    expect(sc.documents.every((d: { id: string }) => listedIds.has(d.id))).toBe(true);
    const defaults = await tools(fake({ rows: sameSupplierInbox(20) }).client).handlers["analyze-voucher-duplicates"]({});
    expect(defaults.structuredContent.analysis.findings).toHaveLength(100);
  });

  it("hashes at most 25 candidate documents per call", async () => {
    const f = fake({ rows: sameSupplierInbox(30) });
    const extractor: PdfTextExtractor = () => ({ result: Promise.resolve({ text: "x", total: 1 }), destroy: async () => undefined });
    const res = await tools(f.client, extractor).handlers["analyze-voucher-duplicates"]({ verifyFileHashes: true, maxRequests: 500 });
    expect(f.calls.filter((c) => c.path.startsWith("/v1/vouchers/")).length).toBe(25);
    expect(res.structuredContent.hashVerification).toMatchObject({ performed: true, candidates: 25, candidatesNotVerified: 5 });
  });

  it("validates thresholds and dates before any Lexware request", async () => {
    const f = fake();
    const { handlers } = tools(f.client);
    expect((await handlers["compare-finance-periods"]({ minRelativeChangePercent: 30.001 })).isError).toBe(true);
    expect((await handlers["compare-finance-periods"]({ asOf: "0050-01-15" })).isError).toBe(true);
    expect((await handlers["get-finance-snapshot"]({ from: "0050-01-01", to: "0050-01-31" })).isError).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("caps listed anomalies and reports how many were left out", async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => listRow(200 + i, { contactName: `Testlieferant ${i}`, voucherNumber: `TEST-A${i}1`, voucherDate: "2026-10-02", totalAmount: 1000 })),
      ...Array.from({ length: 60 }, (_, i) => listRow(400 + i, { contactName: `Testlieferant ${i}`, voucherNumber: `TEST-B${i}1`, voucherDate: "2026-09-02", totalAmount: 100 })),
    ];
    const res = await tools(fake({ rows }).client).handlers["compare-finance-periods"]({});
    expect(res.structuredContent.comparison.anomalies).toHaveLength(50);
    expect(res.structuredContent.anomaliesOmitted).toBe(11); // 1 metric + 60 suppliers
  });

  it("uses the Europe/Berlin day: 22:30 UTC on 6 October is already 7 October", async () => {
    const f = fake();
    await tools(f.client, undefined, new Date("2026-10-06T22:30:00.000Z")).handlers["compare-finance-periods"]({});
    expect(f.calls[0].query).toMatchObject({ voucherDateTo: "2026-10-07" });
  });

  it("an incomplete list switches the brief's comparison to 'not evaluated'", async () => {
    const res = await tools(fake({ pages: 3 }).client).handlers["get-finance-daily-brief"]({ maxRequests: 1 });
    expect(res.content[0].text).toContain("nicht bewertet (Belegliste unvollständig)");
    expect(res.structuredContent.anomalies).toBe(0);
  });
});

describe("review round 2: tools", () => {
  it("rejected voucherlist rows make the data LIMITED and the brief never GRÜN", async () => {
    const rows = [listRow(1, { voucherDate: "2026-10-02" }), listRow(2, { voucherDate: "2026-09-02", contactName: "Testlieferant B", voucherNumber: "TEST-2" }), { id: "../bad", voucherType: "invoice" }, 42];
    const { handlers } = tools(fake({ rows }).client);
    const brief = await handlers["get-finance-daily-brief"]({});
    expect(brief.structuredContent.rejectedRows).toBe(2);
    expect(brief.structuredContent.status).not.toBe("GRÜN");
    expect(brief.structuredContent.dataQuality.triggeredBy).toContain("ROWS_REJECTED");
    expect(brief.content[0].text).toContain("Verworfene Zeilen der Belegliste");
    const snap = await handlers["get-finance-snapshot"]({});
    expect(snap.structuredContent.dataQuality.grade).not.toBe("GOOD");
  });

  it("hash verification enriches the same list: no second list read and no lost findings under a tight budget", async () => {
    const rows = [listRow(1, { voucherNumber: "TEST-1111" }), listRow(2, { voucherNumber: undefined, voucherDate: "2026-10-05" })];
    const extractor: PdfTextExtractor = () => ({ result: Promise.resolve({ text: "x", total: 1 }), destroy: async () => undefined });
    const listOnly = fake({ rows });
    const plain = await tools(listOnly.client).handlers["analyze-voucher-duplicates"]({});
    const listReads = listOnly.calls.filter((c) => c.path === "/v1/voucherlist").length;
    const f = fake({ rows });
    // Budget for the list plus one detail only: the verification cannot finish, but nothing found before is lost.
    const res = await tools(f.client, extractor).handlers["analyze-voucher-duplicates"]({ verifyFileHashes: true, maxRequests: listReads + 2 });
    expect(f.calls.filter((c) => c.path === "/v1/voucherlist")).toHaveLength(listReads); // the list is read once
    expect(res.structuredContent.analysis.findings.length).toBeGreaterThanOrEqual(plain.structuredContent.analysis.findings.length);
    expect(plain.structuredContent.analysis.findings).toHaveLength(1);
  });

  it("with payment info, details are still read for open sales documents only", async () => {
    const f = fake();
    await tools(f.client).handlers["get-open-items"]({ includePaymentInfo: true });
    const detailPaths = f.calls.filter((c) => /^\/v1\/(vouchers|invoices|credit-notes|down-payment-invoices)\//.test(c.path)).map((c) => c.path);
    expect(detailPaths).toEqual([`/v1/invoices/${rid(4)}`]);
    expect(f.calls.some((c) => c.path.startsWith("/v1/payments/"))).toBe(true);
  });
});
