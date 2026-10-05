import { createHash } from "node:crypto";

import type { McpServer } from "skybridge/server";
import { z } from "zod";

import { CanvasFactory } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";

import type { LexwareClient } from "../lexware/client.js";

import {
  RO,
  WRITE,
  binaryResult,
  decodeBase64Strict,
  text,
} from "./shared.js";

/**
 * Maximum amount of extracted PDF text returned to the MCP client.
 *
 * Typical invoices are far smaller than this. The limit exists only
 * to prevent accidentally returning an extremely large PDF as one
 * tool response.
 */
const DEFAULT_MAX_TEXT_CHARACTERS = 50_000;
const MAX_TEXT_CHARACTERS = 200_000;

/**
 * Detect a PDF from its file header.
 *
 * Lexware normally returns application/pdf, but this fallback allows
 * extraction even if the upstream MIME type is application/octet-stream.
 */
function looksLikePdf(data: Buffer): boolean {
  if (data.length < 5) {
    return false;
  }

  return data
    .subarray(0, 5)
    .toString("ascii") === "%PDF-";
}

/**
 * Normalize the MIME type because HTTP Content-Type may include
 * additional parameters.
 */
function normalizeMimeType(
  contentType: string,
): string {
  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/**
 * Create a stable SHA-256 fingerprint of the exact file bytes.
 *
 * Identical hashes mean the downloaded file bytes are identical.
 */
function sha256(
  data: Buffer,
): string {
  return createHash("sha256")
    .update(data)
    .digest("hex");
}

/**
 * Read tools for the file store.
 *
 * Always registered.
 */
export function registerFileReadTools(
  server: McpServer,
  client: LexwareClient,
): void {
  /*
   * Existing raw binary download tool.
   */
  server.registerTool(
    {
      name: "download-file",

      description:
        "Download a file (a rendered document PDF or an uploaded receipt) by its file id. Returns the " +
        "bytes inline as an embedded resource. File ids come from render-*-pdf, upload-file, or a voucher's files.",

      inputSchema: {
        id: z
          .string()
          .describe(
            "The Lexware file id.",
          ),

        accept: z
          .string()
          .optional()
          .describe(
            'Preferred MIME type to request, e.g. "application/pdf". Defaults to any type.',
          ),
      },

      annotations: RO,
    },

    async ({
      id,
      accept,
    }) => {
      const {
        data,
        contentType,
      } =
        await client.getBinary(
          `/v1/files/${encodeURIComponent(id)}`,
          accept ?? "*/*",
        );

      return binaryResult({
        uri:
          `lexware://files/${id}`,

        data,

        contentType,

        structuredContent: {
          fileId:
            id,

          mimeType:
            contentType,

          byteLength:
            data.length,
        },

        message:
          `Downloaded file ${id} (${data.length} bytes, ${contentType}).`,
      });
    },
  );

  /*
   * READ-ONLY PDF text extraction and file fingerprinting.
   *
   * Primary LU'S use case:
   *
   * - read original voucher PDFs whose Lexware voucherItems are empty
   * - make invoice positions visible to Claude
   * - calculate SHA-256 for exact duplicate-file comparison
   *
   * This tool never writes to Lexware.
   */
  server.registerTool(
    {
      name:
        "get-voucher-file-text",

      description:
        "READ-ONLY: Download a Lexware voucher/receipt file, calculate its SHA-256 fingerprint and, when the file is a PDF, " +
        "extract its embedded text layer for invoice review. Useful when voucherItems is empty and the original invoice PDF " +
        "must be inspected. If the PDF contains no usable text layer, the tool reports OCR REQUIRED instead of guessing. " +
        "This tool never modifies Lexware or the file.",

      inputSchema: {
        id: z
          .string()
          .describe(
            "Lexware file id from the voucher's files array.",
          ),

        maxCharacters: z
          .number()
          .int()
          .min(1_000)
          .max(
            MAX_TEXT_CHARACTERS,
          )
          .default(
            DEFAULT_MAX_TEXT_CHARACTERS,
          )
          .describe(
            "Maximum number of extracted text characters returned. Default 50000, maximum 200000.",
          ),
      },

      annotations: RO,
    },

    async ({
      id,
      maxCharacters,
    }) => {
      /*
       * Download the exact original bytes from Lexware.
       */
      const {
        data,
        contentType,
      } =
        await client.getBinary(
          `/v1/files/${encodeURIComponent(id)}`,
          "application/pdf",
        );

      const mimeType =
        normalizeMimeType(
          contentType,
        );

      const hash =
        sha256(data);

      const isPdf =
        mimeType ===
          "application/pdf" ||
        looksLikePdf(data);

      /*
       * SHA-256 remains useful even if the file is not a PDF.
       */
      if (!isPdf) {
        const message = [
          "Lexware file inspection completed (READ-ONLY).",
          `fileId: ${id}`,
          `mimeType: ${contentType}`,
          `byteLength: ${data.length}`,
          `sha256: ${hash}`,
          "textAvailable: false",
          "extractionStatus: UNSUPPORTED_FILE_TYPE",
          "PDF text extraction was not attempted because the downloaded file is not recognized as a PDF.",
        ].join("\n");

        return {
          structuredContent: {
            mode:
              "read-only",

            fileId:
              id,

            mimeType:
              contentType,

            byteLength:
              data.length,

            sha256:
              hash,

            isPdf:
              false,

            textAvailable:
              false,

            textTruncated:
              false,

            extractedCharacters:
              0,

            returnedCharacters:
              0,

            pageCount:
              null,

            extractionStatus:
              "unsupported_file_type",

            extractedText:
              "",
          },

          content:
            text(message),
        };
      }

      let parser:
        PDFParse | undefined;

      try {
        /*
         * CanvasFactory is explicitly supplied for reliable
         * server-side Node execution.
         */
        parser =
          new PDFParse({
            data,
            CanvasFactory,
          });

        const result =
          await parser.getText();

        const extractedText =
          (
            result.text ??
            ""
          ).trim();

        const textAvailable =
          extractedText.length >
          0;

        /*
         * A PDF can be perfectly valid but contain only scanned
         * page images. pdf-parse does not perform OCR here.
         */
        if (!textAvailable) {
          const message = [
            "Lexware voucher file inspection completed (READ-ONLY).",
            `fileId: ${id}`,
            `mimeType: ${contentType}`,
            `byteLength: ${data.length}`,
            `sha256: ${hash}`,
            `pageCount: ${result.total}`,
            "textAvailable: false",
            "textTruncated: false",
            "extractionStatus: OCR_REQUIRED",
            "",
            "TEXT NOT AVAILABLE / OCR REQUIRED",
            "",
            "The PDF is valid but no usable embedded text layer was extracted.",
            "Do not infer invoice positions, tax rates or other invoice content from supplier name, amount or history.",
          ].join("\n");

          return {
            structuredContent: {
              mode:
                "read-only",

              fileId:
                id,

              mimeType:
                contentType,

              byteLength:
                data.length,

              sha256:
                hash,

              isPdf:
                true,

              textAvailable:
                false,

              textTruncated:
                false,

              extractedCharacters:
                0,

              returnedCharacters:
                0,

              pageCount:
                result.total,

              extractionStatus:
                "ocr_required",

              extractedText:
                "",
            },

            content:
              text(message),
          };
        }

        const textTruncated =
          extractedText.length >
          maxCharacters;

        const returnedText =
          textTruncated
            ? extractedText.slice(
                0,
                maxCharacters,
              )
            : extractedText;

        const message = [
          "Lexware voucher file inspection completed (READ-ONLY).",
          `fileId: ${id}`,
          `mimeType: ${contentType}`,
          `byteLength: ${data.length}`,
          `sha256: ${hash}`,
          `pageCount: ${result.total}`,
          "textAvailable: true",
          `textTruncated: ${textTruncated}`,
          `extractedCharacters: ${extractedText.length}`,
          `returnedCharacters: ${returnedText.length}`,
          "extractionStatus: TEXT_EXTRACTED",
          "",
          "----- BEGIN EXTRACTED PDF TEXT -----",
          returnedText,
          "----- END EXTRACTED PDF TEXT -----",
          "",
          textTruncated
            ? `WARNING: Extracted text exceeded maxCharacters=${maxCharacters}. The visible text was truncated; increase maxCharacters if the remaining text is required.`
            : "PDF text returned completely.",
        ].join("\n");

        return {
          structuredContent: {
            mode:
              "read-only",

            fileId:
              id,

            mimeType:
              contentType,

            byteLength:
              data.length,

            sha256:
              hash,

            isPdf:
              true,

            textAvailable:
              true,

            textTruncated,

            extractedCharacters:
              extractedText.length,

            returnedCharacters:
              returnedText.length,

            pageCount:
              result.total,

            extractionStatus:
              "text_extracted",

            extractedText:
              returnedText,
          },

          content:
            text(message),
        };
      } catch (error) {
        /*
         * Parsing errors must not be interpreted as invoice data.
         * We still return the exact file fingerprint so duplicate
         * comparison remains possible.
         */
        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error);

        const message = [
          "Lexware voucher file inspection completed (READ-ONLY).",
          `fileId: ${id}`,
          `mimeType: ${contentType}`,
          `byteLength: ${data.length}`,
          `sha256: ${hash}`,
          "textAvailable: false",
          "textTruncated: false",
          "extractionStatus: PARSE_ERROR",
          `parseError: ${errorMessage}`,
          "",
          "TEXT NOT AVAILABLE",
          "",
          "Do not infer invoice positions, tax rates or other invoice content from supplier name, amount or history.",
        ].join("\n");

        return {
          structuredContent: {
            mode:
              "read-only",

            fileId:
              id,

            mimeType:
              contentType,

            byteLength:
              data.length,

            sha256:
              hash,

            isPdf:
              true,

            textAvailable:
              false,

            textTruncated:
              false,

            extractedCharacters:
              0,

            returnedCharacters:
              0,

            pageCount:
              null,

            extractionStatus:
              "parse_error",

            parseError:
              errorMessage,

            extractedText:
              "",
          },

          content:
            text(message),
        };
      } finally {
        /*
         * pdf-parse documentation explicitly recommends destroy()
         * so parser resources are released.
         */
        if (parser) {
          await parser.destroy();
        }
      }
    },
  );
}

