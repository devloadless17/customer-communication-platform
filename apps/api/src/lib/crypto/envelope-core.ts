import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption primitives — no `server-only` guard so this module is
 * importable from plain Node scripts under prisma/seeds/ when they need to
 * write encrypted rows. Application code should import from `./envelope`
 * instead, which re-exports these with the client-leak guard.
 */

const VERSION_PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and add it to .env. Boot-time env validation lives in @ccp/config (validateEnv).",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        "Regenerate with `openssl rand -base64 32`.",
    );
  }
  cachedKey = decoded;
  return decoded;
}

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return VERSION_PREFIX + packed.toString("base64");
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(VERSION_PREFIX)) {
    // Plaintext passthrough is a dev-convenience only — it lets seeds and
    // local fixtures write secrets without setting ENCRYPTION_KEY. In
    // production, a missing prefix means SOMEONE wrote a secret without
    // calling `encryptSecret` (forgot the wrapper, raw SQL backfill, etc.)
    // and it's living plaintext on disk. Fail loudly: silent passthrough
    // turns an "encrypted at rest" claim into security theater discoverable
    // only via a DB dump.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "decryptSecret: unencrypted value found in production. " +
          "Every secret column must be written via encryptSecret(). " +
          "Inspect the offending row and re-encrypt in place.",
      );
    }
    return value;
  }
  const key = loadKey();
  const packed = Buffer.from(value.slice(VERSION_PREFIX.length), "base64");
  if (packed.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("encrypted secret is truncated");
  }
  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(VERSION_PREFIX);
}
