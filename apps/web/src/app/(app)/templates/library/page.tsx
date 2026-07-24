import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listWhatsappTemplates } from "@/lib/api/queries";

import { TemplateLibraryBrowser } from "./library-browser";

export const metadata = { title: "Template library" };
export const dynamic = "force-dynamic";

/**
 * Meta's Template Library — pre-written, pre-categorized blueprints.
 *
 * Worth its own route rather than a tab inside the composer: an unmodified
 * instantiation skips review and comes back APPROVED immediately, which makes
 * this the FASTEST path to a sendable template and a different job from authoring
 * one. Retyping the same copy into the composer would go to review and could be
 * rejected.
 */
export default async function TemplateLibraryPage() {
  const { permissions } = await getSession();
  if (!permissions["templates:manage"]) redirect("/templates");

  // Same gate as the composer: the library is browsable only with credentials,
  // and instantiating needs a WABA to create into.
  const { connected, hasWabaId } = await listWhatsappTemplates();
  if (!connected) redirect("/settings/whatsapp?from=templates");
  if (!hasWabaId) redirect("/settings/whatsapp?from=templates&missing=waba");

  return <TemplateLibraryBrowser />;
}
