import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listContactFieldDefinitions, listTags } from "@/lib/queries";

import { GroupForm } from "@/components/audience-groups/group-form";

export const metadata = { title: "New audience group" };
export const dynamic = "force-dynamic";

export default async function NewGroupPage() {
  const { teamId } = await getSession();

  const [team, tags, fieldDefinitions] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { metaPhoneNumberId: true },
    }),
    listTags(teamId),
    listContactFieldDefinitions(teamId),
  ]);

  // Pre-flight: groups are only useful when WhatsApp is connected (you need
  // it to send the broadcast eventually). If not, bounce to settings.
  if (!team?.metaPhoneNumberId) {
    redirect("/settings/whatsapp?from=audience-groups");
  }

  return <GroupForm tags={tags} fieldDefinitions={fieldDefinitions} />;
}
