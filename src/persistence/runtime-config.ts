import { createEncryptionKeyring, sha256Hex, type EncryptionKeyring } from "./crypto.js";
import { type TenantId, parseTenantId } from "./types.js";

const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const BASE64_32_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const MAX_KEYRING_ENTRIES = 8;

export class PersistenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConfigError";
  }
}

export type PersistenceRuntimeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      /** SECRET: never include in logs or tool output. */
      readonly databaseUrl: string;
      readonly tenantId: TenantId;
      readonly organizationIdHash: string;
      /** SECRET-bearing key lookup; never serialize or log. */
      readonly keyring: EncryptionKeyring;
      /** SECRET: only for HMAC hashing of audit actors. */
      readonly auditActorSalt: Uint8Array;
    };

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new PersistenceConfigError("Invalid PERSISTENCE_ENABLED boolean.");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new PersistenceConfigError(name + " is required when persistence is enabled.");
  return value;
}

function parseBase64Key(raw: string, label: string): Uint8Array {
  if (!BASE64_32_PATTERN.test(raw)) {
    throw new PersistenceConfigError(label + " must be a base64-encoded 32-byte value.");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== raw) {
    throw new PersistenceConfigError(label + " must be a base64-encoded 32-byte value.");
  }
  return new Uint8Array(decoded);
}

function parseKeyring(raw: string, currentKeyId: string): EncryptionKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersistenceConfigError("PERSISTENCE_KEYRING_JSON must be valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PersistenceConfigError("PERSISTENCE_KEYRING_JSON must be a JSON object.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEYRING_ENTRIES) {
    throw new PersistenceConfigError("PERSISTENCE_KEYRING_JSON must contain 1 to 8 keys.");
  }

  const keys = Object.create(null) as Record<string, Uint8Array>;
  for (const [keyId, value] of entries) {
    if (typeof value !== "string") {
      throw new PersistenceConfigError("PERSISTENCE_KEYRING_JSON values must be base64 strings.");
    }
    keys[keyId] = parseBase64Key(value, "Persistence encryption key");
  }

  try {
    return createEncryptionKeyring(keys, currentKeyId);
  } catch {
    throw new PersistenceConfigError("Persistence encryption keyring is invalid.");
  }
}

function validateDatabaseUrl(raw: string): string {
  if (raw.length > 4096 || raw.trim() !== raw) {
    throw new PersistenceConfigError("PERSISTENCE_DATABASE_URL is invalid.");
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      url.pathname === "/"
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new PersistenceConfigError("PERSISTENCE_DATABASE_URL is invalid.");
  }
  return raw;
}

export function loadPersistenceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PersistenceRuntimeConfig {
  const enabled = parseBool(env.PERSISTENCE_ENABLED, false);
  if (!enabled) return Object.freeze({ enabled: false });

  const databaseUrl = validateDatabaseUrl(required(env, "PERSISTENCE_DATABASE_URL"));
  const tenantId = parseTenantId(required(env, "LUS_TENANT_ID"));

  const organizationId = required(env, "LEXWARE_ORGANIZATION_ID");
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
    throw new PersistenceConfigError("LEXWARE_ORGANIZATION_ID is invalid for persistence binding.");
  }
  const organizationIdHash = sha256Hex(organizationId.toLowerCase());

  const currentKeyId = required(env, "PERSISTENCE_CURRENT_KEY_ID");
  const keyring = parseKeyring(required(env, "PERSISTENCE_KEYRING_JSON"), currentKeyId);
  const auditActorSalt = parseBase64Key(
    required(env, "PERSISTENCE_AUDIT_ACTOR_SALT"),
    "PERSISTENCE_AUDIT_ACTOR_SALT",
  );

  const config = {
    enabled: true as const,
    tenantId,
  } as {
    enabled: true;
    tenantId: TenantId;
    organizationIdHash: string;
    databaseUrl: string;
    keyring: EncryptionKeyring;
    auditActorSalt: Uint8Array;
  };

  // Keep FINANCIAL/SECRET fields out of ordinary object enumeration and JSON logs.
  Object.defineProperties(config, {
    organizationIdHash: { value: organizationIdHash, enumerable: false },
    databaseUrl: { value: databaseUrl, enumerable: false },
    keyring: { value: keyring, enumerable: false },
    auditActorSalt: { get: () => new Uint8Array(auditActorSalt), enumerable: false },
    toJSON: {
      value: () => ({ enabled: true, tenantConfigured: true, secretsIncluded: false }),
      enumerable: false,
    },
  });

  return Object.freeze(config);
}
