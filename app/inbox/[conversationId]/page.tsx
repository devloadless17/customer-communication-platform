import { notFound } from "next/navigation";

import { getSession } from "@/lib/current-user";
import {
  getConversationWithRefs,
  listContactFieldDefinitions,
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

  const [page, teamMembers, fieldDefinitions] = await Promise.all([
    getConversationWithRefs(teamId, conversationId),
    listTeamMembers(teamId),
    listContactFieldDefinitions(teamId),
  ]);

  if (!page) notFound();

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
      />
    </>
  );
}
