import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listContactFieldDefinitions } from "@/lib/queries";

import { TemplateForm } from "./template-form";

export const metadata = { title: "New template" };
export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  const { teamId } = await getSession();

  const [team, fieldDefinitions] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: {
        metaPhoneNumberId: true,
        metaWabaId: true,
        metaAppId: true,
      },
    }),
    listContactFieldDefinitions(teamId),
  ]);

  if (!team?.metaPhoneNumberId) {
    redirect("/settings/whatsapp?from=templates");
  }
  if (!team?.metaWabaId) {
    redirect("/settings/whatsapp?from=templates&missing=waba");
  }

  return (
    <TemplateForm
      fieldDefinitions={fieldDefinitions}
      hasAppId={Boolean(team.metaAppId)}
    />
  );
}
