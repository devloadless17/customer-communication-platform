import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
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

  const current: WhatsappCurrent = {
    connected: Boolean(team?.metaPhoneNumberId),
    phoneNumberId: team?.metaPhoneNumberId ?? null,
    displayNumber: team?.metaDisplayPhoneNumber ?? null,
    wabaId: team?.metaWabaId ?? null,
    appId: team?.metaAppId ?? null,
    verifyToken: team?.metaVerifyToken ?? null,
    accessToken: team?.metaAccessToken ?? null,
    appSecret: team?.metaAppSecret ?? null,
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
