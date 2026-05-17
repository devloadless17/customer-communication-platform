import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { getTeamWhatsappConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { WhatsappSettings, type WhatsappCurrent } from "./whatsapp-settings";

export const metadata = {
  title: "WhatsApp · Settings",
};

export const dynamic = "force-dynamic";

export default async function WhatsappSettingsPage() {
  const { user, teamId } = await getSession();

  // Encrypted Meta credentials are decrypted server-side by GET /api/team/whatsapp.
  // The endpoint absorbs decrypt failures (rotated key, corrupt envelope) and
  // returns null + a `credentialsUndecryptable` boolean so this page can prompt
  // the admin to re-paste instead of crashing. Crypto keys no longer live in
  // the web container — that's the security win of Step 7b for this page.
  const config = await getTeamWhatsappConfig();

  const current: WhatsappCurrent = {
    connected: Boolean(config.phoneNumberId),
    phoneNumberId: config.phoneNumberId,
    displayNumber: config.displayPhoneNumber,
    wabaId: config.wabaId,
    appId: config.appId,
    verifyToken: config.verifyToken,
    accessToken: config.accessToken,
    appSecret: config.appSecret,
    credentialsUndecryptable: config.credentialsUndecryptable,
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
