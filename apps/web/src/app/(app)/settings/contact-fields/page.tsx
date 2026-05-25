import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listContactFieldsWithBuiltins } from "@/lib/api/queries";

import { ContactFieldsSettings } from "./contact-fields-settings";

export const metadata = { title: "Contact fields · Settings" };
export const dynamic = "force-dynamic";

export default async function ContactFieldsSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["contactFields:manage"]) {
    redirect("/settings/account");
  }

  const { definitions, builtins } = await listContactFieldsWithBuiltins();

  return (
    <ContactFieldsSettings
      initialDefinitions={definitions}
      initialBuiltins={builtins}
    />
  );
}