/**
 * Write tools for the file store.
 *
 * Registered with the drafts tier.
 */
export function registerFileWriteTools(
  server: McpServer,
  client: LexwareClient,
): void {
  server.registerTool(
    {
      name:
        "upload-file",

      description:
        "Upload a file to Lexware's file store — the first step of attaching a receipt to a bookkeeping " +
        "voucher. Provide the file as base64; returns the new file id to reference elsewhere. The base64 travels " +
        "inline in the request (~12 MB body cap), so keep the source file under ~8 MB.",

      inputSchema: {
        fileBase64: z
          .string()
          .describe(
            "File contents, base64-encoded.",
          ),

        filename: z
          .string()
          .describe(
            'e.g. "receipt-2024-01.pdf".',
          ),

        mimeType: z
          .string()
          .describe(
            'Content type, e.g. "application/pdf" or "image/png".',
          ),

        /*
         * VERIFY:
         * allowed `type` values for POST /v1/files.
         * Lexware uses "voucher" for receipts.
         */
        type: z
          .string()
          .default(
            "voucher",
          )
          .describe(
            'File category. Lexware uses "voucher" for bookkeeping receipts.',
          ),
      },

      annotations: WRITE,
    },

    async ({
      fileBase64,
      filename,
      mimeType,
      type,
    }) => {
      const bytes =
        decodeBase64Strict(
          fileBase64,
          "fileBase64",
        );

      const created =
        await client.postMultipart<{
          id: string;
        }>(
          "/v1/files",
          {
            bytes,
            filename,
            contentType:
              mimeType,
          },
          {
            type,
          },
        );

      return {
        structuredContent:
          created,

        content:
          text(
            `Uploaded file ${created.id} (${filename}).`,
          ),
      };
    },
  );
}
