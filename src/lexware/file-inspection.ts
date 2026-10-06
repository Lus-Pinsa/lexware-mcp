import { createHash } from "node:crypto";

import { CanvasFactory } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";

import { cleanUntrustedText } from "../untrusted.js";
import { ResponseTooLargeError, UnsafeRequestPathError } from "./errors.js";
import type { ReadOnlyLexwareClient } from "./read-only-client.js";

/**
 * Read-only inspection of a Lexware file: exact SHA-256 of the bytes, plus the PDF text layer.
 *
 * Hardening (all limits are local safety limits, not Lexware limits):
 * - size limit: the download is aborted beyond `maxBytes` (no hash, status `file_too_large`)
 * - page limit: only the first `maxPages` pages are parsed
 * - timeout: parsing is abandoned after `parseTimeoutMs` and the parser is destroyed (status `parse_timeout`)
 * - text limit: the returned text is capped, and always cleaned as UNTRUSTED input
 * Nothing is ever written to Lexware.
 */

export interface FileInspectionLimits {
  readonly maxBytes: number;
  readonly parseTimeoutMs: number;
  readonly maxPages: number;
  readonly maxTextCharacters: number;
}

export const DEFAULT_FILE_LIMITS: FileInspectionLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  parseTimeoutMs: 15_000,
  maxPages: 20,
  maxTextCharacters: 200_000,
});

/** Destroying a parser must never hang the request either. */
const DESTROY_TIMEOUT_MS = 2_000;
const MAX_PARSE_ERROR_CHARS = 200;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type InspectionStatus =
  | "text_extracted"
  | "ocr_required"
  | "unsupported_file_type"
  | "parse_error"
  | "parse_timeout"
  | "file_too_large";

export interface FileInspectionResult {
  readonly fileId: string;
  readonly status: InspectionStatus;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
  readonly isPdf: boolean | null;
  readonly pageCount: number | null;
  readonly pagesParsed: number | null;
  readonly pageLimitApplied: boolean;
  /** Cleaned (sanitized + markup-neutralized), capped text. UNTRUSTED. Empty when no text. */
  readonly text: string;
  readonly textAvailable: boolean;
  readonly textTruncated: boolean;
  /** Characters of cleaned text before the cap. */
  readonly extractedCharacters: number;
  readonly returnedCharacters: number;
  /** Cleaned, short parser error message (status parse_error only). */
  readonly parseError: string | null;
  readonly limits: FileInspectionLimits;
}

/** A running PDF text extraction that can be abandoned. Injectable for tests. */
export interface PdfTextJob {
  readonly result: Promise<{ text: string; total: number }>;
  readonly destroy: () => Promise<void>;
}
export type PdfTextExtractor = (data: Uint8Array, opts: { maxPages: number }) => PdfTextJob;

export const pdfParseExtractor: PdfTextExtractor = (data, { maxPages }) => {
  const parser = new PDFParse({ data, CanvasFactory });
  return {
    result: parser.getText({ first: maxPages }).then((r) => ({ text: r.text ?? "", total: r.total })),
    destroy: () => parser.destroy(),
  };
};

function normalizeMimeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function looksLikePdf(data: Buffer): boolean {
  return data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** Validate a Lexware file id before it becomes part of a path. */
export function assertValidFileId(fileId: unknown): asserts fileId is string {
  if (typeof fileId !== "string" || !FILE_ID_PATTERN.test(fileId)) {
    throw new UnsafeRequestPathError("file id must be 1-128 characters of [A-Za-z0-9_-]");
  }
}

export async function inspectLexwareFile(
  client: Pick<ReadOnlyLexwareClient, "getBinary">,
  fileId: string,
  opts: { maxCharacters: number; limits?: Partial<FileInspectionLimits> },
  extractor: PdfTextExtractor = pdfParseExtractor,
): Promise<FileInspectionResult> {
  assertValidFileId(fileId);
  const limits: FileInspectionLimits = { ...DEFAULT_FILE_LIMITS, ...opts.limits };
  const maxChars = Math.max(0, Math.min(opts.maxCharacters, limits.maxTextCharacters));

  const base = {
    fileId,
    pageCount: null,
    pagesParsed: null,
    pageLimitApplied: false,
    text: "",
    textAvailable: false,
    textTruncated: false,
    extractedCharacters: 0,
    returnedCharacters: 0,
    parseError: null,
    limits,
  } as const;

  let data: Buffer;
  let contentType: string;
  try {
    ({ data, contentType } = await client.getBinary(
      `/v1/files/${encodeURIComponent(fileId)}`,
      "application/pdf",
      { maxBytes: limits.maxBytes },
    ));
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      return {
        ...base,
        status: "file_too_large",
        mimeType: null,
        byteLength: err.declaredBytes,
        sha256: null,
        isPdf: null,
      };
    }
    throw err;
  }

  const mimeType = normalizeMimeType(contentType);
  // Hash the exact bytes before parsing (the parser may transfer/detach buffers).
  const sha256 = createHash("sha256").update(data).digest("hex");
  const isPdf = mimeType === "application/pdf" || looksLikePdf(data);
  const common = { ...base, mimeType, byteLength: data.length, sha256, isPdf };

  if (!isPdf) return { ...common, status: "unsupported_file_type" };

  let job: PdfTextJob | undefined;
  try {
    job = extractor(new Uint8Array(data), { maxPages: limits.maxPages });
    // A late rejection after a timeout must not become an unhandled rejection.
    job.result.catch(() => undefined);
    const outcome = await withTimeout(job.result, limits.parseTimeoutMs);
    if (outcome.timedOut) return { ...common, status: "parse_timeout" };

    const { text: rawText, total } = outcome.value;
    const pageCount = Number.isInteger(total) && total >= 0 ? total : null;
    const pagesParsed = pageCount === null ? null : Math.min(pageCount, limits.maxPages);
    const pageLimitApplied = pageCount !== null && pageCount > limits.maxPages;

    const cleaned = cleanUntrustedText(rawText.trim(), { maxChars });
    const textAvailable = cleaned.cleanedLength > 0 && cleaned.text.trim().length > 0;
    if (!textAvailable) {
      return { ...common, status: "ocr_required", pageCount, pagesParsed, pageLimitApplied };
    }
    return {
      ...common,
      status: "text_extracted",
      pageCount,
      pagesParsed,
      pageLimitApplied,
      text: cleaned.text,
      textAvailable: true,
      textTruncated: cleaned.truncated || pageLimitApplied,
      extractedCharacters: cleaned.cleanedLength,
      returnedCharacters: Array.from(cleaned.text).length,
    };
  } catch (err) {
    const message = cleanUntrustedText(err instanceof Error ? err.message : String(err), {
      maxChars: MAX_PARSE_ERROR_CHARS,
      singleLine: true,
    }).text;
    return { ...common, status: "parse_error", parseError: message };
  } finally {
    if (job) {
      const destroy = job.destroy;
      await withTimeout(
        Promise.resolve()
          .then(destroy)
          .catch(() => undefined),
        DESTROY_TIMEOUT_MS,
      );
    }
  }
}
