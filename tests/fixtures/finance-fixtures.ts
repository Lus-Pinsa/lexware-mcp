/**
 * Synthetic Lexware response fixtures for the finance truth-layer tests.
 *
 * PUBLIC REPOSITORY: these mirror the SHAPE of real Lexware responses only. All ids, names, numbers and
 * amounts are invented ("Testlieferant …", 00000000-… ids). Never paste real voucher data here.
 */

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const CTX = { fetchedAt: "2026-10-06T18:00:00.000Z", timeZone: "Europe/Berlin" } as const;

/** Unreviewed purchase invoice from the Lexware document inbox: no amount, no contact id, no open amount. */
export function uncheckedRowWithoutAmount(n = 1) {
  return {
    id: id(n),
    voucherType: "purchaseinvoice",
    voucherStatus: "unchecked",
    voucherNumber: "TEST-INV-0001",
    voucherDate: "2026-10-06T00:00:00.000+02:00",
    createdDate: "2026-10-06T09:00:00.000+02:00",
    updatedDate: "2026-10-06T09:00:05.000+02:00",
    dueDate: "2026-10-06T00:00:00.000+02:00",
    contactName: "Testlieferant Alpha GmbH",
    currency: "EUR",
    archived: false,
  };
}

/** Unreviewed purchase invoice with a gross amount (still no contact id / open amount). */
export function uncheckedRow(n = 2, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    voucherType: "purchaseinvoice",
    voucherStatus: "unchecked",
    voucherNumber: "TEST-INV-0002",
    voucherDate: "2026-10-01T00:00:00.000+02:00",
    createdDate: "2026-10-05T10:00:00.000+02:00",
    updatedDate: "2026-10-05T10:00:04.000+02:00",
    dueDate: "2026-10-01T00:00:00.000+02:00",
    contactName: "Testlieferant Beta SAS",
    totalAmount: 123.45,
    currency: "EUR",
    archived: false,
    ...overrides,
  };
}

export function uncheckedDetail(n = 2, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    organizationId: id(999),
    type: "purchaseinvoice",
    voucherStatus: "unchecked",
    voucherNumber: "TEST-INV-0002",
    voucherDate: "2026-10-01T00:00:00.000+02:00",
    dueDate: "2026-10-01T00:00:00.000+02:00",
    totalGrossAmount: 123.45,
    totalTaxAmount: 0,
    taxType: "gross",
    useCollectiveContact: false,
    voucherItems: [],
    files: [id(9002)],
    createdDate: "2026-10-05T10:00:00.100+02:00",
    updatedDate: "2026-10-05T10:00:04.200+02:00",
    version: 1,
    ...overrides,
  };
}

/** Booked and paid purchase invoice with one line item (0 % tax) and a contact id. */
export function paidRow(n = 3, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    voucherType: "purchaseinvoice",
    voucherStatus: "paid",
    voucherNumber: "TEST-3000 - 0001",
    voucherDate: "2026-09-12T00:00:00.000+02:00",
    createdDate: "2026-09-12T10:30:00.000+02:00",
    updatedDate: "2026-09-15T11:00:00.000+02:00",
    dueDate: "2026-09-20T00:00:00.000+02:00",
    contactId: id(501),
    contactName: "Testlieferant Gamma GmbH",
    totalAmount: 4.35,
    openAmount: 0,
    currency: "EUR",
    archived: false,
    ...overrides,
  };
}

export const CATEGORY_GOODS = id(7001);
export const CATEGORY_UNKNOWN = id(7999);

export function paidDetail(n = 3, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    organizationId: id(999),
    type: "purchaseinvoice",
    voucherStatus: "paid",
    voucherNumber: "TEST-3000 - 0001",
    voucherDate: "2026-09-12T00:00:00.000+02:00",
    dueDate: "2026-09-20T00:00:00.000+02:00",
    totalGrossAmount: 4.35,
    totalTaxAmount: 0,
    taxType: "gross",
    useCollectiveContact: false,
    contactId: id(501),
    remark: "",
    voucherItems: [{ amount: 4.35, taxAmount: 0, taxRatePercent: 0, categoryId: CATEGORY_GOODS }],
    files: [id(9003)],
    createdDate: "2026-09-12T10:30:00.300+02:00",
    updatedDate: "2026-09-15T11:00:00.400+02:00",
    version: 5,
    ...overrides,
  };
}

