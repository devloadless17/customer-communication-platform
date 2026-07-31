import { getSession } from "@/lib/auth/current-user";
import {
  getTeamMessengerConfig,
  listChannelAccounts,
  type ChannelAccountView,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { soft } from "@/lib/api/soft";

import { MessengerSettings, type MessengerCurrent } from "@/features/settings/components/messenger-settings";

export const metadata = {
  title: "Messenger · Settings",
};

export const dynamic = "force-dynamic";

export default async function MessengerSettingsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  // GET /api/workspace/messenger is @RequireRole("admin") — it decrypts secrets, so
  // a non-admin 403s. Only admins reach this page (nav is admin-gated), but
  // guard anyway with an empty read-only view.
  let current: MessengerCurrent;
  // Every connected account on this channel (admin-only endpoint). Degrades to
  // [] so a transient failure hides the panel rather than erroring the page.
  let accounts: ChannelAccountView[] = [];
  if (canManage) {
    const [config, accountRows] = await Promise.all([
      getTeamMessengerConfig(),
      soft("messenger accounts", [] as ChannelAccountView[], () => listChannelAccounts("messenger")),
    ]);
    accounts = accountRows;
    current = {
      connected: Boolean(config.pageId),
      pageId: config.pageId,
      pageName: config.pageName,
      appId: config.appId,
      verifyToken: config.verifyToken,
      pageAccessToken: config.pageAccessToken,
      appSecret: config.appSecret,
      credentialsUndecryptable: config.credentialsUndecryptable,
      needsReconnect: config.needsReconnect,
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

  return <MessengerSettings current={current} canManage={canManage} accounts={accounts} />;
}
