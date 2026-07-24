import { getSession } from "@/lib/auth/current-user";
import {
  getTeamInstagramConfig,
  listChannelAccounts,
  type ChannelAccountView,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { soft } from "@/lib/api/soft";

import { InstagramSettings, type InstagramCurrent } from "./instagram-settings";

export const metadata = {
  title: "Instagram · Settings",
};

export const dynamic = "force-dynamic";

export default async function InstagramSettingsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  let current: InstagramCurrent;
  // Every connected account on this channel (admin-only endpoint). Degrades to
  // [] so a transient failure hides the panel rather than erroring the page.
  let accounts: ChannelAccountView[] = [];
  if (canManage) {
    const [config, accountRows] = await Promise.all([
      getTeamInstagramConfig(),
      soft("instagram accounts", [] as ChannelAccountView[], () => listChannelAccounts("instagram")),
    ]);
    accounts = accountRows;
    current = {
      connected: Boolean(config.igId),
      igId: config.igId,
      igUsername: config.igUsername,
      pageId: config.pageId,
      pageName: config.pageName,
      appId: config.appId,
      verifyToken: config.verifyToken,
      igAccessToken: config.igAccessToken,
      appSecret: config.appSecret,
      credentialsUndecryptable: config.credentialsUndecryptable,
      needsReconnect: config.needsReconnect,
      webhookSubscription: config.webhookSubscription,
    };
  } else {
    current = {
      connected: false,
      igId: null,
      igUsername: null,
      pageId: null,
      pageName: null,
      appId: null,
      verifyToken: null,
      igAccessToken: null,
      appSecret: null,
    };
  }

  return <InstagramSettings current={current} canManage={canManage} accounts={accounts} />;
}
