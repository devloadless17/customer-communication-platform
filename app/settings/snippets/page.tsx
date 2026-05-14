import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listContactFieldDefinitions } from "@/lib/queries";

import { SnippetsSettings } from "./snippets-settings";

export const metadata = { title: "Snippets · Settings" };
export const dynamic = "force-dynamic";

export default async function SnippetsSettingsPage() {
  const { teamId } = await getSession();
  const [rows, fieldDefinitions] = await Promise.all([
    db.snippet.findMany({
      where: { teamId },
      orderBy: [{ label: "asc" }],
      include: { createdBy: { select: { id: true, name: true } } },
    }),
    listContactFieldDefinitions(teamId),
  ]);

  return (
    <SnippetsSettings
      initialSnippets={rows.map((r) => ({
        id: r.id,
        name: r.name,
        label: r.label,
        body: r.body,
        createdById: r.createdById,
        createdByName: r.createdBy.name,
        updatedAt: r.updatedAt.toISOString(),
      }))}
      fieldDefinitions={fieldDefinitions}
    />
  );
}
