import { getOrganizationOverview } from "@/lib/api/queries";

import { OrgMembersClient } from "./org-members-client";

/**
 * Admin settings — everyone in the organization, and which workspaces each
 * one can reach.
 *
 * The important distinction this page makes visible: a person belongs to ONE
 * organization, but holds a SEPARATE role in each workspace they're in. Someone
 * can be an admin of Support EU and an agent in Sales.
 */
export default async function OrganizationMembersPage() {
  const overview = await getOrganizationOverview();
  return <OrgMembersClient overview={overview} />;
}
