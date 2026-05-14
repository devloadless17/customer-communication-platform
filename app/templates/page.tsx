import { Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listContactFieldDefinitions } from "@/lib/queries";
import type { TemplateDto } from "@/lib/types";
import type { TemplateComponent } from "@/lib/providers/types";

import { TemplatesView } from "./templates-view";

/**
 * Templates index. Server component so the initial paint already has the
 * team's cached templates and the contact field schema (needed by the binding
 * editor inside the drawer). All further mutations go through API routes.
 */

export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const { teamId } = await getSession();

  const [rows, team, fieldDefinitions] = await Promise.all([
    db.messageTemplate.findMany({
      where: { teamId },
      orderBy: [{ status: "asc" }, { name: "asc" }, { language: "asc" }],
    }),
    db.team.findUnique({
      where: { id: teamId },
      select: { metaWabaId: true, metaPhoneNumberId: true, metaAppId: true },
    }),
    listContactFieldDefinitions(teamId),
  ]);

  return (
    <TemplatesView
      initialTemplates={rows.map(toDto)}
      fieldDefinitions={fieldDefinitions}
      connected={Boolean(team?.metaPhoneNumberId)}
      hasWabaId={Boolean(team?.metaWabaId)}
      hasAppId={Boolean(team?.metaAppId)}
    />
  );
}

function toDto(row: {
  id: string;
  externalId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  components: Prisma.JsonValue;
  variableBindings: Prisma.JsonValue;
  syncedAt: Date;
}): TemplateDto {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    bodyText: row.bodyText,
    components: Array.isArray(row.components)
      ? (row.components as unknown as TemplateComponent[])
      : [],
    variableBindings: row.variableBindings ?? {},
    syncedAt: row.syncedAt.toISOString(),
  };
}
