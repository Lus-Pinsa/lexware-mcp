import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { DESTRUCTIVE, RO, text, WRITE, deleteIdempotent } from "./shared.js";

/**
 * Fixed LU'S webhook target.
 *
 * This is deliberately NOT configurable through MCP input.
 * The tool below may only create this exact subscription.
 */
const LUS_VOUCHER_EVENT_TYPE = "voucher.created";
const LUS_VOUCHER_CALLBACK_URL =
  "https://lus-lexware-mcp.onrender.com/webhooks/lexware";

type EventSubscription = {
  subscriptionId?: string;
  id?: string;
  organizationId?: string;
  createdDate?: string;
  eventType?: string;
  callbackUrl?: string;
};

type EventSubscriptionList = {
  content?: EventSubscription[];
};

function findLusVoucherSubscription(
  data: unknown,
): EventSubscription | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const content = (data as EventSubscriptionList).content;

  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.find(
    (subscription) =>
      subscription.eventType === LUS_VOUCHER_EVENT_TYPE &&
      subscription.callbackUrl === LUS_VOUCHER_CALLBACK_URL,
  );
}

/** Read tools for event subscriptions (webhooks). Always registered. */
export function registerEventSubscriptionReadTools(
  server: McpServer,
  client: LexwareClient,
): void {
  server.registerTool(
    {
      name: "list-event-subscriptions",
      description:
        "List webhook event subscriptions configured for this organization.",
      annotations: RO,
    },
    async () => {
      const data = await client.get<unknown>("/v1/event-subscriptions");

      return {
        structuredContent: { data },
        content: text("Retrieved event subscriptions."),
      };
    },
  );

  server.registerTool(
    {
      name: "get-event-subscription",
      description: "Get a single event subscription by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const sub = await client.get<Record<string, unknown>>(
        `/v1/event-subscriptions/${encodeURIComponent(id)}`,
      );

      return {
        structuredContent: sub,
        content: text(`Event subscription ${id} retrieved.`),
      };
    },
  );
}

/**
 * LU'S-specific safe webhook setup.
 *
 * Unlike create-event-subscription this tool accepts NO external URL and
 * NO arbitrary event type.
 *
 * It can only ensure:
 *
 *   voucher.created
 *       ->
 *   https://lus-lexware-mcp.onrender.com/webhooks/lexware
 *
 * Therefore it can safely be exposed in the drafts tier without enabling
 * the general exfiltration-capable event-subscription write tools.
 */
