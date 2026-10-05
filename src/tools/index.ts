import type { McpServer } from "skybridge/server";
import type { Config } from "../config.js";
import type { LexwareClient } from "../lexware/client.js";

import {
  registerArticleDeleteTools,
  registerArticleReadTools,
  registerArticleWriteTools,
} from "./articles.js";

import {
  registerContactDraftTools,
  registerContactReadTools,
} from "./contacts.js";

import {
  registerDocumentDraftTools,
  registerDocumentFinalizeTools,
  registerDocumentReadTools,
} from "./documents.js";

import {
  registerEventSubscriptionDeleteTools,
  registerEventSubscriptionReadTools,
  registerEventSubscriptionWriteTools,
  registerLusVoucherWebhookTools,
} from "./event-subscriptions.js";

import {
  registerFileReadTools,
  registerFileWriteTools,
} from "./files.js";

import {
  registerPendingVoucherEventReadTools,
  registerPendingVoucherEventWriteTools,
} from "./pending-voucher-events.js";

import { registerProfileTools } from "./profile.js";
import { registerReferenceReadTools } from "./reference.js";
import { registerVoucherWriteTools } from "./vouchers.js";

/**
 * Register MCP tools according to resolved capability tiers.
 *
 * Only enabled tiers are advertised to Claude.
 */
export function registerTools(
  server: McpServer,
  client: LexwareClient,
  config: Config,
): void {
  const { capabilities } = config;

  /*
   * ============================================================
   * READ TIER
   * ============================================================
   *
   * Always available.
   */

  registerProfileTools(server, client);
  registerContactReadTools(server, client);
  registerArticleReadTools(server, client);

  registerDocumentReadTools(
    server,
    client,
    config.lexwareAppBaseUrl,
  );

  registerReferenceReadTools(server, client);
  registerFileReadTools(server, client);
  registerEventSubscriptionReadTools(server, client);

  /*
   * NEW:
   * Claude can read pending voucher.created events.
   */
  registerPendingVoucherEventReadTools(server);

  /*
   * ============================================================
   * DRAFT / CONTROLLED WRITE TIER
   * ============================================================
   */

  if (capabilities.drafts) {
    registerContactDraftTools(server, client);
    registerArticleWriteTools(server, client);
    registerDocumentDraftTools(server, client);
    registerVoucherWriteTools(server, client);
    registerFileWriteTools(server, client);

    /*
     * LU'S fixed voucher webhook.
     */
    registerLusVoucherWebhookTools(
      server,
      client,
    );

    /*
     * NEW:
     * Claude may acknowledge an event after processing it.
     *
     * This only changes the MCP queue.
     * It does NOT modify the Lexware voucher.
     */
    registerPendingVoucherEventWriteTools(
      server,
    );
  }

  /*
   * ============================================================
   * FINALIZE / SENSITIVE TIER
   * ============================================================
   *
   * Remains disabled by default.
   */

  if (capabilities.finalize) {
    registerDocumentFinalizeTools(
      server,
      client,
    );

    registerArticleDeleteTools(
      server,
      client,
    );

    /*
     * General arbitrary webhook create/delete stays behind
     * FINALIZE because arbitrary external callback URLs are
     * exfiltration-capable.
     */
    registerEventSubscriptionWriteTools(
      server,
      client,
    );

    registerEventSubscriptionDeleteTools(
      server,
      client,
    );
  }
}
