import { notFound } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { getConversationWithRefs, listTeamMembers } from "@/lib/queries";
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
  const { teamId } = await getSession();

  const [data, teamMembers] = await Promise.all([
    getConversationWithRefs(teamId, conversationId),
    listTeamMembers(teamId),
  ]);

  if (!data) notFound();

  return (
    <>
      <MessageThread data={data} teamMembers={teamMembers} />
      <ContactPanel data={data} />
    </>
  );
}
