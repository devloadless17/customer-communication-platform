import { redirect } from "next/navigation";

/**
 * Team activity moved to Reports → Team (2026-07-31): the settings table was a
 * thin subset of what /reports/team now answers (live strip, per-agent
 * conversations/messages/calls/tickets, drill-down), and Settings is for
 * configuration, not analytics. The route is kept as a redirect so old
 * bookmarks and muscle memory land in the right place — no permission check
 * here because /reports/team gates on the same `teamActivity:view` capability.
 */
export default function TeamActivityPage(): never {
  redirect("/reports/team");
}
