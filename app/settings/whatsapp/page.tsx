import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { canManageUsers } from "@/lib/auth/permissions";

import { WhatsappSettings, type WhatsappCurrent } from "./whatsapp-settings";

export const metadata = {
  title: "WhatsApp · Settings",
};

export const dynamic = "force-dynamic";

export default async function WhatsappSettingsPage() {
  const { user, teamId } = await getSession();

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      metaPhoneNumberId: true,
      metaDisplayPhoneNumber: true,
      metaWabaId: true,
      metaAppId: true,
      metaVerifyToken: true,
      // Tradeoff: shipping the access token + app secret to the browser so
      // the "Update credentials" form can pre-fill them. Acceptable for a
      // single-admin pilot; if you onboard multi-admin teams, swap to a
      // mask + reveal-on-demand pattern (one extra route).
      metaAccessToken: true,
      metaAppSecret: true,
    },
  });

  // Decrypt before shipping to the browser — the DB stores envelope-encrypted
  // values (enc:v1:<base64>) since the credential encryption migration. The
  // form pre-fill needs plaintext; otherwise the admin clicking Save without
  // retyping POSTs ciphertext back, Meta rejects it as a malformed token
  // ("Cannot parse access token"), and the route would re-wrap it on write
  // → double-encryption. decryptSecret passes legacy plaintext rows through
  // unchanged, so this is safe for un-migrated data.
  //
  // Tolerate decrypt failure here (key rotated, value corrupt, wrong env):
  // surface it as an empty pre-fill so the admin can re-paste fresh
  // credentials instead of getting a blank-screen crash. The send path in
  // lib/providers/config.ts intentionally stays strict — there, a failed
  // decrypt should be loud, since silently sending nothing is worse.
  const accessToken = tryDecrypt(team?.metaAccessToken ?? null, "metaAccessToken");
  const appSecret = tryDecrypt(team?.metaAppSecret ?? null, "metaAppSecret");
  const credentialsUndecryptable =
    (team?.metaAccessToken != null && accessToken === null) ||
    (team?.metaAppSecret != null && appSecret === null);
  const current: WhatsappCurrent = {
    connected: Boolean(team?.metaPhoneNumberId),
    phoneNumberId: team?.metaPhoneNumberId ?? null,
    displayNumber: team?.metaDisplayPhoneNumber ?? null,
    wabaId: team?.metaWabaId ?? null,
    appId: team?.metaAppId ?? null,
    verifyToken: team?.metaVerifyToken ?? null,
    accessToken,
    appSecret,
    credentialsUndecryptable,
  };

  // Build the public origin from the proxy headers so the webhook URL the
  // admin sees matches what Meta will actually call (ngrok host in dev,
  // real domain in prod). Falls back to the host header when behind no proxy.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const webhookBaseUrl = `${proto}://${host}`;

  return (
    <WhatsappSettings
      current={current}
      webhookBaseUrl={webhookBaseUrl}
      teamId={teamId}
      canManage={canManageUsers(user.role)}
    />
  );
}

function tryDecrypt(value: string | null, field: string): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch (err) {
    // GCM auth-tag mismatch or malformed envelope. Most often: ENCRYPTION_KEY
    // changed between write and read (env rotated, different deploy, missing
    // var). The DB row is intact — only the key to read it is wrong.
    // Logged at warn (not error) because this is a *handled* condition: the
    // UI auto-opens the credentials form for re-entry. Next.js dev overlay
    // promotes console.error into the modal, which would scare the admin on
    // every page load until they re-paste.
    console.warn(
      `[settings/whatsapp] could not decrypt ${field} for team — admin needs to re-paste credentials. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
