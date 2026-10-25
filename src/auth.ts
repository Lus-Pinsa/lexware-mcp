import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface BearerAuthOptions {
  /**
   * Trust the right-most `X-Forwarded-For` entry as the client address. Only safe behind a proxy that APPENDS
   * the real peer (Render does). Off by default: without a trusted proxy the header is attacker-controlled
   * (rotating it would bypass the lockout, forging it would lock out a chosen victim).
   */
  trustProxy?: boolean;
  limiter?: FailedAuthLimiter;
}

/**
 * Express middleware enforcing a static bearer token on a route.
 *
 * Uses a constant-time comparison to avoid leaking the token via timing. The
 * token length is treated as non-secret (lengths are compared first, which
 * `timingSafeEqual` requires anyway).
 *
 * Failed attempts are throttled per client, but the token is checked FIRST: a request carrying the valid
 * token is never answered with 429. Behind a shared egress (the claude.ai connector pool, a corporate NAT) a
 * stranger's wrong tokens therefore cannot lock out the real connector; they only earn the stranger a 429.
 */
export function bearerAuthMiddleware(token: string, options: BearerAuthOptions = {}): RequestHandler {
  const expected = Buffer.from(token, "utf8");
  const limiter = options.limiter ?? new FailedAuthLimiter();
  const trustProxy = options.trustProxy === true;
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const provided =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const providedBuf = Buffer.from(provided, "utf8");
    const ok =
      providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
    const client = clientKey(req, trustProxy);
    if (ok) {
      limiter.succeed(client);
      next();
      return;
    }
    const retryAfter = limiter.blockedFor(client);
    if (retryAfter > 0) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too_many_failed_attempts" });
      return;
    }
    if (limiter.fail(client)) {
      console.error(
        `[lexware-mcp] auth: client locked out after repeated invalid tokens (keyHash=${fingerprintForLog(client)})`,
      );
    }
    // RFC 9110 §11.6.1: a 401 MUST carry a WWW-Authenticate challenge so clients
    // know a bearer token is expected (mirrors the OAuth path's behaviour).
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    res.status(401).json({ error: "unauthorized" });
  };
}

/** Log a client key only as a hash: it comes from a request header (log injection, PII). */
function fingerprintForLog(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * Client key for failed-auth throttling.
 *
 * With `trustProxy` the right-most `X-Forwarded-For` entry is used: behind Render's proxy `req.ip` is the
 * proxy, and the proxy APPENDS the real peer, so the right-most entry is the one a client cannot forge.
 * Without it the TCP peer address is used. IPv6 addresses are keyed by their /64 so a client cannot escape
 * the lockout by rotating through its own prefix.
 */
export function clientKey(req: Request, trustProxy = false): string {
  let address: string | undefined;
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    address = raw?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  }
  address ||= req.socket?.remoteAddress || undefined;
  if (!address) return "unknown";
  return normalizeAddress(address);
}

/** Strip an IPv4-mapped prefix; collapse IPv6 to its /64. Non-IP strings are kept as is. */
export function normalizeAddress(address: string): string {
  const unmapped = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  if (isIP(unmapped) !== 6) return unmapped;
  // Expand "::" so the first four hextets can be read off.
  const [head, tail = ""] = unmapped.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = [...headParts, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...tailParts];
  return `${full.slice(0, 4).map((h) => h.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

/**
 * Locks a client out for `lockMs` after `maxFailures` invalid tokens within `windowMs`. A valid token is
 * never counted (and clears the client's failure window), and the lockout is per client. Memory is bounded
 * (`maxClients`): when full, expired entries are evicted first, then the oldest UNLOCKED ones; an active
 * lockout is never dropped to make room.
 */
export class FailedAuthLimiter {
  private readonly entries = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000,
    private readonly maxClients = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds the client is still locked out (0 = not locked). */
  blockedFor(client: string): number {
    const e = this.entries.get(client);
    const t = this.now();
    return e && e.lockedUntil > t ? Math.ceil((e.lockedUntil - t) / 1000) : 0;
  }

  /** A valid token clears the client's failure window (an active lockout is kept until it expires). */
  succeed(client: string): void {
    const e = this.entries.get(client);
    if (e && e.lockedUntil <= this.now()) this.entries.delete(client);
  }

  /** Record a failure; returns true when this failure triggered a lockout. */
  fail(client: string): boolean {
    const t = this.now();
    let e = this.entries.get(client);
    if (!e || t - e.windowStart > this.windowMs) {
      if (!e && this.entries.size >= this.maxClients) this.evict(t);
      e = { failures: 0, windowStart: t, lockedUntil: 0 };
      this.entries.set(client, e);
    }
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockMs;
      e.failures = 0;
      e.windowStart = t;
      return true;
    }
    return false;
  }

  /** Number of tracked clients (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  private evict(t: number): void {
    for (const [k, v] of this.entries) {
      if (v.lockedUntil <= t && t - v.windowStart > this.windowMs) this.entries.delete(k);
    }
    // Still full: drop the oldest unlocked windows (Map iteration is insertion order). Locked entries stay.
    for (const [k, v] of this.entries) {
      if (this.entries.size < this.maxClients) break;
      if (v.lockedUntil <= t) this.entries.delete(k);
    }
  }
}
