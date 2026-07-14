import { getSession } from "@/lib/auth/current-user";
import { getTeamWebchatWidgets } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { WebchatWidgetSettings } from "./webchatwidget-settings";

export const metadata = { title: "Website chat · Settings" };
export const dynamic = "force-dynamic";

export default async function WebchatWidgetSettingsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);
  // GET /api/team/webchatwidget is @RequireRole("admin"); a non-admin 403s.
  const widgets = canManage ? await getTeamWebchatWidgets().catch(() => []) : [];
  // The widget origin (where widget.js is served from) = this app's public URL.
  const appOrigin = (process.env.APP_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  return <WebchatWidgetSettings widgets={widgets} canManage={canManage} appOrigin={appOrigin} />;
}
