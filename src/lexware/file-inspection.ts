import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import { cleanUntrustedText, sanitizeUntrustedText } from "../untrusted.js";
import { ResponseTooLargeError, UnsafeRequestPathError } from "./errors.js";
import type { ReadOnlyLexwareClient } from "./read-only-client.js";

/**
 * Read-only inspection of a Lexware file: exact SHA-256 of the bytes, plus the PDF text layer.
 *
 * Hardening (all limits are local safety limits, not Lexware limits):
 * - size limit: the download is aborted beyond `maxBytes` (no hash, status `file_too_large`)
 * - isolation: the PDF is parsed in a separate worker thread with a memory limit, so a hostile PDF
 *   (e.g. a compression bomb) cannot block the server's event loop or exhaust its heap
 * - timeout: the worker is terminated after `parseTimeoutMs` (status `parse_timeout`)
 * - page limit: only the first `maxPages` pages are parsed
 * - text limit: raw text is cut before cleaning, the returned text is capped and always cleaned as
 *   UNTRUSTED input
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

/** Heap limit of a parser worker. */
export const PARSER_WORKER_MAX_OLD_GENERATION_MB = 256;
/** Parser workers allowed at the same time; further requests fail fast instead of queueing. */
export const MAX_CONCURRENT_PARSERS = 2;

/** Terminating/destroying a parser must never hang the request either. */
const DESTROY_TIMEOUT_MS = 2_000;
const MAX_PARSE_ERROR_CHARS = 200;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Raw text kept per character finally returned (cleaning may remove characters). */
const RAW_TEXT_FACTOR = 4;

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
  /** `rawLength` is the length of the full extracted text when the extractor already cut it. */
  readonly result: Promise<{ text: string; total: number; rawLength?: number }>;
  readonly destroy: () => Promise<void>;
}
export type PdfTextExtractor = (data: Uint8Array, opts: { maxPages: number; maxRawChars: number }) => PdfTextJob;

/**
 * Worker body (CommonJS, evaluated in its own thread). It receives the PDF bytes (transferred, not copied),
 * extracts the text layer with pdf-parse — without page markers, so a PDF without text yields no text —
 * cuts the raw text and posts the result back. `isEvalSupported: false` disables pdf.js code generation.
 */
