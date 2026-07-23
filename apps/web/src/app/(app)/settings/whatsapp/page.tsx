import { getSession } from "@/lib/auth/current-user";
import {
  getTeamWhatsappConfig,
  listChannelAccounts,
  listWhatsappTemplates,
  type ChannelAccountView,
} from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { ChannelAccountsPanel } from "@/features/channels/components/channel-accounts-panel";
import { WhatsappSettings, type WhatsappCurrent } from "./whatsapp-settings";

export const metadata = {
  title: "WhatsApp · Settings",
};

export const dynamic = "force-dynamic";

export default async function WhatsappSettingsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);

  // GET /api/workspace/whatsapp is @RequireRole("admin") — it decrypts secrets, so a
  // non-admin hitting it 403s straight to the error boundary. Non-admins are
  // linked here from the /templates banners, so give them the read-only summary
  // instead: the members-open templates endpoint exposes only the `connected`
  // flag (no secrets), which feeds the component's `!canManage` branch.
  let current: WhatsappCurrent;
  // Connected accounts (admin-only endpoint). The panel renders itself away
  // when there's one account, so a single-number workspace is unchanged.
  let accounts: ChannelAccountView[] = [];
  if (canManage) {
    // Encrypted Meta credentials are decrypted server-side by GET /api/workspace/whatsapp.
    // The endpoint absorbs decrypt failures (rotated key, corrupt envelope) and
    // returns null + a `credentialsUndecryptable` boolean so this page can prompt
    // the admin to re-paste instead of crashing. Crypto keys no longer live in
    // the web container — that's the security win of Step 7b for this page.
    const [config, accountRows] = await Promise.all([
      getTeamWhatsappConfig(),
      listChannelAccounts("whatsapp").catch(() => [] as ChannelAccountView[]),
    ]);
    accounts = accountRows;
    current = {
      connected: Boolean(config.phoneNumberId),
      phoneNumberId: config.phoneNumberId,
      displayNumber: config.displayPhoneNumber,
      wabaId: config.wabaId,
      appId: config.appId,
      verifyToken: config.verifyToken,
      accessToken: config.accessToken,
      appSecret: config.appSecret,
      credentialsUndecryptable: config.credentialsUndecryptable,
      needsReconnect: config.needsReconnect,
      messagingTier: config.messagingTier,
      messagingDailyCap: config.messagingDailyCap,
      qualityRating: config.qualityRating,
      throughputLevel: config.throughputLevel,
    };
  } else {
    const { connected } = await listWhatsappTemplates();
    current = {
      connected,
      phoneNumberId: null,
      displayNumber: null,
      wabaId: null,
      appId: null,
      verifyToken: null,
      accessToken: null,
      appSecret: null,
    };
  }

  return (
    <>
      <WhatsappSettings current={current} canManage={canManage} />
      <ChannelAccountsPanel channel="whatsapp" accounts={accounts} channelLabel="WhatsApp" />
    </>
  );
}
