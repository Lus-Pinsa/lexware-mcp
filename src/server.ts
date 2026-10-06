import { createVerify } from "node:crypto";
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
import { addPendingVoucherEvent } from "./pending-voucher-events.js";
/**
 * Base64 file uploads
 * (upload-file / upload-voucher-file)
 * travel inline in the JSON-RPC body.
 */
const JSON_BODY_LIMIT = "12mb";

const isMcpPath = (p: string): boolean =>
  p === "/mcp" || p.startsWith("/mcp/");

const isLexwareWebhookPath = (p: string): boolean =>
  p === "/webhooks/lexware" ||
  p.startsWith("/webhooks/lexware/");

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

type LexwareWebhookPayload = {
  organizationId: string;
  eventType: string;
  resourceId: string;
  eventDate: string;
};

/**
 * Lexware signs webhook payloads.
 *
 * Public key comes from:
 * LEXWARE_WEBHOOK_PUBLIC_KEY
 */
function verifyLexwareWebhookSignature(
  rawBody: Buffer,
  signatureBase64: string,
  publicKey: string,
): boolean {
  try {
    const verifier =
      createVerify("RSA-SHA512");

    verifier.update(rawBody);
    verifier.end();

    return verifier.verify(
      publicKey,
      Buffer.from(
        signatureBase64,
        "base64",
      ),
    );
  } catch (err) {
    console.error(
      "[lexware-webhook] signature verification error",
      err instanceof Error
        ? err.message
        : "unknown error",
    );

    return false;
  }
}

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

  (req: Request, res: Response) => {
    const publicKey =
      getLexwareWebhookPublicKey();

    if (!publicKey) {
      console.error(
        "[lexware-webhook] LEXWARE_WEBHOOK_PUBLIC_KEY missing",
      );

      res.sendStatus(503);
      return;
    }

    const signature =
      req.get("x-lxo-signature");

    if (!signature) {
      console.error(
        "[lexware-webhook] missing X-Lxo-Signature",
      );

      res.sendStatus(401);
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      console.error(
        "[lexware-webhook] body is not raw Buffer",
      );

      res.sendStatus(400);
      return;
    }

    const rawBody =
      req.body as Buffer;

    const valid =
      verifyLexwareWebhookSignature(
        rawBody,
        signature,
        publicKey,
      );

    if (!valid) {
      console.error(
        "[lexware-webhook] invalid signature",
      );

      res.sendStatus(401);
      return;
    }

    let payload: LexwareWebhookPayload;

    try {
      payload =
        JSON.parse(
          rawBody.toString("utf8"),
        ) as LexwareWebhookPayload;
    } catch {
      console.error(
        "[lexware-webhook] invalid JSON",
      );

      res.sendStatus(400);
      return;
    }

    if (
      !payload.organizationId ||
      !payload.eventType ||
      !payload.resourceId ||
      !payload.eventDate
    ) {
      console.error(
        "[lexware-webhook] incomplete payload",
      );

      res.sendStatus(400);
      return;
    }

    /**
     * Phase 1:
     * Only voucher.created is processed.
     *
     * Other Lexware events are acknowledged
     * but ignored.
     */
    if (
      payload.eventType !==
      "voucher.created"
    ) {
      console.error(
        `[lexware-webhook] ignored event=${payload.eventType} resourceId=${payload.resourceId}`,
      );

      res.sendStatus(204);
      return;
    }

    const pending = addPendingVoucherEvent({
  resourceId: payload.resourceId,
  eventDate: payload.eventDate,
});

console.error(
  `[lexware-webhook] NEW VOUCHER resourceId=${payload.resourceId} eventDate=${payload.eventDate} pending=${pending.count} added=${pending.added}`,
);

    /**
     * IMPORTANT:
     * For now we only RECEIVE the event.
     *
     * Next step:
     * resourceId → pending queue → MCP tool → Claude
     */

    res.sendStatus(204);
  },
);

/* ============================================================
   DEBUG LOGGING
   ============================================================ */

server.use(
  (req, _res, next) => {
    if (
      req.path === "/mcp" ||
      req.path.startsWith("/mcp/") ||
      req.path.startsWith(
        "/.well-known/",
      )
    ) {
      console.error(
        `[debug] ${req.method} ${req.path} auth=${
          req.headers.authorization
            ? "yes"
            : "no"
        } accept=${
          req.headers.accept ?? ""
        } ua=${
          req.headers["user-agent"] ?? ""
        }`,
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
);

/* ============================================================
   STARTUP LOGGING
   ============================================================ */

const buildInfo = resolveBuildInfo(process.env);

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(
    config,
  )} build=${buildLogLabel(buildInfo)} bodyLimit=${
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
    "[lexware-mcp] WARNING: OAuth mode with no OAUTH_ALLOWED_EMAIL_DOMAINS.",
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
