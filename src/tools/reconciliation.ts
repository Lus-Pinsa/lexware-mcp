import type { McpServer } from "skybridge/server";
import { z } from "zod";

import type { LexwareClient } from "../lexware/client.js";
import type {
  Paged,
  VoucherlistEntry,
} from "../lexware/types.js";

import {
  createMemoryPendingVoucherEventStore,
  type PendingVoucherEventStore,
} from "../persistence/pending-voucher-store.js";

import {
  jsonNum,
} from "./schemas.js";

import {
  RO,
  text,
} from "./shared.js";

/**
 * Voucher types belonging to Lexware bookkeeping vouchers.
 */
const RECONCILE_VOUCHER_TYPES = [
  "purchaseinvoice",
  "purchasecreditnote",
  "salesinvoice",
  "salescreditnote",
] as const;

type ReconcileVoucherType =
  (typeof RECONCILE_VOUCHER_TYPES)[number];

/**
 * Convert a voucherlist row into a generic record.
 *
 * This keeps the reconciliation tool independent from whether
 * every Lexware response field is explicitly declared in the
 * local VoucherlistEntry TypeScript interface.
 */
function voucherRecord(
  row: VoucherlistEntry,
): Record<string, unknown> {
  return row as unknown as Record<
    string,
    unknown
  >;
}

/**
 * Safely read a string field.
 */
function stringField(
  row: VoucherlistEntry,
  key: string,
): string {
  const value =
    voucherRecord(row)[key];

  return typeof value === "string"
    ? value
    : "";
}

/**
 * Safely read a number field.
 */
function numberField(
  row: VoucherlistEntry,
  key: string,
): number | undefined {
  const value =
    voucherRecord(row)[key];

  return typeof value === "number"
    ? value
    : undefined;
}

/**
 * Safely read the voucher id.
 */
function voucherId(
  row: VoucherlistEntry,
): string {
  return stringField(
    row,
    "id",
  );
}

/**
 * Safely read createdDate.
 */
function voucherCreatedDate(
  row: VoucherlistEntry,
): string {
  return stringField(
    row,
    "createdDate",
  );
}

/**
 * Build a compact, visible reconciliation candidate.
 *
 * This is intentionally duplicated into the text response because
 * some MCP clients do not visibly expose structuredContent.
 */
function reconciliationCandidateDetail(
  row: VoucherlistEntry,
) {
  return {
    id:
      stringField(
        row,
        "id",
      ),

    voucherType:
      stringField(
        row,
        "voucherType",
      ),

    voucherNumber:
      stringField(
        row,
        "voucherNumber",
      ),

    voucherDate:
      stringField(
        row,
        "voucherDate",
      ),

    createdDate:
      stringField(
        row,
        "createdDate",
      ),

    updatedDate:
      stringField(
        row,
        "updatedDate",
      ),

    contactName:
      stringField(
        row,
        "contactName",
      ),

    totalAmount:
      numberField(
        row,
        "totalAmount",
      ),

    currency:
      stringField(
        row,
        "currency",
      ),

    voucherStatus:
      stringField(
        row,
        "voucherStatus",
      ),
  };
}

/**
 * Register read-only voucher reconciliation tools.
 *
 * Purpose:
 *
 * Compare recent vouchers from Lexware (Source of Truth)
 * against the current Pending Queue.
 *
 * IMPORTANT:
 *
 * - This tool does NOT modify Lexware.
 * - This tool does NOT modify the Pending Queue.
 * - This tool does NOT acknowledge events.
 * - This tool does NOT re-enqueue events.
 *
 * A Lexware voucher that is not currently in the Pending Queue
 * is only a reconciliation candidate.
 *
 * It is NOT proof that the webhook failed.
 *
 * The voucher may:
 *
 * - have been acknowledged previously,
 * - have existed before a process restart,
 * - have disappeared from RAM because Render restarted,
 * - or genuinely have been missed by the webhook.
 *
 * Conservative behaviour is intentional:
 *
 * Prefer resurfacing an already reviewed voucher over silently
 * losing a newly created voucher.
 */
