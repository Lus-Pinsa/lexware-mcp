import { LexwareApiError, ResponseTooLargeError, UnsafeRequestPathError, describeErrorBody } from "./errors.js";
import { RateLimiter } from "./rate-limiter.js";

export interface LexwareClientOptions {
  baseUrl: string;
  apiKey: string;
  /** When true, log method/path/status (never bodies or secrets). */
  debug?: boolean;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter source in [0,1). Injectable for deterministic tests. */
  random?: () => number;
  /** Max retry attempts for retryable failures (429 / transient). Default 4. */
  maxRetries?: number;
  /** Abort an in-flight request after this many ms (a hung upstream otherwise blocks forever). Default 30000. */
  requestTimeoutMs?: number;
  rateLimit?: { capacity: number; refillPerSec: number };
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Whether the call is safe to retry on a transport/5xx failure. GETs are
   * idempotent; POSTs that create documents are NOT and must never be replayed
   * on an ambiguous failure (would create duplicates). 429 is always retryable
   * (Lexware does not execute a throttled call) regardless of this flag.
   */
  idempotent: boolean;
}

export interface BinaryOptions {
  /** Abort and throw {@link ResponseTooLargeError} once the body exceeds this many bytes. */
  maxBytes?: number;
}

/**
 * Refuse request paths the WHATWG URL parser would rewrite: `.`/`..` segments (including percent-encoded
 * forms), backslashes (treated as `/`) and TAB/CR/LF (silently removed). Otherwise an id like ".." passed
 * through encodeURIComponent, or a raw "\\", could climb out of the intended resource.
 */
