import { notFound } from "next/navigation";

import {
  getAudienceGroup,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
  lookupContacts,
} from "@/lib/api/queries";

import { GroupForm } from "@/features/audience-groups/components/group-form";

export const metadata = { title: "Edit audience group" };
export const dynamic = "force-dynamic";

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const group = await getAudienceGroup(id);
  if (!group) notFound();

  const [tags, fieldDefinitions, stages, contactLabels] = await Promise.all([
    listTags(),
    listContactFieldDefinitions(),
    listContactStages(),
    lookupContacts(group.contactIds),
  ]);

  return (
    <GroupForm
      initial={group}
      tags={tags}
      fieldDefinitions={fieldDefinitions}
      stages={stages}
      initialContactLabels={contactLabels}
    />
  );
}
