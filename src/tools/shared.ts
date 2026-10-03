import type { LexwareClient } from "../lexware/client.js";
import { isNotFound } from "../lexware/errors.js";
import type { Paged } from "../lexware/types.js";

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 25;

/** Tool annotations, shared so semantics can't drift across tool files. */
export const RO = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;
export const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;
/** Read-only and purely local (no external reach), e.g. building a deeplink string. */
export const LOCAL_RO = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;

/** Wrap a string as MCP text content. */
export function text(message: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text: message }];
}

/**
 * Standard result for a paged list tool.
 *
 * Important:
 * Some MCP clients primarily expose the text content to the model and may not
 * reliably surface structuredContent. Therefore this helper returns both:
 *
 * 1. the COMPLETE paged API response in structuredContent
 * 2. the actual rows mirrored into the text response
 *
 * This allows Claude and other MCP clients to see ids, dates, names, amounts,
 * statuses and other list fields instead of receiving only a page summary.
 */
export function pagedResult<T>(result: Paged<T>, noun: string) {
  // An empty result set has totalPages 0; render "page 1/1" rather than "page 1/0".
  const totalPages = Math.max(result.totalPages, 1);

  const rows = result.content ?? [];

  // Keep text responses bounded. structuredContent still contains the complete
  // page returned by Lexware. If a caller requests a larger page, only the first
  // 50 rows are mirrored into text to avoid unnecessarily large MCP responses.
  const maxRowsInText = 50;
  const visibleRows = rows.slice(0, maxRowsInText);

  const summary =
    `Found ${result.totalElements} ${noun}; ` +
    `showing page ${result.number + 1}/${totalPages}; ` +
    `${rows.length} row(s) on this page.`;

  const rowsText =
    visibleRows.length > 0
      ? `\n\nRows (${visibleRows.length}/${rows.length} on this page):\n` +
        JSON.stringify(visibleRows, null, 2)
      : `\n\nRows: []`;

  const truncationNotice =
    rows.length > maxRowsInText
      ? `\n\nText output limited to the first ${maxRowsInText} rows of this page. ` +
        `The complete page remains available in structuredContent. ` +
        `Request a smaller page size or another page when individual rows beyond this limit are needed.`
      : "";

  return {
    // Preserve the COMPLETE API page, including content[] and all page metadata.
    structuredContent: result,

    // Mirror the actual rows into text for MCP clients that otherwise expose only
    // the human-readable summary to the model.
    content: text(summary + rowsText + truncationNotice),
  };
}

/**
 * MCP embedded-resource content block for a binary payload. Inlined (rather than
 * importing Skybridge's `embeddedResource`) so the tools layer stays independent
 * of the Skybridge runtime, per AGENTS.md.
 */
function embeddedResourceBlock(uri: string, mimeType: string, data: Buffer) {
  return {
    type: "resource" as const,
    resource: { uri, mimeType, blob: data.toString("base64") },
  };
}

/**
 * Standard result for a binary-download tool: structured metadata, a one-line
 * summary, and the file inline as an embedded resource. Shared by every
 * PDF/file download tool so the envelope shape can't drift across them.
 */
export function binaryResult(opts: {
  uri: string;
  data: Buffer;
  contentType: string;
  structuredContent: Record<string, unknown>;
  message: string;
}) {
  return {
    structuredContent: opts.structuredContent,
    content: [...text(opts.message), embeddedResourceBlock(opts.uri, opts.contentType, opts.data)],
  };
}

/**
 * Decode a base64 string to bytes, rejecting malformed input instead of silently
 * producing garbage. `Buffer.from(s, "base64")` skips invalid characters, so a
 * value like a leftover `data:...;base64,` prefix or a truncated payload would
 * otherwise upload corrupt bytes and report success. Accepts standard and
 * URL-safe alphabets and tolerates a data-URI prefix / embedded whitespace.
 */
export function decodeBase64Strict(input: string, field = "file"): Buffer {
  let s = input.trim();

  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma >= 0) s = s.slice(comma + 1);
  }

  s = s.replace(/\s+/g, "");

  if (!s) {
    throw new Error(`${field}: base64 content is empty.`);
  }

  // Validate the alphabet and length up front.
  const body = s.replace(/=+$/, "");

  if (!/^[A-Za-z0-9+/_-]*$/.test(body) || body.length % 4 === 1) {
    throw new Error(
      `${field}: invalid base64 (non-base64 characters or wrong length). ` +
        `Pass the raw base64 without a data-URI prefix.`,
    );
  }

  return Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

/**
 * DELETE a resource idempotently.
 *
 * A 404 means the resource is already absent and is therefore treated as a
 * successful outcome. This is useful for retries where a previous DELETE may
 * already have succeeded.
 */
export async function deleteIdempotent(
  client: LexwareClient,
  path: string,
): Promise<{ deleted: true; alreadyAbsent: boolean }> {
  try {
    await client.request<unknown>("DELETE", path, { idempotent: true });
    return { deleted: true, alreadyAbsent: false };
  } catch (e) {
    if (isNotFound(e)) {
      return { deleted: true, alreadyAbsent: true };
    }

    throw e;
  }
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-modify-write merge.
 *
 * Overlay `patch` onto `base`, recursing into nested objects so partial updates
 * don't wipe sibling fields.
 *
 * Arrays and scalars replace wholesale.
 * `undefined` means "leave unchanged".
 * `null` means "clear explicitly".
 *
 * Lexware PUT requests replace the whole resource, therefore update tools must
 * fetch the current object first and merge the requested patch into it.
 */
export function deepMergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = out[key];

    out[key] =
      isPlainObject(value) && isPlainObject(existing)
        ? deepMergePatch(existing, value)
        : value;
  }

  return out;
}

/**
 * Merge a contact's address collection by INDEX.
 *
 * This is intentionally different from deepMergePatch because addresses are
 * arrays of objects. A partial address patch should update the corresponding
 * existing address instead of replacing the complete address object.
 */
export function mergeAddresses(
  current: unknown,
  patch: unknown,
): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const pat = isPlainObject(patch) ? patch : {};

  const out: Record<string, unknown> = { ...cur };

  for (const [key, value] of Object.entries(pat)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      const base = Array.isArray(cur[key])
        ? (cur[key] as unknown[])
        : [];

      const merged = value.map((entry, i) =>
        isPlainObject(entry) && isPlainObject(base[i])
          ? deepMergePatch(base[i], entry)
          : entry,
      );

      // Preserve existing addresses beyond the patch length.
      out[key] =
        base.length > value.length
          ? merged.concat(base.slice(value.length))
          : merged;
    } else {
      out[key] = value;
    }
  }

  return out;
}
