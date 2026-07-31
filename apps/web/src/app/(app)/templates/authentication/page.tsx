import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listWhatsappTemplates } from "@/lib/api/queries";

import { AuthTemplateForm } from "@/features/templates/components/auth-template-form";

export const metadata = { title: "Authentication template" };
export const dynamic = "force-dynamic";

/**
 * Authentication templates get their own flow, not the composer.
 *
 * Their body is fixed preset text Meta owns, so there is nothing to write — you
 * pick the optional strings, the OTP button and the languages, and Meta
 * generates the wording. A composer would present an editor for copy that cannot
 * be edited.
 */
export default async function AuthTemplatePage() {
  const { permissions } = await getSession();
  if (!permissions["templates:manage"]) redirect("/templates");

  const { connected, hasWabaId } = await listWhatsappTemplates();
  if (!connected) redirect("/settings/whatsapp?from=templates");
  if (!hasWabaId) redirect("/settings/whatsapp?from=templates&missing=waba");

  return <AuthTemplateForm />;
}