export function registerLusVoucherWebhookTools(
  server: McpServer,
  client: LexwareClient,
): void {
  server.registerTool(
    {
      name: "ensure-lus-voucher-webhook",
      description:
        "Ensure that the fixed LU'S Lexware voucher.created webhook is active. " +
        "Checks existing subscriptions first and creates only the fixed LU'S " +
        "callback subscription when missing. No arbitrary URL or event type can be supplied.",
      annotations: WRITE,
    },
    async () => {
      /*
       * First check:
       * do not create anything when the correct subscription already exists.
       */
      const current = await client.get<unknown>(
        "/v1/event-subscriptions",
      );

      const existing = findLusVoucherSubscription(current);

      if (existing) {
        const id = existing.subscriptionId ?? existing.id ?? "";

        return {
          structuredContent: {
            active: true,
            created: false,
            subscriptionId: id,
            eventType: LUS_VOUCHER_EVENT_TYPE,
            callbackUrl: LUS_VOUCHER_CALLBACK_URL,
          },
          content: text(
            `LU'S voucher webhook is already active${
              id ? ` (${id})` : ""
            }.`,
          ),
        };
      }

      /*
       * Missing -> create exactly one fixed LU'S subscription.
       *
       * client.post() is deliberately non-idempotent and therefore will not
       * blindly retry ambiguous network/5xx failures.
       */
      try {
        const created = await client.post<{
          id?: string;
          subscriptionId?: string;
          resourceUri?: string;
          createdDate?: string;
          updatedDate?: string;
          version?: number;
        }>("/v1/event-subscriptions", {
          eventType: LUS_VOUCHER_EVENT_TYPE,
          callbackUrl: LUS_VOUCHER_CALLBACK_URL,
        });

        const id = created.subscriptionId ?? created.id ?? "";

        return {
          structuredContent: {
            active: true,
            created: true,
            subscriptionId: id,
            eventType: LUS_VOUCHER_EVENT_TYPE,
            callbackUrl: LUS_VOUCHER_CALLBACK_URL,
            result: created,
          },
          content: text(
            `Created LU'S voucher webhook${
              id ? ` (${id})` : ""
            } for ${LUS_VOUCHER_EVENT_TYPE}.`,
          ),
        };
      } catch (createError) {
        /*
         * Defensive reconciliation:
         *
         * If POST had an ambiguous result or another process created the
         * subscription concurrently, re-read Lexware before reporting failure.
         *
         * This also handles a possible duplicate/409 condition without relying
         * on the internal shape of LexwareApiError.
         */
        try {
          const afterFailure = await client.get<unknown>(
            "/v1/event-subscriptions",
          );

          const appeared = findLusVoucherSubscription(afterFailure);

          if (appeared) {
            const id =
              appeared.subscriptionId ?? appeared.id ?? "";

            return {
              structuredContent: {
                active: true,
                created: false,
                reconciled: true,
                subscriptionId: id,
                eventType: LUS_VOUCHER_EVENT_TYPE,
                callbackUrl: LUS_VOUCHER_CALLBACK_URL,
              },
              content: text(
                `LU'S voucher webhook is active after reconciliation${
                  id ? ` (${id})` : ""
                }.`,
              ),
            };
          }
        } catch {
          // Preserve the original creation error below.
        }

        throw createError;
      }
    },
  );
}

/**
 * General-purpose write tools for event subscriptions.
 *
 * These stay behind FINALIZE because they allow arbitrary external webhook
 * targets and are therefore data-exfiltration-capable.
 */
export function registerEventSubscriptionWriteTools(
  server: McpServer,
  client: LexwareClient,
): void {
  server.registerTool(
    {
      name: "create-event-subscription",
      description:
        "Subscribe a callback URL to a Lexware event type (webhook), e.g. eventType 'invoice.created'. Sends future " +
        "event notifications to an EXTERNAL URL, so treat the target as trusted. The callback URL must be https:// " +
        "and serve a Grade-A HTTPS certificate.",
      inputSchema: {
        eventType: z
          .string()
          .describe("e.g. 'invoice.created', 'invoice.status.changed'."),
        callbackUrl: z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), {
            message: "callbackUrl must be https://.",
          })
          .describe(
            "HTTPS endpoint that will receive events (Lexware requires a Grade-A HTTPS certificate).",
          ),
      },
      annotations: WRITE,
    },
    async ({ eventType, callbackUrl }) => {
      const created = await client.post<{
        subscriptionId?: string;
        id?: string;
      }>("/v1/event-subscriptions", {
        eventType,
        callbackUrl,
      });

      const id = created.subscriptionId ?? created.id ?? "";

      return {
        structuredContent: created,
        content: text(
          `Created event subscription ${id} for ${eventType}.`,
        ),
      };
    },
  );
}

/**
 * Delete (unsubscribe) an event subscription.
 *
 * Remains behind FINALIZE together with the general create tool.
 */
export function registerEventSubscriptionDeleteTools(
  server: McpServer,
  client: LexwareClient,
): void {
  server.registerTool(
    {
      name: "delete-event-subscription",
      description:
        "Delete (unsubscribe) an event subscription by id. Stops the webhook; recreate it to re-subscribe.",
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const { alreadyAbsent } = await deleteIdempotent(
        client,
        `/v1/event-subscriptions/${encodeURIComponent(id)}`,
      );

      return {
        structuredContent: {
          id,
          deleted: true,
          alreadyAbsent,
        },
        content: text(
          alreadyAbsent
            ? `Event subscription ${id} was already absent (nothing to delete).`
            : `Deleted event subscription ${id}.`,
        ),
      };
    },
  );
}
