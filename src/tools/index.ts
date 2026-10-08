import type { McpServer } from "skybridge/server";
import type { Config } from "../config.js";
import type { LexwareClient } from "../lexware/client.js";
import {
  createMemoryPendingVoucherEventStore,
  type PendingVoucherEventStore,
} from "../pending-voucher-store.js";

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

import {
  registerVoucherReconciliationReadTools,
} from "./reconciliation.js";

import { registerFinanceIntelligenceTools } from "./finance-intelligence.js";

import { registerProfileTools } from "./profile.js";
import { registerReferenceReadTools } from "./reference.js";
import {
  type RegisteredToolInfo,
  type ServerRuntime,
  registerServerInfoTool,
  trackToolRegistrations,
} from "./server-info.js";
import { registerVoucherWriteTools } from "./vouchers.js";
import { PROCESS_STARTED_AT } from "../build-info.js";

/**
 * Register MCP tools according to resolved capability tiers.
 *
 * Only enabled tiers are advertised to Claude.
 */
export function registerTools(
  mcpServer: McpServer,
  client: LexwareClient,
  config: Config,
  runtime: ServerRuntime = { env: process.env, startedAt: PROCESS_STARTED_AT },
  pendingStore: PendingVoucherEventStore = createMemoryPendingVoucherEventStore(),
): void {
  const { capabilities } = config;

  /*
   * Every registration below goes through this wrapper so `get-server-info` can report the exact set of
   * tools this process exposes (evaluated when the tool is called, i.e. after all tiers are registered).
   */
  const registered: RegisteredToolInfo[] = [];
  const server = trackToolRegistrations(mcpServer, registered);

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
   * Claude can read pending voucher.created events.
   */
  registerPendingVoucherEventReadTools(server, pendingStore);

  /*
   * Read-only restart/reconciliation fallback.
   *
   * Compares recent Lexware vouchers against the current
   * in-memory Pending Queue.
   *
   * Does not modify Lexware.
   * Does not acknowledge events.
   * Does not modify the Pending Queue.
   */
  registerVoucherReconciliationReadTools(
    server,
    client,
    pendingStore,
  );

  /*
   * LU'S finance intelligence (snapshot, duplicates, open items, period comparison, daily brief).
   *
   * Reads Lexware only through the GET-only facade.
   * No server state is written; nothing is changed in Lexware.
   */
  registerFinanceIntelligenceTools(server, client);

  /*
   * Local, read-only introspection: build commit, tiers, registered tools.
   * Does not call Lexware and never returns secrets.
   */
  registerServerInfoTool(
    server,
    config,
    () => registered,
    runtime,
  );

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
     * Claude may acknowledge an event after processing it.
     *
     * This only changes the MCP queue.
     * It does NOT modify the Lexware voucher.
     */
    registerPendingVoucherEventWriteTools(
      server,
      pendingStore,
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
