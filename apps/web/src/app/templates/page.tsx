import { listContactFieldDefinitions, listWhatsappTemplates } from "@/lib/api/queries";

import { TemplatesView } from "./templates-view";

/**
 * Templates index. Server component so the initial paint already has the
 * team's cached templates and the contact field schema (needed by the binding
 * editor inside the drawer). All further mutations go through API routes.
 */

export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const [templatesResp, fieldDefinitions] = await Promise.all([
    listWhatsappTemplates(),
    listContactFieldDefinitions(),
  ]);

  return (
    <TemplatesView
      initialTemplates={templatesResp.templates}
      fieldDefinitions={fieldDefinitions}
      connected={templatesResp.connected}
      hasWabaId={templatesResp.hasWabaId}
      hasAppId={templatesResp.hasAppId}
    />
  );
}
