import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { getTeamMetaConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { MetaSettings, type MetaCurrent } from "./meta-settings";

export const metadata = {
  title: "Meta App · Settings",
};

export const dynamic = "force-dynamic";

export default async function MetaSettingsPage() {
  const { user, teamId } = await getSession();
  const canManage = canManageUsers(user.role);

  let current: MetaCurrent;
  if (canManage) {
    const config = await getTeamMetaConfig();
    current = {
      connected: Boolean(config.appSecret && config.systemUserToken),
      appId: config.appId,
      verifyToken: config.verifyToken,
      appSecret: config.appSecret,
      systemUserToken: config.systemUserToken,
      credentialsUndecryptable: config.credentialsUndecryptable,
    };
  } else {
    current = {
      connected: false,
      appId: null,
      verifyToken: null,
      appSecret: null,
      systemUserToken: null,
    };
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const webhookBaseUrl = `${proto}://${host}`;

  return (
    <MetaSettings
      current={current}
      webhookBaseUrl={webhookBaseUrl}
      teamId={teamId}
      canManage={canManage}
    />
  );
}
