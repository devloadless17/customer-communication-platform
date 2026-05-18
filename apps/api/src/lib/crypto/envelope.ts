/**
 * Envelope encryption for the per-team Meta secrets stored on the Team row
 * (CLAUDE.md rule #6 reminder + the schema TODO at metaAccessToken). The DB
 * column type stays `String?` — we just store ciphertext instead of plaintext.
 *
 * Algorithm: AES-256-GCM with a fresh 96-bit IV per encryption. The 128-bit
 * GCM auth tag protects against modification — decrypt throws on any flip
 * rather than silently returning garbage.
 *
 * Key source: `ENCRYPTION_KEY` env var, base64-encoded 32 bytes. Generate
 * with `openssl rand -base64 32`. Rotating the key without re-encrypting the
 * rows breaks every team's WhatsApp integration, so treat it like
 * BETTER_AUTH_SECRET — set once, rotate via a migration that re-encrypts.
 *
 * Wire format: `enc:v1:<base64(iv || authTag || ciphertext)>`. The version
 * prefix lets `decryptSecret` detect plaintext (no prefix = pre-encryption
 * legacy row) and pass it through unchanged. That tolerance is intentional:
 * existing pilots and the dev DB hold plaintext today; flipping to strict
 * decrypt would break the very moment this code ships. Re-saving credentials
 * via the UI rewrites them as ciphertext.
 *
 * The implementation lives in ./envelope-core (no `server-only` guard) so
 * standalone scripts under prisma/seeds/ can import it from plain Node.
 * Application code should keep importing from this file.
 */

export { encryptSecret, decryptSecret, isEncrypted } from "./envelope-core";