const PARSER_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let parser;
  try {
    const { PDFParse } = require(workerData.pdfParsePath);
    const { CanvasFactory } = require(workerData.canvasFactoryPath);
    parser = new PDFParse({ data: new Uint8Array(workerData.bytes), CanvasFactory, isEvalSupported: false });
    const r = await parser.getText({ first: workerData.maxPages, pageJoiner: "" });
    const text = typeof r.text === "string" ? r.text : "";
    parentPort.postMessage({ ok: true, text: text.slice(0, workerData.maxRawChars), rawLength: text.length, total: r.total });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (parser) await parser.destroy().catch(() => undefined);
  }
})();
`;

let activeParsers = 0;
let modulePaths: { pdfParsePath: string; canvasFactoryPath: string } | null = null;

function parserModulePaths(): { pdfParsePath: string; canvasFactoryPath: string } {
  if (!modulePaths) {
    const require = createRequire(import.meta.url);
    modulePaths = { pdfParsePath: require.resolve("pdf-parse"), canvasFactoryPath: require.resolve("pdf-parse/worker") };
  }
  return modulePaths;
}

/** Default extractor: pdf-parse in an isolated, memory-limited worker thread; `destroy` terminates it. */
export const workerPdfExtractor: PdfTextExtractor = (data, { maxPages, maxRawChars }) => {
  if (activeParsers >= MAX_CONCURRENT_PARSERS) {
    return {
      result: Promise.reject(new Error("PDF parser busy (concurrency limit reached); try again shortly")),
      destroy: async () => undefined,
    };
  }
  activeParsers += 1;
  // Copy into a standalone ArrayBuffer and transfer it, so the caller's Buffer stays intact.
  const bytes = data.slice().buffer;
  const worker = new Worker(PARSER_WORKER_SOURCE, {
    eval: true,
    workerData: { bytes, maxPages, maxRawChars, ...parserModulePaths() },
    transferList: [bytes],
    resourceLimits: { maxOldGenerationSizeMb: PARSER_WORKER_MAX_OLD_GENERATION_MB, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true,
    stderr: true,
  });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeParsers -= 1;
    }
  };
  const result = new Promise<{ text: string; total: number; rawLength?: number }>((resolve, reject) => {
    worker.once("message", (m: { ok: boolean; text?: string; total?: number; rawLength?: number; error?: string }) => {
      if (m.ok) resolve({ text: m.text ?? "", total: typeof m.total === "number" ? m.total : Number.NaN, rawLength: m.rawLength });
      else reject(new Error(m.error ?? "PDF parsing failed"));
    });
    worker.once("error", (err: Error & { code?: string }) => {
      reject(
        new Error(
          err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "PDF parsing exceeded the memory limit and was aborted" : err.message,
        ),
      );
    });
    worker.once("exit", (code) => {
      release();
      if (code !== 0) reject(new Error(`PDF parser stopped (exit code ${code})`));
    });
  });
  return {
    result,
    destroy: async () => {
      await worker.terminate().catch(() => undefined);
      release();
    },
  };
};

/** Media type without parameters; anything that is not a plain `type/subtype` token is dropped (header is untrusted). */
function normalizeMimeType(contentType: string): string | null {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : null;
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

/** Merge limit overrides; non-finite or non-positive overrides fall back to the defaults (never "unlimited"). */
function resolveLimits(overrides: Partial<FileInspectionLimits> = {}): FileInspectionLimits {
  const pick = (key: keyof FileInspectionLimits): number => {
    const v = overrides[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_FILE_LIMITS[key];
  };
  return { maxBytes: pick("maxBytes"), parseTimeoutMs: pick("parseTimeoutMs"), maxPages: pick("maxPages"), maxTextCharacters: pick("maxTextCharacters") };
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
  extractor: PdfTextExtractor = workerPdfExtractor,
): Promise<FileInspectionResult> {
  assertValidFileId(fileId);
  const limits = resolveLimits(opts.limits);
  const requested = Number.isFinite(opts.maxCharacters) ? Math.floor(opts.maxCharacters) : limits.maxTextCharacters;
  const maxChars = Math.max(0, Math.min(requested, limits.maxTextCharacters));
  const maxRawChars = maxChars * RAW_TEXT_FACTOR + 1_000;

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

  // Defence in depth: never trust that the client honoured maxBytes.
  if (data.length > limits.maxBytes) {
    return { ...base, status: "file_too_large", mimeType: null, byteLength: data.length, sha256: null, isPdf: null };
  }
  const mimeType = normalizeMimeType(contentType);
  // Hash the exact bytes before parsing (the parser may transfer/detach buffers).
  const sha256 = createHash("sha256").update(data).digest("hex");
  const isPdf = mimeType === "application/pdf" || looksLikePdf(data);
  const common = { ...base, mimeType, byteLength: data.length, sha256, isPdf };

  if (!isPdf) return { ...common, status: "unsupported_file_type" };

  let job: PdfTextJob | undefined;
  try {
    job = extractor(new Uint8Array(data), { maxPages: limits.maxPages, maxRawChars });
    // A late rejection after a timeout must not become an unhandled rejection.
    job.result.catch(() => undefined);
    const outcome = await withTimeout(job.result, limits.parseTimeoutMs);
    if (outcome.timedOut) return { ...common, status: "parse_timeout" };

    const { text: extracted, total, rawLength } = outcome.value;
    const pageCount = Number.isInteger(total) && total >= 0 ? total : null;
    const pagesParsed = pageCount === null ? null : Math.min(pageCount, limits.maxPages);
    const pageLimitApplied = pageCount !== null && pageCount > limits.maxPages;

    // Cut huge raw text before the (allocation-heavy) cleaning step.
    const rawCut = extracted.length > maxRawChars || (typeof rawLength === "number" && rawLength > extracted.length);
    const rawText = extracted.length > maxRawChars ? extracted.slice(0, maxRawChars) : extracted;
    const cleaned = cleanUntrustedText(rawText.trim(), { maxChars });
    // Availability is judged on the full cleaned text, not on what the cap leaves over (maxChars may be 0).
    const textAvailable = sanitizeUntrustedText(rawText, { maxChars: 1, singleLine: true }).cleanedLength > 0;
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
      textTruncated: cleaned.truncated || pageLimitApplied || rawCut,
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
