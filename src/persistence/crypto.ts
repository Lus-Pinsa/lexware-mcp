import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  type EncryptedValue,
  PersistenceValidationError,
  type TenantId,
  assertSha256Hex,
} from "./types.js";

const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CONTEXT_COMPONENT_LENGTH = 128;

export interface EncryptionContext {
  readonly tenantId: TenantId;
  readonly table: string;
  readonly field: string;
  readonly recordId: string;
}

export interface EncryptionKeyring {
  readonly currentKeyId: string;
  getKey(keyId: string): Uint8Array | undefined;
}

function copyKey(key: Uint8Array): Uint8Array {
  return new Uint8Array(key);
}

export function createEncryptionKeyring(
  keys: Readonly<Record<string, Uint8Array>>,
  currentKeyId: string,
): EncryptionKeyring {
  if (!KEY_ID_PATTERN.test(currentKeyId)) {
    throw new PersistenceValidationError("Invalid current encryption key id.");
  }

  const copied = new Map<string, Uint8Array>();
  for (const [keyId, key] of Object.entries(keys)) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new PersistenceValidationError("Invalid encryption key id.");
    }
    if (key.byteLength !== AES_KEY_BYTES) {
      throw new PersistenceValidationError("Encryption keys must be exactly 32 bytes.");
    }
    copied.set(keyId, copyKey(key));
  }
  if (!copied.has(currentKeyId)) {
    throw new PersistenceValidationError("Current encryption key id is not present in the keyring.");
  }

  return Object.freeze({
    currentKeyId,
    getKey(keyId: string): Uint8Array | undefined {
      const key = copied.get(keyId);
      return key === undefined ? undefined : copyKey(key);
    },
  });
}

function validateContextPart(value: string, label: string): string {
  if (value.length < 1 || value.length > MAX_CONTEXT_COMPONENT_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PersistenceValidationError(`Invalid encryption context ${label}.`);
  }
  return value;
}

function aad(context: EncryptionContext): Buffer {
  const table = validateContextPart(context.table, "table");
  const field = validateContextPart(context.field, "field");
  const recordId = validateContextPart(context.recordId, "recordId");
  return Buffer.from(
    JSON.stringify({ v: 1, tenantId: context.tenantId, table, field, recordId }),
    "utf8",
  );
}

export function encryptField(
  keyring: EncryptionKeyring,
  plaintext: string,
  context: EncryptionContext,
): EncryptedValue {
  const key = keyring.getKey(keyring.currentKeyId);
  if (key === undefined) {
    throw new PersistenceValidationError("Current encryption key is unavailable.");
  }

  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Object.freeze({
    ciphertext: new Uint8Array(ciphertext),
    nonce: new Uint8Array(nonce),
    authTag: new Uint8Array(authTag),
    keyId: keyring.currentKeyId,
  });
}

export function decryptField(
  keyring: EncryptionKeyring,
  encrypted: EncryptedValue,
  context: EncryptionContext,
): string {
  if (encrypted.nonce.byteLength !== GCM_NONCE_BYTES || encrypted.authTag.byteLength !== GCM_TAG_BYTES) {
    throw new PersistenceValidationError("Invalid encrypted field envelope.");
  }
  if (!KEY_ID_PATTERN.test(encrypted.keyId)) {
    throw new PersistenceValidationError("Invalid encrypted field key id.");
  }

  const key = keyring.getKey(encrypted.keyId);
  if (key === undefined) {
    throw new PersistenceValidationError("Encryption key is unavailable.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(encrypted.authTag));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256Hex(value: string | Uint8Array): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return assertSha256Hex(digest);
}

export function hashAuditActor(actor: string, salt: Uint8Array): string {
  if (actor.length < 1 || actor.length > 512) {
    throw new PersistenceValidationError("Invalid audit actor.");
  }
  if (salt.byteLength < 16) {
    throw new PersistenceValidationError("Audit actor salt must be at least 16 bytes.");
  }
  return assertSha256Hex(createHmac("sha256", salt).update(actor, "utf8").digest("hex"), "audit actor hash");
}
