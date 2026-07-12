import { getSession } from "@/lib/auth/current-user";
import { getTeamInstagramConfig } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { InstagramSettings, type InstagramCurrent } from "./instagram-settings";

export const metadata = {
  title: "Instagram · Settings",
};

export const dynamic = "force-dynamic";

export default async function InstagramSettingsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  let current: InstagramCurrent;
  if (canManage) {
    const config = await getTeamInstagramConfig();
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

  return <InstagramSettings current={current} canManage={canManage} />;
}