export function registerVoucherReconciliationReadTools(
  server: McpServer,
  client: LexwareClient,
  pendingStore: PendingVoucherEventStore = createMemoryPendingVoucherEventStore(),
): void {
  server.registerTool(
    {
      name:
        "reconcile-recent-vouchers",

      description:
        "READ-ONLY restart/reconciliation fallback for the LU'S Lexware Pending Queue. " +
        "Loads bookkeeping vouchers created in Lexware during the requested creation-date window and compares " +
        "them with the current pending voucher queue. Vouchers missing from the queue are returned as " +
        "reconciliation candidates. A candidate is NOT proof of a missed webhook: it may have been acknowledged " +
        "earlier or the RAM queue may have been cleared by a restart/redeploy. This tool never modifies Lexware, " +
        "never acknowledges events and never changes the pending queue.",

      inputSchema: {
        createdDateFrom: z
          .string()
          .describe(
            "Required Lexware creation-date lower bound, YYYY-MM-DD.",
          ),

        createdDateTo: z
          .string()
          .optional()
          .describe(
            "Optional Lexware creation-date upper bound, YYYY-MM-DD. If omitted, Lexware applies only the lower bound.",
          ),

        maxPagesPerType: jsonNum(
          z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10),
        ).describe(
          "Safety cap per voucher type. Each page contains up to 250 rows. Default 10 pages per type.",
        ),
      },

      annotations: RO,
    },

    async ({
      createdDateFrom,
      createdDateTo,
      maxPagesPerType,
    }) => {
      /*
       * Lexware remains the Source of Truth.
       */
      const recentVouchers:
        VoucherlistEntry[] = [];

      const perType: Record<
        string,
        {
          totalElements: number;
          pagesScanned: number;
          truncated: boolean;
        }
      > = {};

      const PAGE_SIZE = 250;

      /*
       * Load all recent bookkeeping voucher types.
       */
      for (
        const voucherType of
          RECONCILE_VOUCHER_TYPES
      ) {
        let page = 0;

        let pagesScanned = 0;

        let totalElements = 0;

        let truncated = false;

        for (;;) {
          const result =
            await client.get<
              Paged<VoucherlistEntry>
            >(
              "/v1/voucherlist",
              {
                voucherType:
                  voucherType as ReconcileVoucherType,

                voucherStatus:
                  "any",

                createdDateFrom,

                createdDateTo,

                sort:
                  "createdDate,DESC",

                page,

                size:
                  PAGE_SIZE,
              },
            );

          totalElements =
            result.totalElements;

          pagesScanned++;

          recentVouchers.push(
            ...result.content,
          );

          if (result.last) {
            break;
          }

          page++;

          if (
            page >=
            maxPagesPerType
          ) {
            truncated = true;
            break;
          }
        }

        perType[voucherType] = {
          totalElements,
          pagesScanned,
          truncated,
        };
      }

      /*
       * Defensive deduplication by Lexware voucher id.
       */
      const uniqueRecent =
        new Map<
          string,
          VoucherlistEntry
        >();

      for (
        const row of
          recentVouchers
      ) {
        const id =
          voucherId(row);

        if (!id) {
          continue;
        }

        uniqueRecent.set(
          id,
          row,
        );
      }

      /*
       * Newest vouchers first.
       */
      const recent =
        [
          ...uniqueRecent.values(),
        ].sort(
          (a, b) =>
            voucherCreatedDate(b)
              .localeCompare(
                voucherCreatedDate(a),
              ),
        );

      /*
       * Read current RAM Pending Queue.
       *
       * No mutation.
       */
      const pending =
        await pendingStore.list();

      const pendingIds =
        new Set(
          pending.map(
            (event) =>
              event.resourceId,
          ),
        );

      const recentIds =
        new Set(
          recent
            .map(
              (row) =>
                voucherId(row),
            )
            .filter(Boolean),
        );

      /*
       * Recent Lexware vouchers still represented in queue.
       */
      const representedInPendingQueue =
        recent.filter(
          (row) =>
            pendingIds.has(
              voucherId(row),
            ),
        );

      /*
       * Recent Lexware vouchers missing from current queue.
       *
       * These are candidates only.
       *
       * They are NOT automatically treated as missed webhook
       * events.
       */
      const reconciliationCandidates =
        recent.filter(
          (row) =>
            !pendingIds.has(
              voucherId(row),
            ),
        );

      /*
       * Pending events not included in the queried Lexware
       * creation-date window.
       */
      const pendingOutsideRecentWindow =
        pending.filter(
          (event) =>
            !recentIds.has(
              event.resourceId,
            ),
        );

      /*
       * Did any voucher type hit the page safety limit?
       */
      const truncated =
        Object.values(
          perType,
        ).some(
          (entry) =>
            entry.truncated,
        );

      /*
       * Create simplified candidate data.
       *
       * This is returned in structuredContent AND printed in the
       * visible text response.
       */
      const candidateDetails =
        reconciliationCandidates.map(
          reconciliationCandidateDetail,
        );

      const candidateTextLines =
        candidateDetails.length === 0
          ? [
              "Reconciliation candidate details: NONE.",
            ]
          : [
              "Reconciliation candidate details:",
              ...candidateDetails.map(
                (
                  candidate,
                  index,
                ) =>
                  [
                    `[${index + 1}]`,
                    `id=${candidate.id || "DATA NOT AVAILABLE"}`,
                    `voucherType=${candidate.voucherType || "DATA NOT AVAILABLE"}`,
                    `voucherNumber=${candidate.voucherNumber || "DATA NOT AVAILABLE"}`,
                    `contactName=${candidate.contactName || "DATA NOT AVAILABLE"}`,
                    `totalAmount=${
                      candidate.totalAmount ??
                      "DATA NOT AVAILABLE"
                    } ${
                      candidate.currency ||
                      ""
                    }`.trim(),
                    `voucherStatus=${candidate.voucherStatus || "DATA NOT AVAILABLE"}`,
                    `voucherDate=${candidate.voucherDate || "DATA NOT AVAILABLE"}`,
                    `createdDate=${candidate.createdDate || "DATA NOT AVAILABLE"}`,
                    `updatedDate=${candidate.updatedDate || "DATA NOT AVAILABLE"}`,
                  ].join(
                    " | ",
                  ),
              ),
            ];

      const warning =
        "CONSERVATIVE RECONCILIATION: A voucher listed under reconciliationCandidates is not proof that a webhook was missed. " +
        "It may already have been reviewed/acknowledged or may have disappeared from the in-memory queue after a restart/redeploy. " +
        "Do not acknowledge, book, categorize, pay or otherwise modify a voucher solely because it appears here.";

      return {
        structuredContent: {
          mode:
            "read-only",

          sourceOfTruth:
            "Lexware",

          filters: {
            createdDateFrom,
            createdDateTo,

            voucherTypes:
              RECONCILE_VOUCHER_TYPES,
          },

          pagination: {
            pageSize:
              PAGE_SIZE,

            maxPagesPerType,

            perType,

            truncated,
          },

          counts: {
            recentLexwareVouchers:
              recent.length,

            currentPendingEvents:
              pending.length,

            representedInPendingQueue:
              representedInPendingQueue.length,

            reconciliationCandidates:
              reconciliationCandidates.length,

            pendingOutsideRecentWindow:
              pendingOutsideRecentWindow.length,
          },

          recentLexwareVouchers:
            recent,

          currentPendingEvents:
            pending,

          representedInPendingQueue,

          reconciliationCandidates,

          reconciliationCandidateDetails:
            candidateDetails,

          pendingOutsideRecentWindow,

          warning,
        },

        content: text(
          [
            "Lexware voucher reconciliation completed (READ-ONLY).",

            `Creation window: ${createdDateFrom} → ${createdDateTo ?? "open"}.`,

            `Recent Lexware vouchers: ${recent.length}.`,

            `Current Pending Queue events: ${pending.length}.`,

            `Still represented in Pending Queue: ${representedInPendingQueue.length}.`,

            `Reconciliation candidates not currently in queue: ${reconciliationCandidates.length}.`,

            `Pending events outside queried window: ${pendingOutsideRecentWindow.length}.`,

            `truncated: ${truncated}.`,

            truncated
              ? "WARNING: Page safety cap reached for at least one voucher type; result may be incomplete."
              : "Pagination complete for all queried voucher types.",

            "",

            ...candidateTextLines,

            "",

            warning,
          ].join(
            "\n",
          ),
        ),
      };
    },
  );
}
