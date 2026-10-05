import type { McpServer } from "skybridge/server";
import { z } from "zod";

import {
  acknowledgePendingVoucherEvent,
  listPendingVoucherEvents,
} from "../pending-voucher-events.js";

import { RO, text, WRITE } from "./shared.js";

/**
 * Read pending Lexware voucher.created events.
 */
export function registerPendingVoucherEventReadTools(
  server: McpServer,
): void {
  server.registerTool(
    {
      name: "get-pending-voucher-events",
      description:
        "Return Lexware voucher.created events received by the LU'S webhook that have not yet been acknowledged.",
      annotations: RO,
    },
    async () => {
      const events = listPendingVoucherEvents();

      if (events.length === 0) {
        return {
          structuredContent: {
            count: 0,
            events: [],
          },
          content: text(
            "No pending Lexware voucher events.",
          ),
        };
      }

      const lines = events.map(
        (event, index) =>
          `${index + 1}. resourceId=${event.resourceId} eventDate=${event.eventDate} receivedAt=${event.receivedAt}`,
      );

      return {
        structuredContent: {
          count: events.length,
          events,
        },
        content: text(
          [
            `Pending Lexware voucher events: ${events.length}`,
            ...lines,
          ].join("\n"),
        ),
      };
    },
  );
}

/**
 * Acknowledge a processed event.
 *
 * This ONLY removes the event from the MCP queue.
 * It does NOT modify or delete anything in Lexware.
 */
export function registerPendingVoucherEventWriteTools(
  server: McpServer,
): void {
  server.registerTool(
    {
      name: "acknowledge-voucher-event",
      description:
        "Acknowledge a processed Lexware voucher event by resourceId. This only removes it from the LU'S MCP pending queue and does not modify the Lexware voucher.",
      inputSchema: {
        resourceId: z
          .string()
          .min(1)
          .describe(
            "Lexware voucher resourceId returned by get-pending-voucher-events.",
          ),
      },
      annotations: WRITE,
    },
    async ({ resourceId }) => {
      const result =
        acknowledgePendingVoucherEvent(
          resourceId,
        );

      return {
        structuredContent: {
          resourceId,
          removed: result.removed,
          remaining: result.remaining,
        },
        content: text(
          `Acknowledged voucher event resourceId=${resourceId}. Removed=${result.removed}. Remaining=${result.remaining}.`,
        ),
      };
    },
  );
}
