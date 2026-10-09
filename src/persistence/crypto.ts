import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptionKey {
  id: string;
  key: Buffer;
}

export interface EncryptedValue {
  keyId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

function validateKey(key: EncryptionKey): void {
  if (key.key.length !== 32) throw new Error("Persistence encryption key must be exactly 32 bytes.");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key.id)) throw new Error("Invalid persistence key id.");
}

export function encryptString(
  plaintext: string,
  key: EncryptionKey,
  aad: string,
): EncryptedValue {
  validateKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    keyId: key.id,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptString(
  value: EncryptedValue,
  keys: ReadonlyMap<string, Buffer>,
  aad: string,
): string {
  const key = keys.get(value.keyId);
  if (!key || key.length !== 32) throw new Error("Persistence decryption key unavailable.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(value.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
