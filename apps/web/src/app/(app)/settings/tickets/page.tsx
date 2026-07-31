import { getTicketSettings } from "@/lib/api/queries";

import { TicketSettingsClient } from "@/features/settings/components/ticket-settings-client";

export const metadata = {
  title: "Tickets · Settings",
};

/**
 * Ticketing configuration: when tickets open by themselves, how long a solved
 * one stays reopenable, and what each priority promises.
 *
 * Admin-gated at the API (`/api/workspace/tickets/*` is `@RequireRole("admin")`), so
 * a non-admin who reaches this URL gets the error boundary rather than a
 * half-rendered form — the same posture as the other admin settings pages.
 */
export default async function TicketSettingsPage() {
  const { settings, policies, fields } = await getTicketSettings();
  return <TicketSettingsClient settings={settings} policies={policies} fields={fields} />;
}
