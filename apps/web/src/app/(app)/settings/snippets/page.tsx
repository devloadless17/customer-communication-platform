import { listContactFieldDefinitions, listSnippets } from "@/lib/api/queries";

import { SnippetsSettings } from "./snippets-settings";

export const metadata = { title: "Snippets · Settings" };
export const dynamic = "force-dynamic";

export default async function SnippetsSettingsPage() {
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
