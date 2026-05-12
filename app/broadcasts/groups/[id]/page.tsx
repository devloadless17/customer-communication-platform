import { notFound } from "next/navigation";

import { getSession } from "@/lib/current-user";
import {
  getAudienceGroup,
  listContactFieldDefinitions,
  listTags,
  lookupContacts,
} from "@/lib/queries";

import { GroupForm } from "@/components/audience-groups/group-form";

export const metadata = { title: "Edit audience group" };
export const dynamic = "force-dynamic";

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { teamId } = await getSession();
  const { id } = await params;

  const group = await getAudienceGroup(teamId, id);
  if (!group) notFound();

  const [tags, fieldDefinitions, contactLabels] = await Promise.all([
    listTags(teamId),
    listContactFieldDefinitions(teamId),
    lookupContacts(teamId, group.contactIds),
  ]);

  return (
    <GroupForm
      initial={group}
      tags={tags}
      fieldDefinitions={fieldDefinitions}
      initialContactLabels={contactLabels}
    />
  );
}
