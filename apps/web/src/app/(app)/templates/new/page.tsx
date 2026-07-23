import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listWhatsappTemplates, listContactFieldDefinitions } from "@/lib/api/queries";

import { TemplateForm } from "./template-form";

export const metadata = { title: "New template" };
export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  const { permissions } = await getSession();
  if (!permissions["templates:manage"]) redirect("/templates");

  // Use the templates endpoint (open to any member) rather than the admin-only
  // GET /api/workspace/whatsapp — templates:manage grants access to non-admins too,
  // and it already returns the connected/hasWabaId/hasAppId flags we need here.
  const [{ connected, hasWabaId, hasAppId }, fieldDefinitions] = await Promise.all([
    listWhatsappTemplates(),
    listContactFieldDefinitions(),
  ]);

  if (!connected) {
    redirect("/settings/whatsapp?from=templates");
  }
  if (!hasWabaId) {
    redirect("/settings/whatsapp?from=templates&missing=waba");
  }

  return (
    <TemplateForm
      fieldDefinitions={fieldDefinitions}
      hasAppId={hasAppId}
    />
  );
}