export function paidPayment(overrides: Record<string, unknown> = {}) {
  return {
    openAmount: 0,
    paymentStatus: "balanced",
    currency: "EUR",
    voucherType: "purchaseinvoice",
    paidDate: "2026-09-14T02:00:00.000+02:00",
    paymentItems: [
      { paymentItemType: "partPaymentFinancialTransaction", postingDate: "2026-09-14T02:00:00.000+02:00", amount: 4.35, currency: "EUR" },
    ],
    voucherStatus: "paid",
    ...overrides,
  };
}

/** Sales invoice (Lexware invoicing module) as listed: "overdue" is computed by the voucherlist. */
export function invoiceRow(n = 4, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    voucherType: "invoice",
    voucherStatus: "overdue",
    voucherNumber: "RE-TEST-0042",
    voucherDate: "2026-09-29T00:00:00.000+02:00",
    createdDate: "2026-09-29T14:05:30.000+02:00",
    updatedDate: "2026-09-29T14:05:30.000+02:00",
    dueDate: "2026-09-29T00:00:00.000+02:00",
    contactId: id(601),
    contactName: "Testkunde Delta GmbH",
    totalAmount: 107,
    openAmount: 107,
    currency: "EUR",
    archived: false,
    ...overrides,
  };
}

export function invoiceDetail(n = 4, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    organizationId: id(999),
    createdDate: "2026-09-29T14:05:30.250+02:00",
    updatedDate: "2026-09-29T14:05:31.500+02:00",
    version: 1,
    language: "de",
    archived: false,
    voucherStatus: "open",
    voucherNumber: "RE-TEST-0042",
    voucherDate: "2026-09-29T14:05:20.000+02:00",
    dueDate: "2026-09-29T14:05:20.000+02:00",
    address: { contactId: id(601), name: "Testkunde Delta GmbH", countryCode: "DE" },
    lineItems: [
      {
        id: id(8001),
        type: "material",
        name: "Testartikel",
        quantity: 40,
        unitName: "Stück",
        unitPrice: { currency: "EUR", netAmount: 2.5, grossAmount: 2.68, taxRatePercentage: 7 },
        discountPercentage: 0,
        lineItemAmount: 100,
      },
      { id: id(8002), type: "text", name: "Hinweiszeile" },
    ],
    totalPrice: { currency: "EUR", totalNetAmount: 100, totalGrossAmount: 107, totalTaxAmount: 7 },
    taxAmounts: [{ taxRatePercentage: 7, taxAmount: 7, netAmount: 100 }],
    taxConditions: { taxType: "net" },
    paymentConditions: { paymentTermLabel: "Zahlbar sofort", paymentTermDuration: 0 },
    files: { documentFileId: id(9004) },
    title: "Rechnung",
    ...overrides,
  };
}

export function invoicePayment(overrides: Record<string, unknown> = {}) {
  return { openAmount: 107, paymentStatus: "openRevenue", currency: "EUR", voucherType: "invoice", paymentItems: [], voucherStatus: "open", ...overrides };
}

export function quotationRow(n = 5) {
  return {
    id: id(n),
    voucherType: "quotation",
    voucherStatus: "open",
    voucherNumber: "AG-TEST-0001",
    voucherDate: "2026-09-20T00:00:00.000+02:00",
    createdDate: "2026-09-20T10:00:00.000+02:00",
    updatedDate: "2026-09-20T10:00:00.000+02:00",
    contactId: id(602),
    contactName: "Testkunde Epsilon",
    totalAmount: 999,
    currency: "EUR",
    archived: false,
  };
}

export function postingCategories() {
  return [
    { id: CATEGORY_GOODS, name: "Wareneingang Test", type: "outgo", contactRequired: false, splitAllowed: true, groupName: "Test" },
    { id: id(7002), name: "Erlöse Test", type: "income", contactRequired: false, splitAllowed: true, groupName: "Test" },
  ];
}

export function page<T>(content: T[], number = 0, totalPages = 1) {
  return {
    content,
    first: number === 0,
    last: number + 1 >= totalPages,
    totalPages,
    totalElements: content.length,
    numberOfElements: content.length,
    size: 250,
    number,
  };
}
