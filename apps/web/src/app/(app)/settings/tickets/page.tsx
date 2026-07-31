import { redirect } from "next/navigation";

import { getTicketSettings } from "@/lib/api/queries";
import { getSession } from "@/lib/auth/current-user";

import { TicketSettingsClient } from "@/features/settings/components/ticket-settings-client";

export const metadata = {
  title: "Tickets · Settings",
};

/**
 * Ticketing configuration: when tickets open by themselves, how long a solved
 * one stays reopenable, and what each priority promises.
 *
 * Admin-gated at the API (`/api/workspace/tickets/*` is `@RequireRole("admin")`).
 * Checked HERE too, and redirected rather than left to 403 into the error
 * boundary: that is what the sibling settings pages do (tags, stages,
 * contact-fields all `redirect("/account")`), and an agent following the link
 * the tickets sidebar used to show them got a crash page instead of an answer.
 */
export default async function TicketSettingsPage() {
  const { user } = await getSession();
  if (user.role !== "admin") redirect("/tickets");
  const { settings, policies, fields } = await getTicketSettings();
  return <TicketSettingsClient settings={settings} policies={policies} fields={fields} />;
}
