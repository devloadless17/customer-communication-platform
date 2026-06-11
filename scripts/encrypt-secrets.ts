/**
 * Re-encrypt stored secrets at rest. Two jobs in one script:
 *
 *   1. ENCRYPT PLAINTEXT (default) — rewrite any un-prefixed (legacy plaintext)
 *      secret row as `enc:v1:<base64>` using the current ENCRYPTION_KEY. Run
 *      this after restoring a pre-encryption dump or a raw-SQL backfill, before
 *      the api touches the row (decryptSecret THROWS in production on a
 *      plaintext value — see apps/api/src/lib/crypto/envelope-core.ts).
 *
 *   2. ROTATE THE KEY — set ENCRYPTION_KEY_OLD to the previous key and
 *      ENCRYPTION_KEY to the new one; every `enc:v1:` row is decrypted with the
 *      old key and re-encrypted with the new one. Plaintext rows are encrypted
 *      with the new key in the same pass.
 *
 * Run inside the api container, from the repo root (/app in the image) so
 * .env / prisma.config resolution matches the other scripts. The api image
 * sets SWC_NODE_PROJECT, so @swc-node/register compiles this TS directly.
 *
 *   # encrypt plaintext rows with the current key
 *   docker compose exec --workdir /app api node -r @swc-node/register scripts/encrypt-secrets.ts
 *
 *   # rotate: decrypt with old key, re-encrypt with new key
 *   docker compose exec --workdir /app -e ENCRYPTION_KEY_OLD=<old-base64> api \
 *     node -r @swc-node/register scripts/encrypt-secrets.ts
 *
 *   # preview without writing
 *   docker compose exec --workdir /app api node -r @swc-node/register scripts/encrypt-secrets.ts --dry-run
 *
 * Covers every envelope-encrypted secret location in the current schema:
 *   - ChannelConnection.secrets        { accessToken?, appSecret? }
 *   - OutboundWebhook.secret            string
 *   - Workflow.triggerConfig.secret     string (incoming_webhook HMAC)
 *   - Workflow.graph.nodes[].config     http_request bearerToken + customHeaders
 *
 * NOT covered (by design): TeamApiKey stores a one-way `tokenHash`, not
 * reversible ciphertext — there's nothing to re-encrypt, and a key rotation
 * leaves it untouched.
 *
 * Idempotent under a stable key (already-current rows decode-then-re-encode to
 * an equivalent value; we skip writing when nothing in a row changed). The
 * crypto here is a self-contained copy of the envelope-core wire format so the
 * script can hold TWO keys at once (old + new) — the shared module caches a
 * single key and can't decrypt-old / encrypt-new in one process.
 */

import { existsSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const VERSION_PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const DRY_RUN = process.argv.includes("--dry-run");

function decodeKey(raw: string | undefined, name: string): Buffer {
  if (!raw) {
    throw new Error(`${name} is not set. Generate with: openssl rand -base64 32.`);
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${name} must base64-decode to ${KEY_BYTES} bytes (got ${decoded.length}).`,
    );
  }
  return decoded;
}

const NEW_KEY = decodeKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
// Old key is optional — only needed for rotation. When unset, decryption of
// existing ciphertext falls back to the new key (i.e. they're already current).
const OLD_KEY = process.env.ENCRYPTION_KEY_OLD
  ? decodeKey(process.env.ENCRYPTION_KEY_OLD, "ENCRYPTION_KEY_OLD")
  : NEW_KEY;

function isEncrypted(value: string): boolean {
  return value.startsWith(VERSION_PREFIX);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", NEW_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptWith(value: string, key: Buffer): string {
  const packed = Buffer.from(value.slice(VERSION_PREFIX.length), "base64");
  if (packed.length < IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error("encrypted secret is truncated");
  }
  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Normalize one secret string to ciphertext-under-NEW_KEY. Returns the rewritten
 * value, or null when no rewrite is needed (already current — only possible when
 * not rotating, since under rotation every enc:v1: row is re-keyed).
 */
function normalize(value: string): string | null {
  if (!value) return null;
  if (isEncrypted(value)) {
    // Already ciphertext. Re-key only when rotating (old key differs).
    if (OLD_KEY.equals(NEW_KEY)) return null;
    const plaintext = decryptWith(value, OLD_KEY);
    return encrypt(plaintext);
  }
  // Plaintext → encrypt with the new key.
  return encrypt(value);
}

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

let rewritten = 0;

async function run(): Promise<void> {
  const mode = OLD_KEY.equals(NEW_KEY) ? "encrypt-plaintext" : "rotate-key";
  console.log(
    `encrypt-secrets: mode=${mode}${DRY_RUN ? " (dry-run)" : ""}`,
  );

  // 1. ChannelConnection.secrets { accessToken?, appSecret? }
  const conns = await db.channelConnection.findMany({
    select: { id: true, secrets: true },
  });
  for (const conn of conns) {
    const secrets = (conn.secrets ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...secrets };
    let changed = false;
    for (const field of ["accessToken", "appSecret"]) {
      const v = secrets[field];
      if (typeof v !== "string" || v.length === 0) continue;
      const rw = normalize(v);
      if (rw !== null) {
        next[field] = rw;
        changed = true;
      }
    }
    if (changed) {
      rewritten++;
      console.log(`  ChannelConnection ${conn.id}: secrets re-encrypted`);
      if (!DRY_RUN) {
        await db.channelConnection.update({
          where: { id: conn.id },
          data: { secrets: next as Prisma.InputJsonValue },
        });
      }
    }
  }

  // 2. OutboundWebhook.secret (string)
  const hooks = await db.outboundWebhook.findMany({ select: { id: true, secret: true } });
  for (const h of hooks) {
    const rw = normalize(h.secret);
    if (rw !== null) {
      rewritten++;
      console.log(`  OutboundWebhook ${h.id}: secret re-encrypted`);
      if (!DRY_RUN) {
        await db.outboundWebhook.update({ where: { id: h.id }, data: { secret: rw } });
      }
    }
  }

  // 3. Workflow.triggerConfig.secret + graph http_request bearerToken/customHeaders
  const workflows = await db.workflow.findMany({
    select: { id: true, triggerConfig: true, graph: true },
  });
  for (const wf of workflows) {
    let changed = false;
    const data: Prisma.WorkflowUpdateInput = {};

    const trigger = (wf.triggerConfig ?? {}) as Record<string, unknown>;
    const triggerSecret = trigger.secret;
    if (typeof triggerSecret === "string" && triggerSecret.length > 0) {
      const rw = normalize(triggerSecret);
      if (rw !== null) {
        data.triggerConfig = { ...trigger, secret: rw } as Prisma.InputJsonValue;
        changed = true;
      }
    }

    const graph = wf.graph as { nodes?: Array<Record<string, unknown>> } | null;
    if (graph && Array.isArray(graph.nodes)) {
      let graphChanged = false;
      const nodes = graph.nodes.map((node) => {
        if (node.type !== "http_request" || !node.config || typeof node.config !== "object") {
          return node;
        }
        const cfg = { ...(node.config as Record<string, unknown>) };
        let nodeChanged = false;
        const token = cfg.bearerToken;
        if (typeof token === "string" && token.length > 0) {
          const rw = normalize(token);
          if (rw !== null) {
            cfg.bearerToken = rw;
            nodeChanged = true;
          }
        }
        const headers = cfg.customHeaders;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          const enc: Record<string, unknown> = {};
          let headersChanged = false;
          for (const [hk, hv] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof hv === "string" && hv.length > 0) {
              const rw = normalize(hv);
              if (rw !== null) {
                enc[hk] = rw;
                headersChanged = true;
                continue;
              }
            }
            enc[hk] = hv;
          }
          if (headersChanged) {
            cfg.customHeaders = enc;
            nodeChanged = true;
          }
        }
        if (nodeChanged) graphChanged = true;
        return nodeChanged ? { ...node, config: cfg } : node;
      });
      if (graphChanged) {
        data.graph = { ...graph, nodes } as Prisma.InputJsonValue;
        changed = true;
      }
    }

    if (changed) {
      rewritten++;
      console.log(`  Workflow ${wf.id}: trigger/graph secrets re-encrypted`);
      if (!DRY_RUN) {
        await db.workflow.update({ where: { id: wf.id }, data });
      }
    }
  }

  console.log(
    `encrypt-secrets: ${DRY_RUN ? "would rewrite" : "rewrote"} ${rewritten} row(s).`,
  );
}

run()
  .then(() => db.$disconnect())
  .catch((err) => {
    console.error("encrypt-secrets: FAILED —", err);
    return db.$disconnect().finally(() => process.exit(1));
  });