export function assertSafeRequestPath(path: string): void {
  if (/[\\\t\r\n]/.test(path)) throw new UnsafeRequestPathError("path contains a backslash or control whitespace");
  const pathOnly = path.split(/[?#]/, 1)[0];
  for (const segment of pathOnly.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Malformed or overlong escapes (e.g. "%zz", "%c0%ae") have no meaning for a client; a server might still
      // decode them leniently, so they are refused.
      throw new UnsafeRequestPathError("path contains malformed percent-encoding");
    }
    for (const ch of decoded) {
      const code = ch.codePointAt(0) ?? 0;
      // Encoded control characters (e.g. "..%00") could be truncated or stripped by a server.
      if (code < 0x20 || code === 0x7f) throw new UnsafeRequestPathError("path contains an encoded control character");
    }
    // Encoded separators (%2F, %5C) and ";" matrix parameters ("..;x") could form a dot segment on a server
    // that decodes or strips them, so every decoded sub-segment is checked.
    for (const part of decoded.split(/[/\\]/)) {
      const base = part.split(";", 1)[0];
      if (base === "." || base === "..") throw new UnsafeRequestPathError("path contains a dot segment");
    }
  }
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
/** Redirect statuses. Followed only for GET, only within the configured Lexware origin, at most MAX_REDIRECTS times. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** A redirect was refused (other origin, non-GET, or too many hops). Not retried. */
class RedirectRefusedError extends LexwareApiError {}
/** Clamp any retry wait so a hostile/buggy `Retry-After` can't hang a request. */
const MIN_RETRY_WAIT_MS = 250;
const MAX_RETRY_WAIT_MS = 30_000;

/** Thin, rate-limited, retry-aware client for the Lexware Office REST API. */
export class LexwareClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly debug: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly limiter: RateLimiter;

  constructor(opts: LexwareClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.debug = opts.debug ?? false;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 4;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    const rl = opts.rateLimit ?? { capacity: 2, refillPerSec: 2 };
    this.limiter = new RateLimiter(rl.capacity, rl.refillPerSec, opts.now, this.sleep);
  }

  get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, { query, idempotent: true });
  }

  /** POST is treated as non-idempotent: never auto-retried on transport/5xx errors. */
  post<T>(path: string, body: unknown, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("POST", path, { body, query, idempotent: false });
  }

  async request<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(opts.body);
    }
    const res = await this.sendWithRetry(method, path, {
      query: opts.query,
      headers,
      body: bodyText,
      idempotent: opts.idempotent,
    });
    try {
      return (await this.safeParse(res)) as T;
    } catch (err) {
      throw this.bodyReadError(method, path, err);
    }
  }

  /**
   * GET a binary resource (a rendered document PDF or an uploaded file). GETs are
   * idempotent, so this is retried like {@link get} on 429 / transient failures.
   * Returns the raw bytes plus the response content-type.
   */
  async getBinary(
    path: string,
    accept = "application/pdf",
    options: BinaryOptions = {},
  ): Promise<{ data: Buffer; contentType: string }> {
    const { maxBytes } = options;
    // A malformed limit must never silently mean "unlimited": refuse before sending anything.
    if (maxBytes !== undefined && !(Number.isFinite(maxBytes) && maxBytes >= 0)) {
      throw new RangeError("maxBytes must be a finite number >= 0");
    }
    const res = await this.sendWithRetry("GET", path, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: accept },
      idempotent: true,
    });
    const contentType = res.headers.get("content-type") ?? accept;
    if (maxBytes === undefined) {
      try {
        return { data: Buffer.from(await res.arrayBuffer()), contentType };
      } catch (err) {
        throw this.bodyReadError("GET", path, err);
      }
    }

    // Size-limited read: refuse early on a declared oversize body, otherwise stop as soon as the limit is passed.
    const lengthHeader = res.headers.get("content-length")?.trim() ?? "";
    const declaredBytes = /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    if (declaredBytes !== null && declaredBytes > maxBytes) {
      await this.drain(res);
      throw new ResponseTooLargeError(maxBytes, declaredBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new ResponseTooLargeError(maxBytes, declaredBytes);
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err;
      throw this.bodyReadError("GET", path, err);
    }
    return { data: Buffer.concat(chunks, total), contentType };
  }

  /**
   * POST a multipart/form-data upload: a single `file` part plus optional string
   * fields. Like {@link post} this is NON-idempotent — never replayed on a
   * transport/5xx failure (a duplicate upload risk); 429 is still retried.
   *
   * IMPORTANT: we deliberately do NOT set a Content-Type header — `fetch` derives
   * the `multipart/form-data; boundary=…` value from the FormData body. Setting it
   * manually drops the boundary and the upload fails.
   */
  async postMultipart<T>(
    path: string,
    file: { bytes: Uint8Array; filename: string; contentType: string },
    fields: Record<string, string> = {},
  ): Promise<T> {
    const form = new FormData();
    // A Uint8Array/Buffer is a valid BlobPart at runtime (Blob copies the view's
    // bytes, honoring byteOffset/length), but the DOM lib types BlobPart as
    // ArrayBuffer-backed only; the cast bridges that without an extra copy.
    const blob = new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType });
    form.set("file", blob, file.filename);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const res = await this.sendWithRetry("POST", path, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      body: form,
      idempotent: false,
    });
    return (await this.safeParse(res)) as T;
  }

  /**
   * Shared transport for every verb: rate-limit, fetch with a timeout, retry per
   * policy, and throw {@link LexwareApiError} on a non-OK status. Returns the
   * successful `Response` for the caller to parse (JSON or binary). 429 is always
   * retried; transport/5xx failures are retried only for idempotent calls.
   */
  private async sendWithRetry(
    method: string,
    path: string,
    opts: {
      query?: RequestOptions["query"];
      headers: Record<string, string>;
      body?: BodyInit;
      idempotent: boolean;
    },
  ): Promise<Response> {
    const url = this.buildUrl(path, opts.query);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await this.fetchWithinOrigin(url, {
          method,
          headers: opts.headers,
          body: opts.body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        if (err instanceof RedirectRefusedError) {
          this.log(method, path, "redirect-refused");
          throw err;
        }
        // Transport failure (DNS, reset) or our own request timeout (AbortSignal).
        // The request may or may not have reached Lexware, so only retry idempotent calls.
        if (opts.idempotent && attempt < this.maxRetries) {
          await this.backoff(attempt++);
          continue;
        }
        this.log(method, path, "network-error");
        throw new LexwareApiError(
          0,
          `Network error contacting Lexware${
            opts.idempotent ? "" : " (POST not retried to avoid duplicates)"
          }: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }

      this.log(method, path, String(res.status));

      // 429 is always safe to retry: a throttled call is not executed.
      if (res.status === 429 && attempt < this.maxRetries) {
        const waitMs = this.retryAfterMs(res, attempt);
        await this.drain(res); // release the keep-alive connection before retrying
        await this.sleep(waitMs);
        attempt++;
        continue;
      }
      // Transient upstream errors: retry only idempotent calls.
      if (RETRYABLE_STATUS.has(res.status) && opts.idempotent && attempt < this.maxRetries) {
        await this.drain(res); // release the keep-alive connection before retrying
        await this.backoff(attempt++);
        continue;
      }

      if (!res.ok) {
        // Read the error body defensively: if the body stream fails mid-read we still
        // throw a LexwareApiError carrying the real status (so e.g. a 404 stays a 404
        // and isNotFound() keeps working), just without the parsed detail.
        let body: unknown;
        try {
          body = await this.safeParse(res);
        } catch {
          body = undefined;
        }
        // An upstream that echoes request headers must not leak the API key into a tool error.
        const message = this.redactApiKey(describeErrorBody(res.status, res.statusText, body));
        throw new LexwareApiError(res.status, message, this.redactApiKeyInBody(body));
      }

      return res;
    }
  }

  /**
   * fetch, following redirects only within the configured Lexware origin and only for GET. A redirect to any other
   * host is refused instead of followed: the server must never contact a host it was not configured for.
   */
  private async fetchWithinOrigin(url: string, init: RequestInit): Promise<Response> {
    const origin = new URL(this.baseUrl).origin;
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await this.fetchFn(current, { ...init, redirect: "manual" });
      if (!REDIRECT_STATUS.has(res.status)) return res;
      const location = res.headers.get("location");
      await this.drain(res);
      let next: URL | null = null;
      try {
        next = location ? new URL(location, current) : null;
      } catch {
        next = null;
      }
      if (next === null || next.origin !== origin || init.method !== "GET" || hop >= MAX_REDIRECTS) {
        const why = next !== null && next.origin !== origin ? "to another origin" : init.method !== "GET" ? "for a non-GET request" : "";
        throw new RedirectRefusedError(res.status, `Refused Lexware redirect ${why} (HTTP ${res.status}).`.replace("  ", " "));
      }
      current = next.toString();
    }
  }

  private redactApiKey(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join("[REDACTED]") : text;
  }

  private redactApiKeyInBody(body: unknown): unknown {
    if (body === undefined || this.apiKey.length === 0) return body;
    try {
      const json = JSON.stringify(body);
      return json !== undefined && json.includes(this.apiKey) ? JSON.parse(this.redactApiKey(json)) : body;
    } catch {
      return undefined;
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    assertSafeRequestPath(path);
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** Discard an abandoned response body so undici can reuse the keep-alive socket. */
  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // Best-effort: a body already errored/closed is fine to ignore.
    }
  }

  /** Map a failure while reading a response body to a classified network error. */
  private bodyReadError(method: string, path: string, err: unknown): LexwareApiError {
    this.log(method, path, "body-read-error");
    return new LexwareApiError(
      0,
      `Network error reading Lexware response: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  /** Parse a response body as JSON when possible, otherwise return text/undefined. */
  private async safeParse(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  /** Wait per `Retry-After` if present (clamped), else jittered exponential backoff. */
  private retryAfterMs(res: Response, attempt: number): number {
    const header = res.headers.get("retry-after");
    if (header) {
      const trimmed = header.trim();
      let ms: number | undefined;
      if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
        ms = Number(trimmed) * 1000;
      } else {
        const date = Date.parse(trimmed);
        if (!Number.isNaN(date)) ms = date - this.now();
      }
      if (ms !== undefined) {
        // Clamp: never hammer (floor) and never hang for minutes/hours (ceiling).
        return Math.min(MAX_RETRY_WAIT_MS, Math.max(MIN_RETRY_WAIT_MS, ms));
      }
    }
    return this.backoffMs(attempt);
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.backoffMs(attempt));
  }

  /** Exponential backoff with full jitter, capped at 8s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(8000, 500 * 2 ** attempt);
    return Math.floor(base * (0.5 + this.random() * 0.5));
  }

  private log(method: string, path: string, status: string): void {
    if (this.debug) {
      // Path only — never query (may contain filters), never headers/body.
      console.error(`[lexware] ${method} ${path.split("?")[0]} -> ${status}`);
    }
  }
}
