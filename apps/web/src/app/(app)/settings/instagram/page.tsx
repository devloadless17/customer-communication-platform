import { getSession } from "@/lib/auth/current-user";
import {
  getTeamInstagramConfig,
  listChannelAccountDirectory,
  listChannelAccounts,
  type ChannelAccountDirectoryEntry,
  type ChannelAccountView,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { soft } from "@/lib/api/soft";

import { InstagramSettings, type InstagramCurrent } from "@/features/settings/components/instagram-settings";

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
      inboxSources: config.inboxSources,
      availableInboxSources: config.availableInboxSources,
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
      webhookRejection: config.webhookRejection,
      webhookSubscription: config.webhookSubscription,
    };
  } else {
    // Whether the channel is CONNECTED is not a credential, and hardcoding
    // `false` told an agent the account was disconnected while their inbox was
    // taking DMs on it. The member-open account directory answers it without
    // decrypting anything; the handle and ids below stay withheld, because the
    // directory's display name may be an admin's label rather than the @handle.
    const directory = await soft(
      "channel-account directory",
      [] as ChannelAccountDirectoryEntry[],
      () => listChannelAccountDirectory(),
    );
    current = {
      connected: directory.some((a) => a.channel === "instagram"),
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
