import { getSession } from "@/lib/auth/current-user";
import { getTeamMessengerConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { MessengerSettings, type MessengerCurrent } from "./messenger-settings";

export const metadata = {
  title: "Messenger · Settings",
};

export const dynamic = "force-dynamic";

export default async function MessengerSettingsPage() {
  const { user } = await getSession();
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
      webhookSubscription: config.webhookSubscription,
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

  return <MessengerSettings current={current} canManage={canManage} />;
}
