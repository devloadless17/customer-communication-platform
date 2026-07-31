import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listContactFieldDefinitions, listSnippets } from "@/lib/api/queries";

import { SnippetsSettings } from "@/features/settings/components/snippets-settings";

export const metadata = { title: "Snippets · Settings" };
export const dynamic = "force-dynamic";

/**
 * Snippet (canned-reply) manager. Gated by the admin-configurable
 * `snippets:manage` capability (default true for manager + agent — unchanged
 * until an admin restricts it). Mirrors the stages / contact-fields / tags
 * settings pages. Redirect to /account when gated.
 */
export default async function SnippetsSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["snippets:manage"]) {
    redirect("/account");
  }

  const [snippets, fieldDefinitions] = await Promise.all([
    listSnippets(),
    listContactFieldDefinitions(),
  ]);

  return (
    <SnippetsSettings
      initialSnippets={snippets}
      fieldDefinitions={fieldDefinitions}
    />
  );
}
