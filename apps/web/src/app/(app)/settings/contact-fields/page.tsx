import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageContactFields } from "@ccp/shared/auth/permissions";
import { listContactFieldDefinitions } from "@/lib/api/queries";

import { ContactFieldsSettings } from "./contact-fields-settings";

export const metadata = { title: "Contact fields · Settings" };
export const dynamic = "force-dynamic";

export default async function ContactFieldsSettingsPage() {
  const { user } = await getSession();
  if (!canManageContactFields(user.role)) {
    redirect("/settings/account");
  }

  const definitions = await listContactFieldDefinitions();

  return <ContactFieldsSettings initialDefinitions={definitions} />;
}
