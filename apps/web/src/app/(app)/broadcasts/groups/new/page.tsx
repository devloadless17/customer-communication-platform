import { redirect } from "next/navigation";

import {
  getTeamWhatsappConfig,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
} from "@/lib/api/queries";

import { GroupForm } from "@/features/audience-groups/components/group-form";

export const metadata = { title: "New audience group" };
export const dynamic = "force-dynamic";

export default async function NewGroupPage() {
  const [config, tags, fieldDefinitions, stages] = await Promise.all([
    getTeamWhatsappConfig(),
    listTags(),
    listContactFieldDefinitions(),
    listContactStages(),
  ]);

  // Pre-flight: groups are only useful when WhatsApp is connected (you need
  // it to send the broadcast eventually). If not, bounce to settings.
  if (!config.phoneNumberId) {
    redirect("/settings/whatsapp?from=audience-groups");
  }

  return (
    <GroupForm tags={tags} fieldDefinitions={fieldDefinitions} stages={stages} />
  );
}
