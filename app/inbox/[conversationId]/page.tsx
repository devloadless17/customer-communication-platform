import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  getConversationWithRefs,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
  listTeamMembers,
} from "@/lib/queries";
import { canManageContactFields, canManageStages } from "@/lib/auth/permissions";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactPanel } from "@/components/inbox/contact-panel";

interface Params {
  conversationId: string;
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { conversationId } = await params;
  const { teamId, user } = await getSession();

  const [page, teamMembers, fieldDefinitions, tags, stages] = await Promise.all([
    getConversationWithRefs(teamId, conversationId),
    listTeamMembers(teamId),
    listContactFieldDefinitions(teamId),
    listTags(teamId),
    listContactStages(teamId),
  ]);

  // Conversation may be missing because it was deleted (by this user, a
  // teammate, or via a contact delete) and the URL hasn't been navigated
  // away from. Redirect back to the inbox shell rather than showing a 404 —
  // the live socket path also does this, but a hard refresh / back-button
  // hit lands here on the server, so the bounce belongs here too.
  if (!page) redirect("/inbox");

  return (
    <>
      <MessageThread
        data={page.data}
        teamMembers={teamMembers}
        currentUser={user}
        nextOlderCursor={page.nextOlderCursor}
        stageCatalog={stages}
        canManageStages={canManageStages(user.role)}
      />
      <ContactPanel
        data={page.data}
        fieldDefinitions={fieldDefinitions}
        canManageFields={canManageContactFields(user.role)}
        tagCatalog={tags}
      />
    </>
  );
}
