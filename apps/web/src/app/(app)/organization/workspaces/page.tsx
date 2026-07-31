import { getOrganizationOverview } from "@/lib/api/queries";

import { WorkspacesClient } from "@/features/organization/components/workspaces-client";

export const metadata = {
  title: "Workspaces · Organization",
};

/**
 * The organization's workspaces.
 *
 * Each one is a fully separate inbox — its own channels, contacts,
 * conversations and settings. Nothing is shared between them except the people
 * put in both.
 */
export default async function OrganizationWorkspacesPage() {
  const overview = await getOrganizationOverview();
  return <WorkspacesClient overview={overview} />;
}
