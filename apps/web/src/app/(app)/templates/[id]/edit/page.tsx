import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listWhatsappTemplates, listContactFieldDefinitions } from "@/lib/api/queries";
import type { TemplateComponent } from "@ccp/shared/providers/types";

import { TemplateForm } from "@/features/templates/components/template-form";

export const metadata = { title: "Edit template" };
export const dynamic = "force-dynamic";

/** Meta allows edits only from these three states. */
const EDITABLE = new Set(["approved", "rejected", "paused"]);

/**
 * Edit an existing template in place.
 *
 * Reuses the composer rather than duplicating it: the component builder, the
 * shared validator, the example editor and the live preview are all the same
 * rules, and a second implementation would be the thing that drifts.
 */
export default async function EditTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ accountId?: string }>;
}) {
  const { id } = await params;
  // The list page stamps its current account scope onto the Edit link, so the
  // connection hints below describe the number whose template this is.
  const { accountId } = await searchParams;
  const { permissions } = await getSession();
  if (!permissions["templates:manage"]) redirect("/templates");

  const [{ templates, connected, hasWabaId, hasAppId }, fieldDefinitions] =
    await Promise.all([
      listWhatsappTemplates(accountId ?? null),
      listContactFieldDefinitions(),
    ]);

  if (!connected) redirect("/settings/whatsapp?from=templates");
  if (!hasWabaId) redirect("/settings/whatsapp?from=templates&missing=waba");

  const template = templates.find((t) => t.id === id);
  if (!template) notFound();
  // Bounce rather than render a form whose submit is guaranteed to 409.
  if (!EDITABLE.has(template.status)) redirect("/templates");

  return (
    <TemplateForm
      fieldDefinitions={fieldDefinitions}
      hasAppId={hasAppId}
      editing={{
        id: template.id,
        name: template.name,
        language: template.language,
        category: template.category as "marketing" | "utility" | "authentication",
        status: template.status,
        parameterFormat: template.parameterFormat,
        components: (Array.isArray(template.components)
          ? template.components
          : []) as TemplateComponent[],
        messageSendTtlSeconds: template.messageSendTtlSeconds,
        libraryTemplateName: template.libraryTemplateName,
      }}
    />
  );
}
