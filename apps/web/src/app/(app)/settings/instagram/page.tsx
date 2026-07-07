import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { getTeamInstagramConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { InstagramSettings, type InstagramCurrent } from "./instagram-settings";

export const metadata = {
  title: "Instagram · Settings",
};

export const dynamic = "force-dynamic";

export default async function InstagramSettingsPage() {
  const { user, teamId } = await getSession();
  const canManage = canManageUsers(user.role);

  let current: InstagramCurrent;
  if (canManage) {
    const config = await getTeamInstagramConfig();
    current = {
      connected: Boolean(config.igId),
      igId: config.igId,
      igUsername: config.igUsername,
      appId: config.appId,
      verifyToken: config.verifyToken,
      igAccessToken: config.igAccessToken,
      appSecret: config.appSecret,
      credentialsUndecryptable: config.credentialsUndecryptable,
    };
  } else {
    current = {
      connected: false,
      igId: null,
      igUsername: null,
      appId: null,
      verifyToken: null,
      igAccessToken: null,
      appSecret: null,
    };
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const webhookBaseUrl = `${proto}://${host}`;

  return (
    <InstagramSettings
      current={current}
      webhookBaseUrl={webhookBaseUrl}
      teamId={teamId}
      canManage={canManage}
    />
  );
}
