import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import {
  getConversationWithRefs,
  listContactFieldDefinitions,
  listTags,
  listTeamMembers,
} from "@/lib/queries";
import { canManageContactFields } from "@/lib/permissions";
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

  const [page, teamMembers, fieldDefinitions, tags] = await Promise.all([
    getConversationWithRefs(teamId, conversationId),
    listTeamMembers(teamId),
    listContactFieldDefinitions(teamId),
    listTags(teamId),
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
