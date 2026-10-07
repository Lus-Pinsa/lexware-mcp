import type { BinaryOptions, LexwareClient } from "./client.js";
import { assertSafeRequestPath } from "./client.js";
import { UnsafeRequestPathError } from "./errors.js";

/**
 * GET-only view of the Lexware client for read-only code paths (finance pipeline, file inspection).
 *
 * The facade is a frozen object holding two closures. It exposes no reference to the underlying client,
 * so a cast cannot reach `post`, `postMultipart` or `request`, and every path is checked against a read
 * allowlist before the call. This is the type-level and runtime counterpart of the read-only tests in
 * tests/finance-policy.test.ts.
 */
export type ReadQuery = Record<string, string | number | boolean | undefined>;

export interface ReadOnlyLexwareClient {
  readonly get: <T>(path: string, query?: ReadQuery) => Promise<T>;
  readonly getBinary: (
    path: string,
    accept?: string,
    options?: BinaryOptions,
  ) => Promise<{ data: Buffer; contentType: string }>;
}

/** Lexware resources the finance pipeline may read. A path matches an entry exactly or as `<entry>/…`. */
export const FINANCE_READ_PATHS: readonly string[] = Object.freeze([
  "/v1/voucherlist",
  "/v1/vouchers",
  "/v1/invoices",
  "/v1/credit-notes",
  "/v1/down-payment-invoices",
  "/v1/payments",
  "/v1/posting-categories",
  "/v1/files",
  "/v1/profile",
  "/v1/contacts",
]);

/** Throw unless `path` is a clean absolute path on the allowlist. */
export function assertReadPathAllowed(path: string, allowed: readonly string[] = FINANCE_READ_PATHS): void {
  if (typeof path !== "string" || !path.startsWith("/")) throw new UnsafeRequestPathError("path must be absolute");
  if (/[?#\\\s]/.test(path)) throw new UnsafeRequestPathError("query, fragment, backslash or whitespace in path");
  if (path.includes("//")) throw new UnsafeRequestPathError("empty path segment");
  assertSafeRequestPath(path);
  const ok = allowed.some((entry) => path === entry || path.startsWith(`${entry}/`));
  if (!ok) throw new UnsafeRequestPathError("path is not on the read allowlist");
}

/** Build the frozen GET-only facade around a full client. */
export function createReadOnlyLexwareClient(
  client: Pick<LexwareClient, "get" | "getBinary">,
  allowed: readonly string[] = FINANCE_READ_PATHS,
): ReadOnlyLexwareClient {
  const get = <T>(path: string, query?: ReadQuery): Promise<T> => {
    try {
      assertReadPathAllowed(path, allowed);
    } catch (err) {
      return Promise.reject(err);
    }
    return client.get<T>(path, query);
  };
  const getBinary = (path: string, accept?: string, options?: BinaryOptions) => {
    try {
      assertReadPathAllowed(path, allowed);
    } catch (err) {
      return Promise.reject(err);
    }
    return client.getBinary(path, accept, options);
  };
  return Object.freeze({ get, getBinary });
}
