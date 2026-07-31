import { getOrganizationOverview } from "@/lib/api/queries";

import { AccountInfoClient } from "@/features/organization/components/account-info-client";

export const metadata = {
  title: "Organization",
};

/**
 * Account info — who the organization is.
 *
 * Readable by every member (the org's own name is not a secret); the rename
 * is gated on `orgRole` server-side, and `canManage` mirrors that so the field
 * renders read-only rather than offering a button the API will refuse.
 */
export default async function OrganizationAccountInfoPage() {
  const overview = await getOrganizationOverview();
  return <AccountInfoClient overview={overview} />;
}
