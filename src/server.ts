import express, { type Request, type Response } from "express";
import {
  mcpAuthMetadataRouter,
  McpServer,
  requireBearerAuth,
} from "skybridge/server";

import { bearerAuthMiddleware } from "./auth.js";
import { SERVER_NAME, SERVER_VERSION, buildLogLabel, resolveBuildInfo } from "./build-info.js";
import {
  ConfigError,
  describeCapabilities,
  loadConfig,
} from "./config.js";
import { LexwareClient } from "./lexware/client.js";
import {
  buildOAuthMetadata,
  createAccessTokenVerifier,
} from "./oauth.js";
import { registerTools } from "./tools/index.js";
import { hardenApp, isLexwareWebhookPath, isMcpPath, preAuthDebugLine } from "./http-hardening.js";
import { createLexwareWebhookHandler } from "./webhook-receiver.js";
import { createMemoryPendingVoucherEventStore } from "./pending-voucher-store.js";
import { createDurablePendingVoucherEventStore } from "./persistence/pending-voucher-store.js";
import {
  createPostgresDatabase,
  type ManagedPersistenceDatabase,
} from "./persistence/postgres-driver.js";
import { loadPersistenceRuntimeConfig } from "./persistence/runtime-config.js";
import { verifyConfiguredTenantBinding } from "./persistence/tenant-binding.js";
import { assertMigrationStateCurrent } from "./persistence/migration-runner.js";
import {
  inspectRuntimePrivileges,
  listAppliedSchemaMigrations,
} from "./persistence/repository.js";
import { assertLeastPrivilegeRuntimeRole } from "./persistence/runtime-privileges.js";
/**
 * Base64 file uploads
 * (upload-file / upload-voucher-file)
 * travel inline in the JSON-RPC body.
 */
const JSON_BODY_LIMIT = "12mb";


/**
 * Reconfigure body parsing so large uploads work WITHOUT widening
 * the pre-auth attack surface.
 *
 * Skybridge pre-applies a global express.json() parser.
 * MCP requests are deferred until after authentication.
 *
 * Lexware webhook requests are also deferred because the raw body
 * is required for signature verification.
 */
function deferMcpBodyParsing(
  app: express.Express,
): boolean {
  try {
    type Layer = {
      handle?: express.RequestHandler & {
        name?: string;
      };
    };

    const router =
      (
        app as unknown as {
          router?: { stack: Layer[] };
          _router?: { stack: Layer[] };
        }
      ).router ??
      (
        app as unknown as {
          _router?: { stack: Layer[] };
        }
      )._router;

    const stack = router?.stack;

    if (!Array.isArray(stack)) {
      return false;
    }

    const layer = stack.find(
      (l) => l?.handle?.name === "jsonParser",
    );

    if (!layer) {
      return false;
    }

    const smallJson = express.json();

    layer.handle = (req, res, next) =>
      isMcpPath(req.path) ||
      isLexwareWebhookPath(req.path)
        ? next()
        : smallJson(req, res, next);

    return true;
  } catch {
    return false;
  }
}

/* ============================================================
   CONFIG
   ============================================================ */

let config;

try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(
      `Configuration error: ${err.message}`,
    );
    process.exit(1);
  }

  throw err;
}

/**
 * Skybridge's run() binds process.env.__PORT.
 * Render supplies PORT.
 */
if (!process.env.__PORT) {
  process.env.__PORT = String(config.port);
}

/* ============================================================
   LEXWARE CLIENT
   ============================================================ */

const client = new LexwareClient({
  baseUrl: config.lexwareApiBaseUrl,
  apiKey: config.lexwareApiKey,
  debug: config.debugLogging,
});

/* ============================================================
   PERSISTENCE / PENDING EVENT STORE
   ============================================================ */

const persistenceConfig =
  loadPersistenceRuntimeConfig(
    process.env,
    config.webhookOrganizationId,
  );

let persistenceDb:
  | ManagedPersistenceDatabase
  | undefined;

let pendingVoucherStore =
  createMemoryPendingVoucherEventStore();

if (persistenceConfig.enabled) {
  persistenceDb =
    createPostgresDatabase({
      connectionString:
        persistenceConfig.secrets
          .getDatabaseUrl(),
      tlsMode:
        persistenceConfig.tlsMode,
      applicationName:
        "lus-lexware-mcp",
    });

  // Persistence is fail-closed. When explicitly enabled there is no RAM fallback.
  const appliedMigrations =
    await persistenceDb.transaction(
      (tx) => listAppliedSchemaMigrations(tx),
    );
  assertMigrationStateCurrent(
    appliedMigrations,
  );

  const runtimePrivileges =
    await persistenceDb.transaction(
      (tx) => inspectRuntimePrivileges(tx),
    );
  assertLeastPrivilegeRuntimeRole(
    runtimePrivileges,
    persistenceConfig.expectedRuntimeRole,
  );

  await verifyConfiguredTenantBinding(
    persistenceConfig,
    persistenceDb,
    config.capabilities,
  );

  pendingVoucherStore =
    createDurablePendingVoucherEventStore({
      db: persistenceDb,
      tenantId:
        persistenceConfig.tenantId,
      keyring:
        persistenceConfig.secrets.keyring,
    });
}

