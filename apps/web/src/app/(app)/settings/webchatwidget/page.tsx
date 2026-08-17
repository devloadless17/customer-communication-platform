import { getSession } from "@/lib/auth/current-user";
import { getTeamWebchatWidgets, listContactFieldDefinitions } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { WebchatWidgetSettings } from "@/features/settings/components/webchatwidget-settings";

export const metadata = { title: "Website chat · Settings" };
export const dynamic = "force-dynamic";

export default async function WebchatWidgetSettingsPage() {
  const { user, permissions } = await getSession();
  const canManage = canManageUsers(user.role);
  // GET /api/workspace/webchatwidget is @RequireRole("admin"); a non-admin 403s.
  const widgets = canManage ? await getTeamWebchatWidgets().catch(() => []) : [];
  // The workspace's contact fields, so a pre-chat question binds to a REAL field
  // instead of minting one from its label. Readable by any signed-in session
  // (the contact panel reads the same schema), and `React.cache`d.
  const contactFields = canManage ? await listContactFieldDefinitions().catch(() => []) : [];
  // Creating a field from here is a contact-fields write, a capability distinct
  // from widget admin — without it the picker offers only existing fields.
  const canCreateFields = permissions["contactFields:manage"];
  // The widget origin (where widget.js is served from) = this app's public URL.
  const appOrigin = (process.env.APP_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  return (
    <WebchatWidgetSettings
      widgets={widgets}
      canManage={canManage}
      appOrigin={appOrigin}
      contactFields={contactFields}
      canCreateFields={canCreateFields}
    />
  );
}
