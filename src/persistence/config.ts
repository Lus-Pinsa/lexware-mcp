import { asTenantId, type TenantId } from "./types.js";

export interface PersistenceConfigDisabled {
  enabled: false;
}

export interface PersistenceConfigEnabled {
  enabled: true;
  databaseUrl: string;
  tenantId: TenantId;
  encryptionKeyId: string;
  encryptionKey: Buffer;
  auditActorPepper: Buffer;
}

export type PersistenceConfig = PersistenceConfigDisabled | PersistenceConfigEnabled;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error("Invalid PERSISTENCE_ENABLED boolean.");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when persistence is enabled.`);
  return value;
}

function parseSecret32(raw: string, name: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${name} must be base64-encoded.`);
  }
  // Buffer.from(base64) is permissive, so require canonical round-trip too.
  if (decoded.length !== 32 || decoded.toString("base64") !== raw) {
    throw new Error(`${name} must decode to exactly 32 bytes.`);
  }
  return decoded;
}

function validateDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PERSISTENCE_DATABASE_URL is invalid.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PERSISTENCE_DATABASE_URL must use PostgreSQL.");
  }
  if (!url.hostname || !url.username) {
    throw new Error("PERSISTENCE_DATABASE_URL is missing required connection fields.");
  }
  if (url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("PERSISTENCE_DATABASE_URL must set sslmode=verify-full.");
  }
  return raw;
}

export function loadPersistenceConfig(env: NodeJS.ProcessEnv = process.env): PersistenceConfig {
  if (!parseBool(env.PERSISTENCE_ENABLED, false)) return { enabled: false };

  const databaseUrl = validateDatabaseUrl(required(env, "PERSISTENCE_DATABASE_URL"));
  const tenantId = asTenantId(required(env, "PERSISTENCE_TENANT_ID"));
  const encryptionKeyId = required(env, "PERSISTENCE_ENCRYPTION_KEY_ID");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(encryptionKeyId)) {
    throw new Error("PERSISTENCE_ENCRYPTION_KEY_ID is invalid.");
  }

  return {
    enabled: true,
    databaseUrl,
    tenantId,
    encryptionKeyId,
    encryptionKey: parseSecret32(required(env, "PERSISTENCE_ENCRYPTION_KEY"), "PERSISTENCE_ENCRYPTION_KEY"),
    auditActorPepper: parseSecret32(required(env, "PERSISTENCE_AUDIT_PEPPER"), "PERSISTENCE_AUDIT_PEPPER"),
  };
}