/* ============================================================
   MCP SERVER
   ============================================================ */

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {},
  },
);

const bodyParsingConfigured =
  deferMcpBodyParsing(server.express);

// Do not advertise the framework in every response.
hardenApp(server.express);

/* ============================================================
   HEALTH CHECK
   ============================================================ */

server.express.get(
  "/status",
  (_req: Request, res: Response) => {
    res.json({
      status: "ok",
    });
  },
);

/* ============================================================
   LEXWARE WEBHOOK
   ============================================================ */

function getLexwareWebhookPublicKey():
  | string
  | undefined {
  return process.env
    .LEXWARE_WEBHOOK_PUBLIC_KEY
    ?.replace(/\\n/g, "\n");
}

/**
 * Lexware checks callback reachability
 * when the subscription is created.
 */
server.express.head(
  "/webhooks/lexware",
  (_req: Request, res: Response) => {
    res.sendStatus(204);
  },
);

/**
 * Useful manual browser check.
 */
server.express.get(
  "/webhooks/lexware",
  (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      webhook: "lexware",
      event: "voucher.created",
    });
  },
);

/**
 * Lexware webhook receiver.
 *
 * IMPORTANT:
 * This route does NOT use MCP bearer authentication.
 * Authentication is performed via X-Lxo-Signature.
 */
server.express.post(
  "/webhooks/lexware",

  express.raw({
    type: "application/json",
    limit: "64kb",
  }),

  createLexwareWebhookHandler({
    getPublicKey: getLexwareWebhookPublicKey,
    organizationId: config.webhookOrganizationId,
    enqueue: (event) =>
      pendingVoucherStore.enqueue(event),
    droppedTotal: () =>
      pendingVoucherStore.droppedTotal(),
    log: (line) => console.error(line),
  }),
);

/* ============================================================
   DEBUG LOGGING
   ============================================================ */

server.use(
  (req, _res, next) => {
    if (
      isMcpPath(req.path) ||
      req.path.toLowerCase().startsWith(
        "/.well-known/",
      )
    ) {
      console.error(
        preAuthDebugLine(req.method, req.path, Boolean(req.headers.authorization)),
      );
    }

    next();
  },
);

/* ============================================================
   MCP AUTH
   ============================================================ */

if (config.auth.mode === "oauth") {
  const oauth = config.auth;

  server.use(
    mcpAuthMetadataRouter({
      oauthMetadata:
        buildOAuthMetadata(oauth),
      resourceServerUrl:
        new URL(oauth.resource),
    }),
  );

  const resUrl =
    new URL(oauth.resource);

  const resPath =
    resUrl.pathname === "/"
      ? ""
      : resUrl.pathname.replace(
          /\/$/,
          "",
        );

  server.use(
    "/mcp",
    requireBearerAuth({
      verifier: {
        verifyAccessToken:
          createAccessTokenVerifier(
            oauth,
          ),
      },

      resourceMetadataUrl:
        `${resUrl.origin}/.well-known/oauth-protected-resource${resPath}`,
    }),
  );
} else if (
  config.auth.mode === "static"
) {
  server.use(
    "/mcp",
    bearerAuthMiddleware(
      config.auth.token,
    ),
  );
}

/* ============================================================
   MCP JSON BODY
   ============================================================ */

if (bodyParsingConfigured) {
  server.use(
    "/mcp",
    express.json({
      limit: JSON_BODY_LIMIT,
    }),
  );
}

/* ============================================================
   MCP TOOLS
   ============================================================ */

registerTools(
  server,
  client,
  config,
  undefined,
  pendingVoucherStore,
);

/* ============================================================
   STARTUP LOGGING
   ============================================================ */

const buildInfo = resolveBuildInfo(process.env);

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(
    config,
  )} build=${buildLogLabel(buildInfo)} persistence=${pendingVoucherStore.mode} bodyLimit=${
    bodyParsingConfigured
      ? `${JSON_BODY_LIMIT} (/mcp, post-auth)`
      : "default(~100kb)"
  }`,
);

console.error(
  "[lexware-webhook] endpoint=/webhooks/lexware event=voucher.created",
);

for (
  const warning of config.warnings
) {
  console.error(
    `[lexware-mcp] WARNING: ${warning}`,
  );
}

if (!bodyParsingConfigured) {
  console.error(
    "[lexware-mcp] WARNING: could not raise the JSON body limit — uploads over ~100 KB may fail.",
  );
}

if (
  config.auth.mode === "oauth" &&
  config.auth
    .allowedEmailDomains.length === 0
) {
  console.error(
    "[lexware-mcp] WARNING: OAuth mode accepts ANY user of the IdP (OAUTH_ALLOW_ANY_USER=true).",
  );
}

if (
  getLexwareWebhookPublicKey() &&
  config.webhookOrganizationId === undefined
) {
  console.error(
    "[lexware-mcp] WARNING: LEXWARE_ORGANIZATION_ID is not set — signed webhooks of ANY Lexware organization are accepted.",
  );
}

if (
  config.auth.mode === "none"
) {
  console.error(
    "[lexware-mcp] WARNING: /mcp is UNAUTHENTICATED.",
  );
}

/* ============================================================
   RUN
   ============================================================ */

export default await server.run();

export type AppType =
  typeof server;
