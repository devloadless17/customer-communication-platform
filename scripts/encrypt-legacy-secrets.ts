/**
 * One-shot migration: rewrite any plaintext Meta secrets on the Team row as
 * envelope-encrypted ciphertext (lib/crypto/envelope.ts).
 *
 * When to run: once, immediately after deploying the version that introduced
 * envelope encryption AND after setting ENCRYPTION_KEY in the environment.
 * Existing teams have plaintext rows; read paths tolerate them (legacy
 * passthrough), but at-rest data isn't actually protected until this rewrites
 * them as ciphertext.
 *
 *   docker compose exec app npx tsx scripts/encrypt-legacy-secrets.ts --dry-run
 *   docker compose exec app npx tsx scripts/encrypt-legacy-secrets.ts
 *
 * Flags:
 *   --dry-run   Report which rows WOULD be rewritten without touching the DB.
 *               Run this first to sanity-check the count before committing.
 *
 * Idempotent: rows already in `enc:v1:` wire format are skipped, so a
 * second run is a no-op. Safe to schedule from a deploy hook.
 *
 * What it touches: only metaAccessToken and metaAppSecret. metaVerifyToken is
 * lower-sensitivity and stays plaintext for now (it's also referenced by Meta
 * in the dashboard, so admins paste it around — encrypting it would block the
 * admin from seeing what they just configured).
 *
 * ─── Recovery / rollback ───────────────────────────────────────────────────
 *
 * The encryption is one-way without the key. If ENCRYPTION_KEY is lost or
 * rotated WITHOUT first re-encrypting rows, every team's WhatsApp integration
 * breaks (decryptSecret throws → getMetaSendConfig surfaces it as
 * ProviderNotConfigured → reply box and broadcasts grey out).
 *
 * Options to recover, in order of preference:
 *
 *   1. Restore ENCRYPTION_KEY from your secret store. If you still have the
 *      original key (1Password / Doppler / vault), put it back into the env
 *      and restart the app. No DB work needed.
 *
 *   2. Restore the Team rows from a Postgres backup taken BEFORE this script
 *      ran. The script leaves verifyToken untouched, so a partial restore of
 *      just metaAccessToken + metaAppSecret on the affected teams is enough.
 *
 *   3. Re-onboard each team manually. Admin opens /settings/whatsapp and
 *      pastes their Meta credentials again — the save handler rewrites the
 *      columns as ciphertext under the current key. Painful but always works.
 *
 * Key rotation (planned): generate a new key, set BOTH old and new in env,
 * write a `rotate-encryption-key.ts` script that decrypts with old + reencrypts
 * with new in a single tx per row, then drop the old key. Not implemented yet
 * — single-key world is fine for pilot scale; revisit when the first team
 * asks for HSM-backed rotation.
 */

import { PrismaClient } from "@prisma/client";

import { encryptSecret, isEncrypted } from "../lib/crypto/envelope-core";

const db = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (DRY_RUN) {
    console.log("[encrypt-legacy-secrets] DRY RUN — no rows will be modified");
  }

  const teams = await db.team.findMany({
    where: {
      OR: [
        { metaAccessToken: { not: null } },
        { metaAppSecret: { not: null } },
      ],
    },
    select: { id: true, name: true, metaAccessToken: true, metaAppSecret: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const team of teams) {
    const fieldsToEncrypt: string[] = [];
    const data: { metaAccessToken?: string; metaAppSecret?: string } = {};
    if (team.metaAccessToken && !isEncrypted(team.metaAccessToken)) {
      fieldsToEncrypt.push("metaAccessToken");
      if (!DRY_RUN) data.metaAccessToken = encryptSecret(team.metaAccessToken);
    }
    if (team.metaAppSecret && !isEncrypted(team.metaAppSecret)) {
      fieldsToEncrypt.push("metaAppSecret");
      if (!DRY_RUN) data.metaAppSecret = encryptSecret(team.metaAppSecret);
    }
    if (fieldsToEncrypt.length === 0) {
      skipped++;
      continue;
    }
    if (!DRY_RUN) {
      await db.team.update({ where: { id: team.id }, data });
    }
    console.log(
      `[encrypt-legacy-secrets]${DRY_RUN ? " [dry-run]" : ""} team=${team.id} (${team.name}) — ${DRY_RUN ? "would encrypt" : "encrypted"} ${fieldsToEncrypt.join(", ")}`,
    );
    updated++;
  }

  console.log(
    `[encrypt-legacy-secrets]${DRY_RUN ? " [dry-run]" : ""} done. ${DRY_RUN ? "would-encrypt" : "encrypted"}=${updated} already-encrypted=${skipped} total=${teams.length}`,
  );
}

main()
  .catch((err) => {
    console.error("[encrypt-legacy-secrets] failed", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
