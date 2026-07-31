import { redirect } from "next/navigation";

import { canManageUsers } from "@ccp/shared/auth/permissions";
import { getSession } from "@/lib/auth/current-user";

import { PermissionsSettings } from "@/features/settings/components/permissions-settings";

export const metadata = { title: "Role permissions · Settings" };
export const dynamic = "force-dynamic";

/**
 * Per-role capability matrix. Admins (and superAdmins) decide which actions
 * managers / agents can take. admin/superAdmin always have every capability —
 * the org owner can't lock themselves out — so only the two editable rows
 * render as toggles here.
 *
 * Defaults reproduce pre-feature behavior: every capability starts ON for both
 * roles except stages/contact-fields management, which stays manager-and-up.
 * The real enforcement is server-side (NestJS capability guard); this page is
 * just where the admin flips the switches.
 */
export default async function PermissionsSettingsPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) redirect("/settings/members");

  return <PermissionsSettings />;
}
