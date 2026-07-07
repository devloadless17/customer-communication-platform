import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { getTeamMessengerConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { MessengerSettings, type MessengerCurrent } from "./messenger-settings";

export const metadata = {
  title: "Messenger · Settings",
};

export const dynamic = "force-dynamic";

export default async function MessengerSettingsPage() {
  const { user, teamId } = await getSession();
  const canManage = canManageUsers(user.role);

  // GET /api/team/messenger is @RequireRole("admin") — it decrypts secrets, so
  // a non-admin 403s. Only admins reach this page (nav is admin-gated), but
  // guard anyway with an empty read-only view.
  let current: MessengerCurrent;
  if (canManage) {
    const config = await getTeamMessengerConfig();
    current = {
      connected: Boolean(config.pageId),
      pageId: config.pageId,
      pageName: config.pageName,
      appId: config.appId,
      verifyToken: config.verifyToken,
      pageAccessToken: config.pageAccessToken,
      appSecret: config.appSecret,
      credentialsUndecryptable: config.credentialsUndecryptable,
    };
  } else {
    current = {
      connected: false,
      pageId: null,
      pageName: null,
      appId: null,
      verifyToken: null,
      pageAccessToken: null,
      appSecret: null,
    };
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const webhookBaseUrl = `${proto}://${host}`;

  return (
    <MessengerSettings
      current={current}
      webhookBaseUrl={webhookBaseUrl}
      teamId={teamId}
      canManage={canManage}
    />
  );
}
