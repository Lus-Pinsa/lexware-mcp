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

import { registerProfileTools } from "./profile.js";
import { registerReferenceReadTools } from "./reference.js";
import { registerVoucherWriteTools } from "./vouchers.js";

/**
 * Register MCP tools according to the resolved capability tiers.
 *
 * Only enabled tiers are advertised to the model.
 */
export function registerTools(
  server: McpServer,
  client: LexwareClient,
  config: Config,
): void {
  const { capabilities } = config;

  /*
   * READ TIER
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
   * DRAFT / CONTROLLED WRITE TIER
   *
   * This includes the LU'S-specific webhook ensure tool.
   *
   * That tool cannot accept arbitrary URLs or arbitrary event types,
   * so exposing it here does NOT expose the general event-subscription
   * write surface.
   */
  if (capabilities.drafts) {
    registerContactDraftTools(server, client);
    registerArticleWriteTools(server, client);
    registerDocumentDraftTools(server, client);
    registerVoucherWriteTools(server, client);
    registerFileWriteTools(server, client);

    registerLusVoucherWebhookTools(server, client);
  }

  /*
   * FINALIZE / SENSITIVE / IRREVERSIBLE TIER
   *
   * Keep disabled by default.
   *
   * General webhook create/delete stays here because arbitrary callback
   * URLs are exfiltration-capable.
   */
  if (capabilities.finalize) {
    registerDocumentFinalizeTools(server, client);
    registerArticleDeleteTools(server, client);

    registerEventSubscriptionWriteTools(server, client);
    registerEventSubscriptionDeleteTools(server, client);
  }
}
