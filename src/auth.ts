import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express middleware enforcing a static bearer token on a route.
 *
 * Uses a constant-time comparison to avoid leaking the token via timing. The
 * token length is treated as non-secret (lengths are compared first, which
 * `timingSafeEqual` requires anyway).
 */
export function bearerAuthMiddleware(
  token: string,
  limiter: FailedAuthLimiter = new FailedAuthLimiter(),
): RequestHandler {
  const expected = Buffer.from(token, "utf8");
  return (req: Request, res: Response, next: NextFunction): void => {
    const client = clientKey(req);
    const retryAfter = limiter.blockedFor(client);
    if (retryAfter > 0) {
      res.set("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too_many_failed_attempts" });
      return;
    }
    const header = req.headers.authorization;
    const provided =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const providedBuf = Buffer.from(provided, "utf8");
    const ok =
      providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
    if (!ok) {
      if (limiter.fail(client)) {
        console.error(
          `[lexware-mcp] auth: client locked out after repeated invalid tokens (keyHash=${fingerprintForLog(client)})`,
        );
      }
      // RFC 9110 §11.6.1: a 401 MUST carry a WWW-Authenticate challenge so clients
      // know a bearer token is expected (mirrors the OAuth path's behaviour).
      res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t\f\v\0\x00-\x1F\x7F]/g, " ");
}

function fingerprintForLog(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * Client key for failed-auth throttling. Behind Render's proxy `req.ip` is the proxy; the proxy APPENDS
 * the real peer to X-Forwarded-For, so the right-most entry is the one a client cannot forge.
 */
export function clientKey(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : xff;
  const last = raw?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || req.socket?.remoteAddress || "unknown";
}

/**
 * Locks a client out for `lockMs` after `maxFailures` invalid tokens within `windowMs`. A valid token is
 * never counted, and the lockout is per client, so a stranger guessing tokens cannot lock out the real
 * connector. Memory is bounded (`maxClients`).
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

  /** Record a failure; returns true when this failure triggered a lockout. */
  fail(client: string): boolean {
    const t = this.now();
    let e = this.entries.get(client);
    if (!e || t - e.windowStart > this.windowMs) {
      if (!e && this.entries.size >= this.maxClients) {
        for (const [k, v] of this.entries) if (v.lockedUntil <= t && t - v.windowStart > this.windowMs) this.entries.delete(k);
        if (this.entries.size >= this.maxClients) this.entries.clear();
      }
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
}
