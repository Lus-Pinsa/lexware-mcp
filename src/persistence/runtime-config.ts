import { createEncryptionKeyring, sha256Hex, type EncryptionKeyring } from "./crypto.js";
import { type TenantId, PersistenceValidationError, parseTenantId } from "./types.js";

const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface DisabledPersistenceRuntimeConfig {
  readonly enabled: false;
}

export interface PersistenceRuntimeSecrets {
  getDatabaseUrl(): string;
  getAuditActorSalt(): Uint8Array;
  readonly keyring: EncryptionKeyring;
}

export interface EnabledPersistenceRuntimeConfig {
  readonly enabled: true;
  readonly tenantId: TenantId;
  readonly organizationIdHash: string;
  readonly expectedRuntimeRole: string;
  readonly tlsMode: "verify-full" | "require";
  readonly secrets: PersistenceRuntimeSecrets;
}

export type PersistenceRuntimeConfig =
  | DisabledPersistenceRuntimeConfig
  | EnabledPersistenceRuntimeConfig;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new PersistenceValidationError("Invalid persistence boolean configuration.");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new PersistenceValidationError("Missing required persistence configuration: " + name + ".");
  }
  return value;
}

function decodeCanonicalBase64(
  raw: string,
  field: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array {
  if (raw.length < 4 || raw.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  const decoded = Buffer.from(raw, "base64");
  if (
    decoded.byteLength < minBytes ||
    decoded.byteLength > maxBytes ||
    decoded.toString("base64") !== raw
  ) {
    throw new PersistenceValidationError("Invalid " + field + ".");
  }
  return new Uint8Array(decoded);
}

function parseKeyring(
  raw: string,
  currentKeyId: string,
): EncryptionKeyring {
  if (raw.length > 4096) {
    throw new PersistenceValidationError("Persistence keyring is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersistenceValidationError("Invalid persistence keyring JSON.");
  }

  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object"
  ) {
    throw new PersistenceValidationError("Invalid persistence keyring.");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 8) {
    throw new PersistenceValidationError("Persistence keyring must contain 1 to 8 keys.");
  }

  const decoded = Object.create(null) as Record<string, Uint8Array>;
  for (const [keyId, encoded] of entries) {
    if (typeof encoded !== "string") {
      throw new PersistenceValidationError("Invalid persistence keyring value.");
    }
    decoded[keyId] = decodeCanonicalBase64(
      encoded,
      "persistence encryption key",
      32,
      32,
    );
  }

  return createEncryptionKeyring(decoded, currentKeyId);
}

export function loadPersistenceRuntimeConfig(
  env: NodeJS.ProcessEnv,
  organizationId: string | undefined,
): PersistenceRuntimeConfig {
  const enabled = parseBool(env.PERSISTENCE_ENABLED, false);
  if (!enabled) return Object.freeze({ enabled: false });

  const databaseUrl = required(env, "PERSISTENCE_DATABASE_URL");
  try {
    const url = new URL(databaseUrl);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.pathname ||
      url.pathname === "/"
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new PersistenceValidationError("Invalid PERSISTENCE_DATABASE_URL.");
  }
  const tenantId = parseTenantId(required(env, "LUS_TENANT_ID"));
  const expectedRuntimeRole =
    env.PERSISTENCE_RUNTIME_ROLE?.trim() || "lus_runtime";
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(expectedRuntimeRole)) {
    throw new PersistenceValidationError("Invalid PERSISTENCE_RUNTIME_ROLE.");
  }

  const tlsModeRaw =
    env.PERSISTENCE_TLS_MODE?.trim() || "verify-full";
  if (tlsModeRaw !== "verify-full" && tlsModeRaw !== "require") {
    throw new PersistenceValidationError("Invalid PERSISTENCE_TLS_MODE.");
  }
  const tlsMode = tlsModeRaw;
  if (!organizationId?.trim()) {
    throw new PersistenceValidationError(
      "LEXWARE_ORGANIZATION_ID is required when persistence is enabled.",
    );
  }
  const normalizedOrganizationId = organizationId.trim().toLowerCase();
  if (!ORGANIZATION_ID_PATTERN.test(normalizedOrganizationId)) {
    throw new PersistenceValidationError(
      "LEXWARE_ORGANIZATION_ID is invalid for persistence binding.",
    );
  }

  const currentKeyId = required(env, "PERSISTENCE_CURRENT_KEY_ID");
  const keyring = parseKeyring(required(env, "PERSISTENCE_KEYRING"), currentKeyId);
  const auditActorSalt = decodeCanonicalBase64(
    required(env, "PERSISTENCE_AUDIT_ACTOR_SALT"),
    "persistence audit actor salt",
    32,
    32,
  );

  const secrets = Object.freeze({
    keyring,
    getDatabaseUrl(): string {
      return databaseUrl;
    },
    getAuditActorSalt(): Uint8Array {
      return new Uint8Array(auditActorSalt);
    },
  });

  const config = {
    enabled: true as const,
    tenantId,
    expectedRuntimeRole,
    tlsMode,
    secrets,
  } as EnabledPersistenceRuntimeConfig;

  const organizationIdHash = sha256Hex(normalizedOrganizationId);
  Object.defineProperties(config, {
    organizationIdHash: { value: organizationIdHash, enumerable: false },
    toJSON: {
      value: () => ({
        enabled: true,
        tenantConfigured: true,
        secretsIncluded: false,
      }),
      enumerable: false,
    },
  });

  return Object.freeze(config);
}
