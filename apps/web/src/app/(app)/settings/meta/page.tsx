import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import { getTeamMetaConfig, listChannelAccounts, type ChannelAccountView } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { soft } from "@/lib/api/soft";
import { MetaAppAccounts } from "@/features/channels/components/meta-app-accounts";

import { MetaSettings, type MetaCurrent } from "./meta-settings";

export const metadata = {
  title: "Meta App · Settings",
};

export const dynamic = "force-dynamic";

export default async function MetaSettingsPage() {
  const { user, workspaceId } = await getSession();
  const canManage = canManageUsers(user.role);

  let current: MetaCurrent;
  // Every Meta-backed account, so the page can state which ones this app actually
  // serves. Each channel degrades independently — one unreachable channel must not
  // blank the panel or the credentials form above it.
  let metaAccounts: ChannelAccountView[] = [];
  if (canManage) {
    // One fan-out: the credentials config and the three per-channel account
    // lists have no data dependency, so awaiting the config first only added
    // a serial round-trip before the accounts could start.
    const [config, wa, msgr, ig] = await Promise.all([
      getTeamMetaConfig(),
      soft("whatsapp accounts", [], () => listChannelAccounts("whatsapp")),
      soft("messenger accounts", [], () => listChannelAccounts("messenger")),
      soft("instagram accounts", [], () => listChannelAccounts("instagram")),
    ]);
    current = {
      connected: Boolean(config.appSecret && config.systemUserToken),
      appId: config.appId,
      verifyToken: config.verifyToken,
      appSecret: config.appSecret,
      systemUserToken: config.systemUserToken,
      credentialsUndecryptable: config.credentialsUndecryptable,
    };
    metaAccounts = [...wa, ...msgr, ...ig];
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
    <div className="flex flex-col gap-6">
      <MetaSettings
        current={current}
        webhookBaseUrl={webhookBaseUrl}
        workspaceId={workspaceId}
        canManage={canManage}
      />
      {canManage && (
        <MetaAppAccounts accounts={metaAccounts} hasSharedApp={current.connected} />
      )}
    </div>
  );
}
