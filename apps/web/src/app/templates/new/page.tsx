import { redirect } from "next/navigation";

import { getTeamWhatsappConfig, listContactFieldDefinitions } from "@/lib/api/queries";

import { TemplateForm } from "./template-form";

export const metadata = { title: "New template" };
export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  const [config, fieldDefinitions] = await Promise.all([
    getTeamWhatsappConfig(),
    listContactFieldDefinitions(),
  ]);

  if (!config.phoneNumberId) {
    redirect("/settings/whatsapp?from=templates");
  }
  if (!config.wabaId) {
    redirect("/settings/whatsapp?from=templates&missing=waba");
  }

  return (
    <TemplateForm
      fieldDefinitions={fieldDefinitions}
      hasAppId={Boolean(config.appId)}
    />
  );
}
