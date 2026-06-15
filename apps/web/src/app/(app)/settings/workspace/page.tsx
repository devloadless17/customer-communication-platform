import { redirect } from "next/navigation";

/**
 * The old "Account settings" landing was merged into the single grouped
 * /settings page (see settings/page.tsx). Kept as a permanent redirect so any
 * bookmark / external link to the old path still lands somewhere sensible.
 */
export default function WorkspaceSettingsRedirect() {
  redirect("/settings");
}
