import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  listContactFieldDefinitions,
  listContactStages,
  listTags,
} from "@/lib/api/queries";

import { GroupForm } from "@/features/audience-groups/components/group-form";

export const metadata = { title: "New audience group" };
export const dynamic = "force-dynamic";

export default async function NewGroupPage() {
  const { permissions } = await getSession();
  if (!permissions["audienceGroups:manage"]) redirect("/broadcasts/groups");

  const [tags, fieldDefinitions, stages] = await Promise.all([
    listTags(),
    listContactFieldDefinitions(),
    listContactStages(),
  ]);
  // No channel pre-flight: audience groups are channel-agnostic saved contact
  // lists. The old gate required WHATSAPP specifically, so a Messenger-only
  // team clicking "New group" was bounced to WhatsApp settings. The composer
  // is where channel readiness is actually decided.

  return (
    <GroupForm tags={tags} fieldDefinitions={fieldDefinitions} stages={stages} />
  );
}
